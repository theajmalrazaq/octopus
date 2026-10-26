// Reminder / meetup operations the AI can perform. These are the only things
// that touch the database on the conversation side — every decision about
// when to call them is made by the LLM, not by hardcoded parsing rules.
import { tzEpoch, todayStr, tz } from './time.js';
import {
  addReminder, deleteReminder, getMeetupGroupJid, getMeetupState, listReminders,
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

export function describeReminders(jid: string): string {
  const mine = listReminders(jid);
  if (!mine.length) return 'none';
  return mine
    .map((r: Reminder) => `#${r.seq} "${r.text}" — ${fmtWhen(r.dueAt)}${r.repeat ? ` (repeats ${r.repeat})` : ''}`)
    .join('; ');
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
];

// Execute one tool call. Returns a short JSON string for the model.
export function applyTool(cfg: AgentConfig, ctx: MsgContext, name: string, argsRaw: unknown): string {
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
      const r = addReminder(jid, String(args.text), dueAt, repeat, ctx.senderNumber);
      return JSON.stringify({ ok: true, id: r.seq, text: r.text, when: fmtWhen(r.dueAt) });
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
    default:
      return fail(`unknown tool ${name}`);
  }
}
