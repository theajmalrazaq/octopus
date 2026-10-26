// Reminder / meetup operations the AI can perform. These are the ONLY things
// that touch the store on the conversation side — all decisions about when to
// call them are made by the LLM, not by hardcoded parsing rules.
import { pktEpoch, todayStr, TZ } from './time.js';

export function fmtWhen(ts) {
  return new Date(ts).toLocaleString('en-US', {
    timeZone: TZ,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Reminder IDs are per-chat: each chat numbers its own reminders from 1.
export function nextReminderId(store, jid) {
  return Math.max(0, ...store.reminders.filter((r) => r.jid === jid).map((r) => r.id)) + 1;
}

export function chatReminders(store, jid) {
  return store.reminders
    .filter((r) => r.jid === jid)
    .sort((a, b) => a.dueAt - b.dueAt);
}

export function describeReminders(store, jid) {
  const mine = chatReminders(store, jid);
  if (!mine.length) return 'none';
  return mine.map((r) => `#${r.id} "${r.text}" — ${fmtWhen(r.dueAt)}${r.repeat ? ` (repeats ${r.repeat})` : ''}`).join('; ');
}

function parseWhen(when) {
  // "YYYY-MM-DD HH:MM" (agent timezone)
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/.exec(String(when || '').trim());
  if (!m) return null;
  return pktEpoch(m[1], `${m[2]}:${m[3]}`);
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
          when: { type: 'string', description: 'Date and time in Asia/Karachi, format "YYYY-MM-DD HH:MM" (24h). Resolve relative times like "tomorrow" or "in 30 minutes" yourself using the current time given to you.' },
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
      description: 'Owner only: make THIS group the meetup group. Octopus will ask here daily at ask_time whether the group is meeting, and post a missed note after cutoff_time.',
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
export function applyTool(store, cfg, ctx, name, argsRaw) {
  let args = {};
  try { args = typeof argsRaw === 'string' ? JSON.parse(argsRaw || '{}') : (argsRaw || {}); } catch { /* empty */ }
  const jid = ctx.jid;
  const fail = (error) => JSON.stringify({ ok: false, error });

  switch (name) {
    case 'set_reminder': {
      const dueAt = parseWhen(args.when);
      if (dueAt === null) return fail('bad "when" format — use "YYYY-MM-DD HH:MM" (24h, agent timezone)');
      if (!args.text) return fail('missing reminder text');
      const id = nextReminderId(store, jid);
      store.reminders.push({
        id, jid, text: String(args.text), dueAt,
        repeat: args.repeat === 'daily' || args.repeat === 'weekly' ? args.repeat : null,
        createdBy: ctx.senderNumber,
      });
      return JSON.stringify({ ok: true, id, text: args.text, when: fmtWhen(dueAt) });
    }
    case 'update_reminder': {
      const r = store.reminders.find((x) => x.jid === jid && x.id === Number(args.id));
      if (!r) return fail(`no reminder #${args.id} in this chat`);
      if (args.when) {
        const dueAt = parseWhen(args.when);
        if (dueAt === null) return fail('bad "when" format — use "YYYY-MM-DD HH:MM" (24h, agent timezone)');
        r.dueAt = dueAt;
      }
      if (args.text) r.text = String(args.text);
      return JSON.stringify({ ok: true, id: r.id, text: r.text, when: fmtWhen(r.dueAt) });
    }
    case 'delete_reminder': {
      const i = store.reminders.findIndex((x) => x.jid === jid && x.id === Number(args.id));
      if (i === -1) return fail(`no reminder #${args.id} in this chat`);
      const [gone] = store.reminders.splice(i, 1);
      return JSON.stringify({ ok: true, deleted: { id: gone.id, text: gone.text } });
    }
    case 'list_reminders': {
      return JSON.stringify({ ok: true, reminders: describeReminders(store, jid) });
    }
    case 'mark_meetup': {
      if (!cfg.meetup.groupJid || cfg.meetup.groupJid !== jid) return fail('this chat is not the meetup group');
      const st = store.meetupState;
      if (st.date !== todayStr()) { st.date = todayStr(); st.asked = false; st.missedPosted = false; }
      st.status = args.status === 'confirmed' ? 'confirmed' : 'missed';
      return JSON.stringify({ ok: true, status: st.status });
    }
    case 'setup_meetup_here': {
      if (!ctx.isOwner) return fail('only the owner can do this');
      cfg.meetup.groupJid = jid;
      if (/^\d{1,2}:\d{2}$/.test(args.ask_time || '')) cfg.meetup.askTime = args.ask_time;
      if (/^\d{1,2}:\d{2}$/.test(args.cutoff_time || '')) cfg.meetup.cutoffTime = args.cutoff_time;
      if (ctx.saveCfg) ctx.saveCfg();
      return JSON.stringify({ ok: true, groupJid: jid, askTime: cfg.meetup.askTime, cutoffTime: cfg.meetup.cutoffTime });
    }
    default:
      return fail(`unknown tool ${name}`);
  }
}
