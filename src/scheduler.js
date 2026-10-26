// The clock. This is plumbing, not conversation rules: something has to ring
// the alarm at the set minute and post the daily meetup check-in — an LLM
// can't wake itself up. The WORDS of the scheduled posts are composed by the
// AI (llmCompose) with the dry templates below only as a fallback.
import { nowInTZ, todayStr, hhmm, addDays, weekdayOf } from './time.js';
import { bestSlot, DAY_NAMES } from './timetable.js';

const ASK_FALLBACK = [
  'meeting today?\nyes / no',
  'so.. what is the scene today\nmeeting or not',
  'meeting today?\nreply yes if yes',
];

export function runScheduler(cfg, store, { send, compose }) {
  const now = Date.now();
  const jobs = [];

  // Fire due reminders.
  for (const r of [...store.reminders]) {
    if (r.dueAt <= now) {
      send(r.jid, `reminder: ${r.text}`);
      if (r.repeat === 'daily') r.dueAt += 86400e3;
      else if (r.repeat === 'weekly') r.dueAt += 7 * 86400e3;
      else store.reminders.splice(store.reminders.indexOf(r), 1);
    }
  }

  // Meetup group daily flow.
  const m = cfg.meetup;
  if (m.groupJid) {
    const pktNow = nowInTZ();
    const today = todayStr();
    const clock = hhmm(pktNow);
    const st = store.meetupState;
    if (st.date !== today) {
      st.date = today;
      st.asked = false;
      st.status = 'idle';
      st.missedPosted = false;
    }

    if (!st.asked && clock >= m.askTime) {
      st.asked = true;
      st.status = 'pending';
      jobs.push((async () => {
        let text = null;
        if (compose) {
          text = await compose(m.groupJid,
            'Write the daily meetup check-in for this group: ask if they are meeting today and to reply yes or no. One or two short lines, in your voice. Do not call any tools.');
        }
        send(m.groupJid, text || ASK_FALLBACK[pktNow.getDate() % ASK_FALLBACK.length]);
      })());
    }

    if (st.status === 'pending' && clock >= m.cutoffTime && !st.missedPosted) {
      st.status = 'missed';
      st.missedPosted = true;
      const tomorrow = addDays(today, 1);
      const wd = weekdayOf(tomorrow);
      const slot = bestSlot(wd);
      jobs.push((async () => {
        let text = null;
        if (compose) {
          text = await compose(m.groupJid,
            `Nobody confirmed today's meetup and it's past the cutoff. Write the missed-meetup post in your voice: flat disappointment, note it was missed. Fact you must include: tomorrow is ${DAY_NAMES[wd]} and the owner is free ${slot ? slot.label : 'at no time between 9 AM and 9 PM (fully packed)'}. Suggest meeting then if there is a slot. Two or three short lines. Do not call any tools.`);
        }
        send(m.groupJid, text || (slot
          ? `missed again today.\nthe owner is free tomorrow (${DAY_NAMES[wd]}) ${slot.label}.. meet then`
          : `missed again today.\nand tomorrow (${DAY_NAMES[wd]}) the owner is busy all day, no slot to offer`));
      })());
    }
  }
  return Promise.allSettled(jobs);
}
