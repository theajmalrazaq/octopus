// All durable state lives in one SQLite database (data/agent.db), via the
// built-in node:sqlite — no native dependencies. Tables:
//   kv         — small JSON values (owner LID, meetup state, runtime overrides)
//   reminders  — per-chat reminders (seq is the per-chat number users see)
//   history    — per-chat conversation memory for the LLM (last 12 turns)
//   contacts   — display names by phone number and by LID
//   groups     — cached group context (name, description, members)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
import type { AgentConfig, GroupInfo, HistoryEntry, MeetupState, Reminder } from './types.js';

mkdirSync(join(ROOT, 'data'), { recursive: true });
const db = new DatabaseSync(join(ROOT, 'data', 'agent.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS reminders (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL, seq INTEGER NOT NULL,
    text TEXT NOT NULL, due_at INTEGER NOT NULL,
    repeat TEXT, created_by TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_jid ON reminders(jid);
  CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at);
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_jid ON history(jid, id);
  CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS groups (jid TEXT PRIMARY KEY, data TEXT NOT NULL);
`);

// ---------- kv ----------
export function getKv<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined;
  if (!row) return fallback;
  try { return JSON.parse(row.v) as T; } catch { return fallback; }
}
export function setKv(key: string, value: unknown): void {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(key, JSON.stringify(value));
}

// ---------- owner identity ----------
export function getOwnerLid(): string {
  return getKv<string>('ownerLid', '');
}
export function setOwnerLid(lid: string): void {
  setKv('ownerLid', lid);
}

// ---------- meetup ----------
const MEETUP_DEFAULT: MeetupState = { date: '', asked: false, status: 'idle', missedPosted: false };
export function getMeetupState(): MeetupState {
  return { ...MEETUP_DEFAULT, ...getKv<Partial<MeetupState>>('meetupState', {}) };
}
export function setMeetupState(st: MeetupState): void {
  setKv('meetupState', st);
}
/** The meetup group: the in-chat "setup meetup here" override wins over config. */
export function getMeetupGroupJid(cfg: AgentConfig): string {
  return getKv<string>('meetupGroupJid', '') || cfg.meetup.groupJid || '';
}
export function setMeetupGroupJid(jid: string): void {
  setKv('meetupGroupJid', jid);
}
export function getMeetupTimes(cfg: AgentConfig): { askTime: string; cutoffTime: string } {
  return {
    askTime: getKv<string>('meetupAskTime', '') || cfg.meetup.askTime,
    cutoffTime: getKv<string>('meetupCutoffTime', '') || cfg.meetup.cutoffTime,
  };
}
export function setMeetupTimes(askTime: string, cutoffTime: string): void {
  setKv('meetupAskTime', askTime);
  setKv('meetupCutoffTime', cutoffTime);
}

// ---------- reminders ----------
interface ReminderRow {
  rowid: number; seq: number; jid: string; text: string;
  due_at: number; repeat: string | null; created_by: string;
}
function toReminder(r: ReminderRow): Reminder {
  return {
    rowid: r.rowid, seq: r.seq, jid: r.jid, text: r.text, dueAt: r.due_at,
    repeat: r.repeat === 'daily' || r.repeat === 'weekly' ? r.repeat : null,
    createdBy: r.created_by,
  };
}
export function listReminders(jid: string): Reminder[] {
  const rows = db.prepare('SELECT * FROM reminders WHERE jid = ? ORDER BY due_at ASC').all(jid) as unknown as ReminderRow[];
  return rows.map(toReminder);
}
export function addReminder(jid: string, text: string, dueAt: number, repeat: 'daily' | 'weekly' | null, createdBy: string): Reminder {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM reminders WHERE jid = ?').get(jid) as { m: number };
  const seq = row.m + 1;
  const info = db.prepare('INSERT INTO reminders (jid, seq, text, due_at, repeat, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(jid, seq, text, dueAt, repeat, createdBy);
  return { rowid: Number(info.lastInsertRowid), seq, jid, text, dueAt, repeat, createdBy };
}
export function updateReminder(jid: string, seq: number, patch: { text?: string; dueAt?: number }): Reminder | null {
  const cur = db.prepare('SELECT * FROM reminders WHERE jid = ? AND seq = ?').get(jid, seq) as unknown as ReminderRow | undefined;
  if (!cur) return null;
  db.prepare('UPDATE reminders SET text = ?, due_at = ? WHERE rowid = ?')
    .run(patch.text ?? cur.text, patch.dueAt ?? cur.due_at, cur.rowid);
  return toReminder({ ...cur, text: patch.text ?? cur.text, due_at: patch.dueAt ?? cur.due_at });
}
export function deleteReminder(jid: string, seq: number): Reminder | null {
  const cur = db.prepare('SELECT * FROM reminders WHERE jid = ? AND seq = ?').get(jid, seq) as unknown as ReminderRow | undefined;
  if (!cur) return null;
  db.prepare('DELETE FROM reminders WHERE rowid = ?').run(cur.rowid);
  return toReminder(cur);
}
export function dueReminders(now: number): Reminder[] {
  const rows = db.prepare('SELECT * FROM reminders WHERE due_at <= ? ORDER BY due_at ASC').all(now) as unknown as ReminderRow[];
  return rows.map(toReminder);
}
export function rescheduleReminder(rowid: number, dueAt: number): void {
  db.prepare('UPDATE reminders SET due_at = ? WHERE rowid = ?').run(dueAt, rowid);
}
export function removeReminder(rowid: number): void {
  db.prepare('DELETE FROM reminders WHERE rowid = ?').run(rowid);
}

// ---------- history ----------
export function getHistory(jid: string, limit = 12): HistoryEntry[] {
  const rows = db.prepare('SELECT role, content FROM history WHERE jid = ? ORDER BY id DESC LIMIT ?')
    .all(jid, limit) as unknown as { role: 'user' | 'assistant'; content: string }[];
  return rows.reverse();
}
export function pushHistory(jid: string, role: 'user' | 'assistant', content: string): void {
  db.prepare('INSERT INTO history (jid, role, content, ts) VALUES (?, ?, ?, ?)').run(jid, role, content, Date.now());
  // Keep only the most recent 24 turns per chat.
  db.prepare(`DELETE FROM history WHERE jid = ? AND id NOT IN
    (SELECT id FROM history WHERE jid = ? ORDER BY id DESC LIMIT 24)`).run(jid, jid);
}

// ---------- contacts ----------
export function getContact(id: string): string {
  if (!id) return '';
  const row = db.prepare('SELECT name FROM contacts WHERE id = ?').get(id) as { name: string } | undefined;
  return row?.name || '';
}
export function setContact(id: string, name: string): void {
  if (!id || !name) return;
  db.prepare('INSERT INTO contacts (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name').run(id, name);
}
export function contactCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number };
  return row.n;
}

// ---------- groups ----------
export function getGroup(jid: string): GroupInfo | null {
  const row = db.prepare('SELECT data FROM groups WHERE jid = ?').get(jid) as { data: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.data) as GroupInfo; } catch { return null; }
}
export function setGroup(jid: string, info: GroupInfo): void {
  db.prepare('INSERT INTO groups (jid, data) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET data = excluded.data')
    .run(jid, JSON.stringify(info));
}
export function allGroups(): GroupInfo[] {
  const rows = db.prepare('SELECT data FROM groups').all() as unknown as { data: string }[];
  return rows.map((r) => { try { return JSON.parse(r.data) as GroupInfo; } catch { return null; } }).filter(Boolean) as GroupInfo[];
}
