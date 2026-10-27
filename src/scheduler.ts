// The clock. This is plumbing, not conversation rules: something has to ring
// the alarm at the set minute and post the daily meetup check-in — an LLM
// can't wake itself up. The WORDS of the scheduled posts are composed by the
// AI (llmCompose) with the plain templates below only as a fallback.
import { nowInTZ, todayStr, hhmm, addDays, weekdayOf } from './time.js';
import { bestSlot, DAY_NAMES } from './timetable.js';
import {
  dueReminders, getGroup, getMeetupGroupJid, getMeetupState, getMeetupTimes,
  removeReminder, rescheduleReminder, setMeetupState,
} from './db.js';
import { digitsOf, displayNameFor } from './actions.js';
import type { AgentConfig, GroupInfo } from './types.js';

const ASK_FALLBACK = [
  'meeting today?\nyes / no',
  'so.. what is the scene today\nmeeting or not',
  'meeting today?\nreply yes if yes',
];

interface SchedulerDeps {
  send: (jid: string, text: string, mentions?: string[]) => Promise<void> | void;
  compose: ((jid: string, instruction: string, groupContext?: GroupInfo | null) => Promise<string | null>) | null;
}

export async function runScheduler(cfg: AgentConfig, { send, compose }: SchedulerDeps): Promise<void> {
  const now = Date.now();
  const jobs: Promise<unknown>[] = [];

  // Fire due reminders. The fired message is composed by the AI in its
  // voice — a nudge, not a robotic "reminder:" template — and if the
  // reminder is for a person, it pings them with a real @mention.
  for (const r of dueReminders(now)) {
    jobs.push((async () => {
      const targetName = r.mentionJid ? displayNameFor(r.jid, r.mentionJid) : '';
      let text: string | null = null;
      if (compose) {
        text = await compose(r.jid,
          `A reminder just fired in this chat. Reminder text: "${r.text}".` +
          (r.mentionJid
            ? ` It is FOR ${targetName || 'the person being pinged'} — write it AS a direct nudge to them. Do NOT type their name or any @ yourself: a real @mention of them is attached to the start of your message automatically.`
            : ' Announce it to the chat.') +
          ' In your voice: short, blunt, natural — texting energy, like "uthhh ja ywr" for a wake-up call. Never a robotic "reminder:" prefix. One line, two at most. Do not call any tools.',
          getGroup(r.jid));
      }
      // Fallback (AI down): the stored text with any raw @number swapped
      // for the person's name — never leak bare LID digits into a chat.
      const cleaned = r.text.replace(/@\d{10,}/g, targetName).replace(/\s+/g, ' ').trim();
      let finalText = text || cleaned || r.text;
      const mentions = r.mentionJid ? [r.mentionJid] : undefined;
      if (r.mentionJid) {
        // WhatsApp renders a mention ONLY when the message text itself
        // contains @<digits> matching the mentions array — the array alone
        // shows as plain text and pings nobody. Prefix it deterministically.
        const digits = digitsOf(r.mentionJid);
        if (!finalText.includes(`@${digits}`)) finalText = `@${digits} ${finalText}`;
      }
      await send(r.jid, finalText, mentions);
    })());
    if (r.repeat === 'daily') rescheduleReminder(r.rowid, r.dueAt + 86400e3);
    else if (r.repeat === 'weekly') rescheduleReminder(r.rowid, r.dueAt + 7 * 86400e3);
    else removeReminder(r.rowid);
  }

  // Meetup group daily flow.
  const groupJid = getMeetupGroupJid(cfg);
  if (cfg.meetup.enabled && groupJid) {
    const { askTime, cutoffTime } = getMeetupTimes(cfg);
    const pktNow = nowInTZ();
    const today = todayStr();
    const clock = hhmm(pktNow);
    const st = getMeetupState();
    if (st.date !== today) {
      st.date = today;
      st.asked = false;
      st.status = 'idle';
      st.missedPosted = false;
      setMeetupState(st);
    }

    if (!st.asked && clock >= askTime) {
      st.asked = true;
      st.status = 'pending';
      setMeetupState(st);
      jobs.push((async () => {
        let text: string | null = null;
        if (compose) {
          text = await compose(groupJid,
            'Write the daily meetup check-in for this group: ask if they are meeting today and to reply yes or no. One or two short lines, in your voice. Do not call any tools.');
        }
        await send(groupJid, text || ASK_FALLBACK[pktNow.getDate() % ASK_FALLBACK.length]);
      })());
    }

    if (st.status === 'pending' && clock >= cutoffTime && !st.missedPosted) {
      st.status = 'missed';
      st.missedPosted = true;
      setMeetupState(st);
      const tomorrow = addDays(today, 1);
      const wd = weekdayOf(tomorrow);
      const slot = bestSlot(cfg.timetable, wd);
      jobs.push((async () => {
        let text: string | null = null;
        if (compose) {
          text = await compose(groupJid,
            `Nobody confirmed today's meetup and it's past the cutoff. Write the missed-meetup post in your voice: flat disappointment, note it was missed. Fact you must include: tomorrow is ${DAY_NAMES[wd]} and the owner is free ${slot ? slot.label : 'at no time between 9 AM and 9 PM (fully packed)'}. Suggest meeting then if there is a slot. Two or three short lines. Do not call any tools.`);
        }
        await send(groupJid, text || (slot
          ? `missed again today.\nthe owner is free tomorrow (${DAY_NAMES[wd]}) ${slot.label}.. meet then`
          : `missed again today.\nand tomorrow (${DAY_NAMES[wd]}) the owner is busy all day, no slot to offer`));
      })());
    }
  }
  await Promise.allSettled(jobs);
}
