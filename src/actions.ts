// Reminder / meetup operations the AI can perform. These are the only things
// that touch the database on the conversation side — every decision about
// when to call them is made by the LLM, not by hardcoded parsing rules.
import { tzEpoch, todayStr, tz } from './time.js';
import {
  addFact, addLedgerExpense, addLedgerPayment, addReminder, computeBalances, deleteFact, deleteReminder,
  getContact, getGroup, getMeetupGroupJid, getMeetupState, ledgerNameKey, listFacts, listLedger, listReminders,
  pushHistory, recentSends, recordSend, searchContacts,
  setMeetupGroupJid, setMeetupState, setMeetupTimes, updateReminder, voidLedgerEntry,
} from './db.js';
import { fetchPage, webSearch } from './web.js';
import type { AgentConfig, MsgContext, Reminder } from './types.js';

export function fmtWhen(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    timeZone: tz(),
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The JID digits of any identifier form (bare digits, phone JID, LID JID). */
export const digitsOf = (jid: string): string => (jid || '').split('@')[0].split(':')[0];

/**
 * Canonical mention JID for a person in this chat: their LID form when the
 * group knows it (that's what current WhatsApp clients render/pay
 * attention to), else their phone JID. Null when the person is unknown.
 */
export function canonicalMentionJid(chatJid: string, anyForm: string): string | null {
  const d = digitsOf(anyForm);
  if (!d) return null;
  const member = getGroup(chatJid)?.members.find((m) => m.lid === d || m.pn === d);
  if (member?.lid) return `${member.lid}@lid`;
  if (member?.pn) return `${member.pn}@s.whatsapp.net`;
  const contact = getContact(d);
  return contact ? `${d}${anyForm.includes('@lid') ? '@lid' : '@s.whatsapp.net'}` : null;
}

/** Display name for a JID inside a chat: group member name, else contact name. */
/**
 * Real WhatsApp mentions for an outgoing text: every @<digits> token that
 * resolves to a known person in this chat becomes a mention JID. Without
 * the array entry WhatsApp renders the digits but pings nobody — the bug
 * behind "Ali, you owe 217" (name as plain text, Ali never notified,
 * in production use).
 */
export function mentionsForText(chatJid: string, text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/@(\d{7,15})/g)) {
    const jid = canonicalMentionJid(chatJid, m[1]);
    if (jid) found.add(jid);
  }
  return [...found];
}

/** Facts remembered for this chat, as a prompt line ('' when none). */
export function describeFacts(jid: string): string {
  const rows = listFacts(jid, 12);
  if (!rows.length) return '';
  return `Things you remember about THIS chat (saved facts — treat them as known): ${rows.map((f) => `#${f.id} ${f.fact}`).join('; ')}.`;
}

/**
 * Mention backstop for outgoing replies. The prompt tells her to address
 * members with @digits, but the chain models keep writing plain names —
 * and a plain name pings nobody (the recurring "never mentions Ali"
 * complaint). Deterministic fix: when a reply LINE starts by addressing
 * a group member — "Ali, ..." / "Ali you owe ..." — the name becomes
 * their @digits and a real mention is attached. Only line-start
 * addresses, only names matching exactly one member.
 */
