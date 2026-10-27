// All durable state lives in one SQLite database (data/agent.db), via the
// built-in node:sqlite — no native dependencies. Tables:
//   kv         — small JSON values (owner LID, meetup state, runtime overrides)
//   reminders  — per-chat reminders (seq is the per-chat number users see)
//   history    — per-chat conversation memory for the LLM (last 12 turns)
//   contacts   — display names by phone number and by LID
//   groups     — cached group context (name, description, members)
//   sent_log   — the agent's verifiable outbox (messages it actually sent)
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
  CREATE TABLE IF NOT EXISTS sent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
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

// Older databases (pre mention support) get the column added in place.
{
  const cols = db.prepare('PRAGMA table_info(reminders)').all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === 'mention_jid')) {
    db.exec('ALTER TABLE reminders ADD COLUMN mention_jid TEXT');
  }
}

// ---------- reminders ----------
interface ReminderRow {
  rowid: number; seq: number; jid: string; text: string;
  due_at: number; repeat: string | null; created_by: string;
  mention_jid: string | null;
}
function toReminder(r: ReminderRow): Reminder {
  return {
    rowid: r.rowid, seq: r.seq, jid: r.jid, text: r.text, dueAt: r.due_at,
    repeat: r.repeat === 'daily' || r.repeat === 'weekly' ? r.repeat : null,
    createdBy: r.created_by,
    mentionJid: r.mention_jid || null,
  };
}
export function listReminders(jid: string): Reminder[] {
  const rows = db.prepare('SELECT * FROM reminders WHERE jid = ? ORDER BY due_at ASC').all(jid) as unknown as ReminderRow[];
  return rows.map(toReminder);
}
export function addReminder(jid: string, text: string, dueAt: number, repeat: 'daily' | 'weekly' | null, createdBy: string, mentionJid: string | null = null): Reminder {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM reminders WHERE jid = ?').get(jid) as { m: number };
  return addReminderWithSeq(jid, row.m + 1, text, dueAt, repeat, createdBy, mentionJid);
}
export function addReminderWithSeq(jid: string, seq: number, text: string, dueAt: number, repeat: 'daily' | 'weekly' | null, createdBy: string, mentionJid: string | null = null): Reminder {
  const info = db.prepare('INSERT INTO reminders (jid, seq, text, due_at, repeat, created_by, mention_jid) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(jid, seq, text, dueAt, repeat, createdBy, mentionJid);
  return { rowid: Number(info.lastInsertRowid), seq, jid, text, dueAt, repeat, createdBy, mentionJid };
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

export interface PersonHit { name: string; jid: string }

/**
 * Find people by (partial) name across the contacts table, enriched with
 * group-member phone/LID mappings so each person resolves to ONE chat JID.
 * DM addressing: phone JID when a number is known (WhatsApp resolves it),
 * else the LID JID.
 */
export function searchContacts(query: string): PersonHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const rows = db.prepare("SELECT id, name FROM contacts WHERE name != ''").all() as unknown as { id: string; name: string }[];
  // id classification from group memberships (pn vs lid).
  const pnIds = new Set<string>();
  const lidIds = new Set<string>();
  const memberByName = new Map<string, { pn: string; lid: string }>();
  for (const grow of db.prepare('SELECT jid FROM groups').all() as unknown as { jid: string }[]) {
    const g = getGroup(grow.jid);
    for (const m of g?.members || []) {
      if (m.pn) pnIds.add(m.pn);
      if (m.lid) lidIds.add(m.lid);
      if (m.name) memberByName.set(m.name.toLowerCase(), { pn: m.pn, lid: m.lid });
    }
  }
  const people = new Map<string, { name: string; ids: string[] }>();
  for (const r of rows) {
    const key = r.name.toLowerCase();
    if (!people.has(key)) people.set(key, { name: r.name, ids: [] });
    people.get(key)!.ids.push(r.id);
  }
  const hits: PersonHit[] = [];
  for (const p of people.values()) {
    const lname = p.name.toLowerCase();
    if (!lname.includes(q)) continue;
    const member = memberByName.get(lname);
    const pn = p.ids.find((i) => pnIds.has(i)) || (member?.pn ?? '');
    const lid = p.ids.find((i) => lidIds.has(i)) || (member?.lid ?? '');
    let jid: string;
    if (pn) jid = `${pn}@s.whatsapp.net`;
    else if (lid) jid = `${lid}@lid`;
    else {
      const only = p.ids[0];
      jid = only.length >= 14 ? `${only}@lid` : `${only}@s.whatsapp.net`;
    }
    hits.push({ name: p.name, jid });
  }
  const rank = (n: string): number => {
    const l = n.toLowerCase();
    return l === q ? 0 : l.startsWith(q) ? 1 : 2;
  };
  // The same person can sit in contacts under several names (phone contact
  // vs WhatsApp profile name) — one destination JID is ONE hit; keep the
  // fuller name variant.
  const byJid = new Map<string, PersonHit>();
  for (const h of hits) {
    const ex = byJid.get(h.jid);
    if (!ex || h.name.length > ex.name.length) byJid.set(h.jid, h);
  }
  return [...byJid.values()].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
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

// ---------- sent log (the agent's verifiable outbox) ----------

export interface SentRow { jid: string; kind: 'text' | 'voice'; text: string; ts: number }

export function recordSend(jid: string, kind: 'text' | 'voice', text: string): void {
  db.prepare('INSERT INTO sent_log (jid, kind, text, ts) VALUES (?, ?, ?, ?)').run(jid, kind, text, Date.now());
  db.prepare('DELETE FROM sent_log WHERE id NOT IN (SELECT id FROM sent_log ORDER BY id DESC LIMIT 100)').run();
}

/** Recent sends, oldest first. With a jid: only sends to that chat; without: all. */
export function recentSends(jid?: string, limit = 8): SentRow[] {
  const rows = (jid
    ? db.prepare('SELECT jid, kind, text, ts FROM sent_log WHERE jid = ? ORDER BY id DESC LIMIT ?').all(jid, limit)
    : db.prepare('SELECT jid, kind, text, ts FROM sent_log ORDER BY id DESC LIMIT ?').all(limit)) as unknown as SentRow[];
  return rows.reverse();
}
