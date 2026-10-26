// The owner's weekly recurring schedule, used for "when is the owner free?"
// answers and meetup suggestions. Edit timetable.json in the project root:
// keys are JS day indexes (0 = Sunday … 6 = Saturday), each a list of
// { start: "HH:MM", end: "HH:MM", name: "..." } busy blocks (24h, agent TZ).
// If timetable.json is missing, a generic Mon–Fri 9-to-5 sample is used.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

const SAMPLE = {
  0: [],
  1: [{ start: '09:00', end: '17:00', name: 'Work' }],
  2: [{ start: '09:00', end: '17:00', name: 'Work' }],
  3: [{ start: '09:00', end: '17:00', name: 'Work' }],
  4: [{ start: '09:00', end: '17:00', name: 'Work' }],
  5: [{ start: '09:00', end: '17:00', name: 'Work' }],
  6: [],
};

function loadTimetable() {
  try {
    const path = join(ROOT, 'timetable.json');
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      const out = {};
      for (let d = 0; d < 7; d++) out[d] = Array.isArray(raw[d]) ? raw[d] : [];
      return out;
    }
  } catch (err) {
    console.error('timetable.json failed to load, using sample:', err.message);
  }
  return SAMPLE;
}

export const TIMETABLE = loadTimetable();

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function fmtTime(hhmm) {
  let [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h} ${ampm}` : `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Free gaps on a weekday (JS day index 0=Sun) inside the 09:00–21:00 window, min 45 minutes.
export function freeSlots(dayIndex, minGap = 45) {
  const classes = [...(TIMETABLE[dayIndex] || [])].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  const winStart = toMinutes('09:00');
  const winEnd = toMinutes('21:00');
  const gaps = [];
  let cursor = winStart;
  for (const c of classes) {
    const s = Math.max(toMinutes(c.start), winStart);
    const e = Math.min(toMinutes(c.end), winEnd);
    if (s - cursor >= minGap) gaps.push({ start: cursor, end: s });
    cursor = Math.max(cursor, e);
  }
  if (winEnd - cursor >= minGap) gaps.push({ start: cursor, end: winEnd });
  const toHHMM = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  return gaps.map((g) => ({
    start: toHHMM(g.start),
    end: toHHMM(g.end),
    minutes: g.end - g.start,
    label: `${fmtTime(toHHMM(g.start))} – ${fmtTime(toHHMM(g.end))}`,
  }));
}

// Human summary of the owner's free time on a given JS Date.
export function freeSummary(date) {
  const dayIndex = date.getDay();
  const dayName = DAY_NAMES[dayIndex];
  const classes = TIMETABLE[dayIndex] || [];
  if (classes.length === 0) return `${dayName}: nothing scheduled — free all day.`;
  const slots = freeSlots(dayIndex);
  if (slots.length === 0) return `${dayName}: scheduled back to back, no real gap in 9 AM – 9 PM.`;
  return `${dayName}: free ${slots.map((s) => s.label).join(', ')}.`;
}

// Best (longest) free slot on a day — used for the "meet tomorrow" suggestion.
export function bestSlot(dayIndex) {
  const slots = freeSlots(dayIndex);
  if (slots.length === 0) return null;
  return slots.reduce((a, b) => (b.minutes > a.minutes ? b : a));
}

export { DAY_NAMES };