const ADDRESS_CUES = /^(,|:|\s+(you|your|yours|owe|owes|send|pay|paid|come|came|wake|check|listen|look|take|give|sent|beta|sun|bata|batao|idhar)\b)/i;
export function applyNameMentions(chatJid: string, text: string): { text: string; mentions: string[] } {
  const g = getGroup(chatJid);
  const mentions = new Set<string>(mentionsForText(chatJid, text));
  if (!g) return { text, mentions: [...mentions] };
  // Candidate address forms: each member's full name and EVERY word of
  // it (people address "Mian Ali" as "Ali", not "Mian"), longest
  // first so the full name wins over a single word.
  const forms: { form: string; digits: string }[] = [];
  for (const m of g.members) {
    const digits = m.lid || m.pn;
    if (!m.name || !digits) continue;
    forms.push({ form: m.name, digits });
    for (const word of m.name.split(' ')) {
      if (word.length >= 3 && word !== m.name) forms.push({ form: word, digits });
    }
  }
  forms.sort((a, b) => b.form.length - a.form.length);
  const lines = text.split('\n').map((line) => {
    for (const { form, digits } of forms) {
      const esc = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^${esc}(,|:|\\s+\\S+)`, 'i');
      const match = re.exec(line);
      if (!match) continue;
      const rest = line.slice(form.length);
      if (!ADDRESS_CUES.test(rest)) continue;
      // Exactly one member must answer to this form.
      const same = forms.filter((f) => ledgerNameKey(f.form) === ledgerNameKey(form));
      const owners = new Set(same.map((f) => f.digits));
      if (owners.size !== 1) continue;
      const jid = canonicalMentionJid(chatJid, digits);
      if (!jid) continue;
      mentions.add(jid);
      return `@${digits}${rest}`;
    }
    return line;
  });
  return { text: lines.join('\n'), mentions: [...mentions] };
}

export function displayNameFor(chatJid: string, jid: string): string {
  const digits = (jid || '').split('@')[0].split(':')[0];
  if (!digits) return '';
  const g = getGroup(chatJid);
  const member = g?.members.find((m) => m.lid === digits || m.pn === digits);
  return member?.name || getContact(digits) || '';
}

export function describeReminders(jid: string): string {
  const mine = listReminders(jid);
  if (!mine.length) return 'none';
  return mine
    .map((r: Reminder) => `#${r.seq} "${r.text}" — ${fmtWhen(r.dueAt)}${r.repeat ? ` (repeats ${r.repeat})` : ''}${r.mentionJid ? ` (pings ${displayNameFor(jid, r.mentionJid) || r.mentionJid})` : ''}`)
    .join('; ');
}

/**
 * The verifiable outbox line for the prompt. scopeJid null = the owner's
 * DM, where the agent may see everything it sent; otherwise only sends to
 * THIS chat (never leak one chat's business into another).
 */
export function fmtMoney(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

export function balanceLine(jid: string): string {
  const bals = computeBalances(jid);
  return bals.length
    ? bals.map((b) => `${b.debtor} owes ${b.creditor} ${fmtMoney(b.amount)}`).join('; ')
    : 'all settled — nobody owes anybody';
}

/**
 * Resolve a name as said in chat ("Ali", "Sara") to the canonical
 * group-member name ("Mian Ali", "Sara Khan") so the ledger
 * keys a person consistently whichever form the model uses. Falls back
 * to the name as given when there is no unique member match.
 */
export function canonicalLedgerName(jid: string, name: string): string {
  const g = getGroup(jid);
  const key = ledgerNameKey(name);
  if (!g || !key) return name;
  const members = g.members.map((m) => m.name).filter(Boolean);
  const exact = members.find((n) => ledgerNameKey(n) === key);
  if (exact) return exact;
  const wordMatch = members.filter((n) => ledgerNameKey(n).split(' ').includes(key));
  if (wordMatch.length === 1) return wordMatch[0];
  return name;
}

/**
 * The per-chat money ledger as a prompt line: recent entries plus the
 * computed balances. Deterministic — the model reads the answer instead
 * of reconstructing it from scrolled-away chat history.
 */
export function describeLedger(jid: string): string {
  const rows = listLedger(jid, 8);
  if (!rows.length) return '';
  const items = rows.map((e) => (e.kind === 'expense'
    ? `#${e.id} ${e.who} paid ${fmtMoney(e.amount)}${e.note ? ` for ${e.note}` : ''}${e.splitWith.length ? `, split with ${e.splitWith.join(', ')} (${fmtMoney(e.amount / (e.splitWith.length + 1))} each)` : ' (not split)'}`
    : `#${e.id} ${e.who} paid ${fmtMoney(e.amount)} to ${e.other}${e.note ? ` (${e.note})` : ''}`));
  return `Money ledger for THIS chat — your durable money memory, trust it over chat history: ${items.join('; ')}. Current balances: ${balanceLine(jid)}.`;
}

/**
 * The verifiable outbox line for the prompt. scopeJid null = the owner's
 * DM, where she may see everything she sent; otherwise only sends to THIS
 * chat (never leak one chat's business into another).
 */
export function describeSends(scopeJid: string | null): string {
  const rows = recentSends(scopeJid || undefined, 8);
  if (!rows.length) return '';
  const nameOf = (jid: string): string => (jid.endsWith('@g.us')
    ? `group "${getGroup(jid)?.name || '?'}"`
    : getContact(digitsOf(jid)) || digitsOf(jid));
  const items = rows.map((r) => {
    const when = new Date(r.ts).toLocaleTimeString('en-US', { timeZone: tz(), hour: 'numeric', minute: '2-digit' });
    return `${r.kind === 'voice' ? 'voice note' : 'text'} to ${nameOf(r.jid)} at ${when}: "${r.text.slice(0, 60)}"`;
  });
  return `Your outbox — messages you have ACTUALLY sent (verified record, trust this over memory): ${items.join('; ')}. If something is not listed here, you did NOT send it.`;
}

function parseWhen(when: unknown): number | null {
  // "YYYY-MM-DD HH:MM" in the agent's timezone.
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/.exec(String(when || '').trim());
  if (!m) return null;
  return tzEpoch(m[1], `${m[2]}:${m[3]}`);
}

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: 'Create a new reminder in this chat. Use when someone asks to be reminded about something at a time.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What the reminder is about, short.' },
          when: { type: 'string', description: 'Date and time in the agent timezone, format "YYYY-MM-DD HH:MM" (24h). Resolve relative times like "tomorrow" or "in 30 minutes" yourself using the current time given to you.' },
          repeat: { type: 'string', enum: ['daily', 'weekly'], description: 'Optional. Only if they asked for a repeating reminder.' },
          mention_jid: { type: 'string', description: 'Optional. If this reminder is FOR a person who was @mentioned in the message (wake them, remind them), pass that person\'s jid exactly as listed in the prompt\'s mentions line — the fired reminder will then actually ping them. Omit for reminders about things, not people.' },
        },
        required: ['text', 'when'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_reminder',
      description: 'Change an existing reminder in this chat (its time and/or text). Use this when someone corrects or adjusts a reminder they already set — do NOT create a second reminder for a correction.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'The reminder number in this chat.' },
          when: { type: 'string', description: 'New date/time, format "YYYY-MM-DD HH:MM" (agent timezone). Omit to keep the old time.' },
          text: { type: 'string', description: 'New reminder text. Omit to keep the old text.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_reminder',
      description: 'Delete a reminder from this chat by its number.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: 'List the reminders currently set in this chat.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_expense',
      description: 'Record a shared expense in this chat\'s money ledger. Call this in the SAME turn whenever someone says they spent/paid money on something shared, or asks to split a cost — don\'t wait to be asked to record it. payer = the person who spent, a name as used in this chat. split_with = the OTHER people sharing the cost, NOT including the payer (a normal 2-person split: just the other person). If split_with is omitted it splits with everyone else in this chat.',
      parameters: {
        type: 'object',
        properties: {
          payer: { type: 'string', description: 'Who spent the money (name as used in this chat). Defaults to the sender.' },
          amount: { type: 'number', description: 'Total amount spent.' },
          note: { type: 'string', description: 'What it was for, including any item breakdown given.' },
          split_with: { type: 'array', items: { type: 'string' }, description: 'Names of the other people sharing this cost (not the payer).' },
        },
        required: ['amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_payment',
      description: 'Record that one person in this chat paid/sent money to another person here (settling a debt). Use when someone says they paid, sent, transferred money, or confirms a payment is done. from = who paid, to = who received it.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Who paid (name as used in this chat). Defaults to the sender.' },
          to: { type: 'string', description: 'Who received the money.' },
          amount: { type: 'number', description: 'Amount paid.' },
          note: { type: 'string', description: 'Optional note, e.g. what it settles.' },
        },
        required: ['to', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_balance',
      description: 'Get this chat\'s money ledger: recent expenses and payments plus the exact current balances (who owes whom, how much). Use whenever anyone asks about the balance, who owes whom, or how much someone has to send.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'void_ledger_entry',
      description: 'Undo a wrong money-ledger entry by its #number (shown in the ledger line / get_balance). Use when an expense or payment was recorded wrong or twice.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current facts you don\'t know or that may be stale: news, prices, results, specs, definitions of new things, "who/what/when" questions about the outside world. Returns the top results with snippets. Use this instead of guessing or saying idk on factual questions.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_page',
      description: 'Open a web link and read its text. Use when someone shares a URL and asks about it, or when a search result needs a closer read.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The full http(s) URL.' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description: 'Save a durable fact about this chat so you remember it in future conversations: a plan, a date, a preference, who someone is, a decision the chat made. Use when someone says "remember that..." or states something plainly durable. NOT for money (the ledger tools) or timed reminders (set_reminder).',
      parameters: {
        type: 'object',
        properties: { fact: { type: 'string', description: 'The fact, one short sentence, with names as used in this chat.' } },
        required: ['fact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget_fact',
      description: 'Delete a saved fact about this chat by its #number (shown in the remembered-facts line / when it was saved). Use when a fact turns out wrong or no longer true.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_meetup',
      description: 'Record the meetup answer for today in the meetup group: "confirmed" when someone says yes / the meet is on, "declined" when someone says no / not today.',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['confirmed', 'declined'] } },
        required: ['status'],
      },
    },
  },
];

export const OWNER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'setup_meetup_here',
      description: 'Owner only: make THIS group the meetup group. The agent will ask here daily at ask_time whether the group is meeting, and post a missed note after cutoff_time.',
      parameters: {
        type: 'object',
        properties: {
          ask_time: { type: 'string', description: '"HH:MM" 24h, default "10:00"' },
          cutoff_time: { type: 'string', description: '"HH:MM" 24h, default "20:00"' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Owner only: send a message FROM the assistant to one of the owner\'s saved contacts or one of the owner\'s groups, when the owner explicitly asks you to text/message someone. Compose the message text yourself, in your voice, as the assistant speaking to that person. Set voice=true to send it as a voice note instead of text (only when the owner asks for a voice note / audio).',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Who to message: the name as the owner said it (e.g. "Mom"), a group name, or a phone number.' },
          text: { type: 'string', description: 'The message to send, composed in your voice.' },
          voice: { type: 'boolean', description: 'Optional. true = send as a voice note; default false (text).' },
        },
        required: ['target', 'text'],
      },
    },
  },
];

