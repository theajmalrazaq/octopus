// Reminder / meetup operations the AI can perform. These are the only things
// that touch the database on the conversation side — every decision about
// when to call them is made by the LLM, not by hardcoded parsing rules.
import { tzEpoch, todayStr, tz } from './time.js';
import {
  addReminder, deleteReminder, getContact, getGroup, getMeetupGroupJid, getMeetupState, listReminders,
  pushHistory, recentSends, recordSend, searchContacts,
  setMeetupGroupJid, setMeetupState, setMeetupTimes, updateReminder,
} from './db.js';
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
      let dest: { name: string; jid: string } | null = null;
      const digits = target.replace(/\D/g, '');
      if (/^\d{7,}$/.test(digits) && !/[a-z]/i.test(target)) {
        if (digits === cfg.botNumber) return fail('that is my own number');
        dest = { name: getContact(digits) || target, jid: digits.length >= 14 ? `${digits}@lid` : `${digits}@s.whatsapp.net` };
      } else {
        const candidates: { name: string; jid: string }[] = [];
        for (const gj of cfg.access.groupJids) {
          const g = getGroup(gj);
          if (g && g.name.toLowerCase().includes(target.toLowerCase())) candidates.push({ name: `group "${g.name}"`, jid: gj });
        }
        candidates.push(...searchContacts(target).slice(0, 6));
        if (!candidates.length) return fail(`no saved contact or group matches "${target}" — ask the owner for the number`);
        if (candidates.length > 1) {
          return JSON.stringify({ ok: false, error: `"${target}" matches more than one person/group — ask the owner which one`, candidates: candidates.map((c) => c.name) });
        }
        dest = candidates[0];
      }
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
