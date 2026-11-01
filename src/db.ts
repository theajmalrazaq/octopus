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
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL,
    text TEXT NOT NULL,
    voice INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    jid TEXT,
    name TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    done_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    kind TEXT NOT NULL,
    who TEXT NOT NULL,
    other TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    split_with TEXT NOT NULL DEFAULT '[]',
    ts INTEGER NOT NULL,
    voided INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_jid ON ledger(jid, id);
  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    fact TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_facts_jid ON facts(jid, id);
`);
// WAL + busy timeout: the Octopus MCP server process shares this database
// (it queues sends in `outbox`); short concurrent access must not fail.
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

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

// ---------- money ledger ----------
// Per-chat durable record of shared expenses and settling payments.
// Chat history is only the last ~12 turns, so money facts scrolled out of
// it were simply gone — she answered "idk" to "how much do I have to
// send?" 22 minutes after computing the split herself (2026-10-29). The
// ledger is the fix: expenses/payments are rows, balances are computed
// from them deterministically, and the summary rides in every prompt.
export interface LedgerEntry {
  id: number; jid: string; kind: 'expense' | 'payment';
  who: string; other: string; amount: number; note: string;
  splitWith: string[]; ts: number;
}
interface LedgerRow {
  id: number; jid: string; kind: string; who: string; other: string;
  amount: number; note: string; split_with: string; ts: number;
}
function toLedger(r: LedgerRow): LedgerEntry {
  let splitWith: string[] = [];
  try { splitWith = JSON.parse(r.split_with) as string[]; } catch { /* stored JSON */ }
  return {
    id: r.id, jid: r.jid, kind: r.kind === 'payment' ? 'payment' : 'expense',
    who: r.who, other: r.other, amount: r.amount, note: r.note,
    splitWith: Array.isArray(splitWith) ? splitWith.map(String) : [], ts: r.ts,
  };
}
export const ledgerNameKey = (n: string): string => n.trim().replace(/\s+/g, ' ').toLowerCase();

export function addLedgerExpense(jid: string, payer: string, amount: number, note: string, splitWith: string[]): LedgerEntry {
  const info = db.prepare('INSERT INTO ledger (jid, kind, who, other, amount, note, split_with, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(jid, 'expense', payer, '', amount, note, JSON.stringify(splitWith), Date.now());
  return { id: Number(info.lastInsertRowid), jid, kind: 'expense', who: payer, other: '', amount, note, splitWith, ts: Date.now() };
}
export function addLedgerPayment(jid: string, from: string, to: string, amount: number, note: string): LedgerEntry {
  const info = db.prepare('INSERT INTO ledger (jid, kind, who, other, amount, note, split_with, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(jid, 'payment', from, to, amount, note, '[]', Date.now());
  return { id: Number(info.lastInsertRowid), jid, kind: 'payment', who: from, other: to, amount, note, splitWith: [], ts: Date.now() };
}
export function listLedger(jid: string, limit = 20): LedgerEntry[] {
  const rows = db.prepare('SELECT * FROM ledger WHERE jid = ? AND voided = 0 ORDER BY id DESC LIMIT ?')
    .all(jid, limit) as unknown as LedgerRow[];
  return rows.map(toLedger).reverse();
}
export function voidLedgerEntry(jid: string, id: number): LedgerEntry | null {
  const cur = db.prepare('SELECT * FROM ledger WHERE jid = ? AND id = ? AND voided = 0').get(jid, id) as unknown as LedgerRow | undefined;
  if (!cur) return null;
  db.prepare('UPDATE ledger SET voided = 1 WHERE id = ?').run(id);
  return toLedger(cur);
}

/** Net pairwise debts for a chat, folded so each pair appears once. */
export function computeBalances(jid: string): { debtor: string; creditor: string; amount: number }[] {
  const rows = listLedger(jid, 500);
  const display = new Map<string, string>();
  const disp = (n: string): string => {
    const k = ledgerNameKey(n);
    if (!display.has(k)) display.set(k, n.trim());
    return display.get(k)!;
  };
  const owe = new Map<string, number>(); // "debtorKey\u0001creditorKey" -> amount debtor owes creditor
  const addOwe = (debtor: string, creditor: string, amt: number): void => {
    if (!debtor || !creditor || ledgerNameKey(debtor) === ledgerNameKey(creditor) || amt === 0) return;
    disp(debtor); disp(creditor);
    const k = `${ledgerNameKey(debtor)}\u0001${ledgerNameKey(creditor)}`;
    owe.set(k, (owe.get(k) || 0) + amt);
  };
  for (const e of rows) {
    if (e.kind === 'expense') {
      const share = e.amount / (e.splitWith.length + 1);
      for (const p of e.splitWith) addOwe(p, e.who, share);
    } else {
      addOwe(e.who, e.other, -e.amount); // a payment reduces what the payer owed the receiver
    }
  }
  const out: { debtor: string; creditor: string; amount: number }[] = [];
  const seenPairs = new Set<string>();
  for (const [k, v] of owe) {
    const [a, b] = k.split('\u0001');
    const pairKey = [a, b].sort().join('\u0001');
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const net = v - (owe.get(`${b}\u0001${a}`) || 0);
    if (Math.abs(net) < 0.01) continue;
    const round = (n: number): number => Math.round(n * 100) / 100;
    if (net > 0) out.push({ debtor: display.get(a)!, creditor: display.get(b)!, amount: round(net) });
    else out.push({ debtor: display.get(b)!, creditor: display.get(a)!, amount: round(-net) });
  }
  return out;
}

// ---------- per-chat remembered facts ----------
// Durable free-form memory per chat ("a friend's exam is on Monday", "we
// split petrol 3 ways") saved via the remember_fact tool and listed in
// every prompt for that chat. Money has the ledger and times have
// reminders; this is for everything else worth keeping.
export interface Fact { id: number; jid: string; fact: string; ts: number }
export function addFact(jid: string, fact: string): Fact {
  const info = db.prepare('INSERT INTO facts (jid, fact, ts) VALUES (?, ?, ?)').run(jid, fact, Date.now());
  return { id: Number(info.lastInsertRowid), jid, fact, ts: Date.now() };
}
export function listFacts(jid: string, limit = 12): Fact[] {
  const rows = db.prepare('SELECT * FROM facts WHERE jid = ? ORDER BY id DESC LIMIT ?').all(jid, limit) as unknown as Fact[];
  return rows.reverse();
}
export function deleteFact(jid: string, id: number): Fact | null {
  const cur = db.prepare('SELECT * FROM facts WHERE jid = ? AND id = ?').get(jid, id) as unknown as Fact | undefined;
  if (!cur) return null;
  db.prepare('DELETE FROM facts WHERE id = ?').run(id);
  return cur;
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

// ---------- MCP outbox ----------
// External assistants (through the Octopus MCP server in mcp/) queue sends
// here. Only the gateway process holds the WhatsApp socket, so it drains
// this table and performs each send through the normal send path; the MCP
// server polls the row for the outcome.
export interface OutboxRow {
  id: number; target: string; text: string; voice: boolean;
  status: string; jid: string; name: string; error: string;
  createdAt: number; doneAt: number;
}
interface OutboxDbRow {
  id: number; target: string; text: string; voice: number;
  status: string; jid: string | null; name: string | null; error: string | null;
  created_at: number; done_at: number | null;
}
function toOutbox(r: OutboxDbRow): OutboxRow {
  return {
    id: r.id, target: r.target, text: r.text, voice: r.voice === 1,
    status: r.status, jid: r.jid || '', name: r.name || '', error: r.error || '',
    createdAt: r.created_at, doneAt: r.done_at || 0,
  };
}
export function pendingOutbox(limit = 3): OutboxRow[] {
  const rows = db.prepare("SELECT * FROM outbox WHERE status = 'pending' ORDER BY id ASC LIMIT ?").all(limit) as unknown as OutboxDbRow[];
  return rows.map(toOutbox);
}
/** Atomically claim a pending row so overlapping ticks never send it twice. */
export function claimOutbox(id: number): boolean {
  const info = db.prepare("UPDATE outbox SET status = 'sending' WHERE id = ? AND status = 'pending'").run(id);
  return Number(info.changes) > 0;
}
export function completeOutbox(id: number, jid: string, name: string): void {
  db.prepare("UPDATE outbox SET status = 'sent', jid = ?, name = ?, done_at = ? WHERE id = ?").run(jid, name, Date.now(), id);
}
export function failOutbox(id: number, error: string): void {
  db.prepare("UPDATE outbox SET status = 'failed', error = ?, done_at = ? WHERE id = ?").run(error.slice(0, 500), Date.now(), id);
}