/** Outbound send channel supplied by the transport (index.ts). */
export type SendOut = (jid: string, payload: { text: string; voice: boolean }) => Promise<{ ok: boolean; error?: string }>;

export type ResolveResult =
  | { ok: true; name: string; jid: string }
  | { ok: false; error: string; candidates?: string[] };

/**
 * Resolve a send target — a raw phone number, a group name, or a contact
 * name — to exactly one destination. Shared by the send_message tool and
 * the MCP outbox drain, so both paths resolve identically.
 */
export function resolveSendTarget(cfg: AgentConfig, target: string): ResolveResult {
  const digits = target.replace(/\D/g, '');
  if (/^\d{7,}$/.test(digits) && !/[a-z]/i.test(target)) {
    if (digits === cfg.botNumber) return { ok: false, error: 'that is my own number' };
    return { ok: true, name: getContact(digits) || target, jid: digits.length >= 14 ? `${digits}@lid` : `${digits}@s.whatsapp.net` };
  }
  const candidates: { name: string; jid: string }[] = [];
  for (const gj of cfg.access.groupJids) {
    const g = getGroup(gj);
    if (g && g.name.toLowerCase().includes(target.toLowerCase())) candidates.push({ name: `group "${g.name}"`, jid: gj });
  }
  candidates.push(...searchContacts(target).slice(0, 6));
  if (!candidates.length) return { ok: false, error: `no saved contact or group matches "${target}" — ask the owner for the number` };
  if (candidates.length > 1) {
    return { ok: false, error: `"${target}" matches more than one person/group — ask the owner which one`, candidates: candidates.map((c) => c.name) };
  }
  return { ok: true, name: candidates[0].name, jid: candidates[0].jid };
}

// Execute one tool call. Returns a short JSON string for the model.
export async function applyTool(cfg: AgentConfig, ctx: MsgContext, name: string, argsRaw: unknown, sendOut?: SendOut): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = (typeof argsRaw === 'string' ? JSON.parse(argsRaw || '{}') : argsRaw || {}) as Record<string, unknown>;
  } catch { /* empty */ }
  const jid = ctx.jid;
  const fail = (error: string) => JSON.stringify({ ok: false, error });

  switch (name) {
    case 'set_reminder': {
      const dueAt = parseWhen(args.when);
      if (dueAt === null) return fail('bad "when" format — use "YYYY-MM-DD HH:MM" (24h, agent timezone)');
      if (!args.text) return fail('missing reminder text');
      const repeat = args.repeat === 'daily' || args.repeat === 'weekly' ? args.repeat : null;
      // Resolve the ping target. Accept the model's mention_jid in ANY id
      // form (digits, phone JID, LID JID) as long as that person was
      // genuinely @mentioned in this message; canonicalize it. And if the
      // model forgot but exactly ONE person was @mentioned, that person is
      // the target — in these chats a lone @mention in a reminder request
      // is who the reminder is for.
      const mentionedDigits = new Set((ctx.mentions || []).map((m) => digitsOf(m.jid)));
      let mentionJid: string | null = null;
      if (typeof args.mention_jid === 'string' && mentionedDigits.has(digitsOf(args.mention_jid))) {
        mentionJid = canonicalMentionJid(jid, args.mention_jid);
      }
      if (!mentionJid && ctx.mentions && ctx.mentions.length === 1) {
        mentionJid = canonicalMentionJid(jid, ctx.mentions[0].jid);
      }
      const r = addReminder(jid, String(args.text), dueAt, repeat, ctx.senderNumber, mentionJid);
      return JSON.stringify({ ok: true, id: r.seq, text: r.text, when: fmtWhen(r.dueAt), pings: mentionJid ? displayNameFor(jid, mentionJid) || mentionJid : undefined });
    }
    case 'update_reminder': {
      const patch: { text?: string; dueAt?: number } = {};
      if (args.when) {
        const dueAt = parseWhen(args.when);
        if (dueAt === null) return fail('bad "when" format — use "YYYY-MM-DD HH:MM" (24h, agent timezone)');
        patch.dueAt = dueAt;
      }
      if (args.text) patch.text = String(args.text);
      const r = updateReminder(jid, Number(args.id), patch);
      if (!r) return fail(`no reminder #${args.id} in this chat`);
      return JSON.stringify({ ok: true, id: r.seq, text: r.text, when: fmtWhen(r.dueAt) });
    }
    case 'delete_reminder': {
      const gone = deleteReminder(jid, Number(args.id));
      if (!gone) return fail(`no reminder #${args.id} in this chat`);
      return JSON.stringify({ ok: true, deleted: { id: gone.seq, text: gone.text } });
    }
    case 'list_reminders': {
      return JSON.stringify({ ok: true, reminders: describeReminders(jid) });
    }
    case 'log_expense': {
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) return fail('amount must be a positive number');
      const payerRaw = String(args.payer || ctx.senderName || '').trim();
      if (!payerRaw) return fail('who spent the money?');
      const payer = canonicalLedgerName(jid, payerRaw);
      let splitWith = Array.isArray(args.split_with)
        ? (args.split_with as unknown[]).map((s) => canonicalLedgerName(jid, String(s).trim())).filter((s) => s && ledgerNameKey(s) !== ledgerNameKey(payer))
        : [];
      if (!splitWith.length) {
        // No split named: split with everyone else in this chat (group
        // members other than the payer and the bot herself).
        const g = getGroup(jid);
        if (g) {
          splitWith = g.members
            .map((m) => m.name)
            .filter((n) => n && ledgerNameKey(n) !== ledgerNameKey(payer) && ledgerNameKey(n) !== ledgerNameKey(cfg.botName));
        }
      }
      const e = addLedgerExpense(jid, payer, amount, String(args.note || '').trim(), splitWith);
      return JSON.stringify({
        ok: true, id: e.id,
        summary: splitWith.length
          ? `logged: ${payer} paid ${fmtMoney(amount)}, split with ${splitWith.join(', ')} (${fmtMoney(amount / (splitWith.length + 1))} each). Balances now: ${balanceLine(jid)}`
          : `logged: ${payer} paid ${fmtMoney(amount)} (not split). Balances now: ${balanceLine(jid)}`,
      });
    }
    case 'record_payment': {
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) return fail('amount must be a positive number');
      const fromRaw = String(args.from || ctx.senderName || '').trim();
      const toRaw = String(args.to || '').trim();
      if (!fromRaw || !toRaw) return fail('who paid whom?');
      const from = canonicalLedgerName(jid, fromRaw);
      const to = canonicalLedgerName(jid, toRaw);
      if (ledgerNameKey(from) === ledgerNameKey(to)) return fail('payer and receiver are the same person');
      const e = addLedgerPayment(jid, from, to, amount, String(args.note || '').trim());
      return JSON.stringify({
        ok: true, id: e.id,
        summary: `payment logged: ${from} paid ${to} ${fmtMoney(amount)}. Balances now: ${balanceLine(jid)}`,
      });
    }
    case 'get_balance': {
      return JSON.stringify({ ok: true, text: describeLedger(jid) || 'no money recorded in this chat yet — the ledger is empty' });
    }
    case 'void_ledger_entry': {
      const gone = voidLedgerEntry(jid, Number(args.id));
      if (!gone) return fail(`no ledger entry #${args.id} in this chat`);
      return JSON.stringify({
        ok: true, id: gone.id,
        summary: `entry #${gone.id} removed. Balances now: ${balanceLine(jid)}`,
      });
    }
    case 'web_search': {
      const query = String(args.query || '').trim();
      if (!query) return fail('query is required');
      try {
        const hits = await webSearch(query);
        if (!hits.length) return JSON.stringify({ ok: true, text: `no results found for "${query}"`, results: [] });
        return JSON.stringify({
          ok: true,
          results: hits,
          text: hits.map((h, i) => `${i + 1}. ${h.title} — ${h.snippet}${h.url ? ` (${h.url})` : ''}`).join('\n'),
        });
      } catch (e) {
        return fail(`search failed: ${(e as Error).message}`);
      }
    }
    case 'fetch_page': {
      const url = String(args.url || '').trim();
      if (!url) return fail('url is required');
      try {
        const page = await fetchPage(url);
        return JSON.stringify({ ok: true, title: page.title, text: page.text });
      } catch (e) {
        return fail(`could not open that page: ${(e as Error).message}`);
      }
    }
    case 'remember_fact': {
      const fact = String(args.fact || '').trim();
      if (!fact) return fail('fact is required');
      const f = addFact(jid, fact);
      return JSON.stringify({ ok: true, id: f.id, summary: `remembered: ${fact}` });
    }
    case 'forget_fact': {
      const gone = deleteFact(jid, Number(args.id));
      if (!gone) return fail(`no saved fact #${args.id} in this chat`);
      return JSON.stringify({ ok: true, id: gone.id, summary: `forgotten: ${gone.fact}` });
    }
    case 'mark_meetup': {
      if (getMeetupGroupJid(cfg) !== jid) return fail('this chat is not the meetup group');
      const st = getMeetupState();
      if (st.date !== todayStr()) {
        st.date = todayStr();
        st.asked = false;
        st.missedPosted = false;
      }
      st.status = args.status === 'confirmed' ? 'confirmed' : 'missed';
      setMeetupState(st);
      return JSON.stringify({ ok: true, status: st.status });
    }
    case 'setup_meetup_here': {
      if (!ctx.isOwner) return fail('only the owner can do this');
      setMeetupGroupJid(jid);
      cfg.meetup.enabled = true;
      const ask = /^\d{1,2}:\d{2}$/.test(String(args.ask_time || '')) ? String(args.ask_time) : cfg.meetup.askTime;
      const cutoff = /^\d{1,2}:\d{2}$/.test(String(args.cutoff_time || '')) ? String(args.cutoff_time) : cfg.meetup.cutoffTime;
      setMeetupTimes(ask, cutoff);
      return JSON.stringify({ ok: true, groupJid: jid, askTime: ask, cutoffTime: cutoff });
    }
    case 'send_message': {
      if (!ctx.isOwner) return fail('only the owner can ask me to message someone');
      if (!sendOut) return fail('sending is unavailable right now');
      const target = String(args.target || '').trim();
      const text = String(args.text || '').trim();
      const voice = args.voice === true;
      if (!target || !text) return fail('target and text are required');
      // Resolve the target: a raw number, a group name, or a contact name.
      const resolved = resolveSendTarget(cfg, target);
      if (!resolved.ok) {
        return resolved.candidates
          ? JSON.stringify({ ok: false, error: resolved.error, candidates: resolved.candidates })
          : fail(resolved.error);
      }
      const dest = { name: resolved.name, jid: resolved.jid };
      const res = await sendOut(dest.jid, { text, voice });
      if (!res.ok) return fail(`send failed: ${res.error || 'unknown error'}`);
      // Remember in the TARGET chat that the agent spoke there, so a reply
      // there has context — and in the verifiable outbox, so "did you send
      // it?" can later be answered from record, not from vibes.
      recordSend(dest.jid, voice ? 'voice' : 'text', text);
      pushHistory(dest.jid, 'assistant', voice ? `[sent as a voice note] ${text}` : text);
      return JSON.stringify({ ok: true, to: dest.name, as: voice ? 'voice note' : 'text' });
    }
    default:
      return fail(`unknown tool ${name}`);
  }
}
