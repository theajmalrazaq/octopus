// Free-slot math over the owner's weekly schedule, which lives in the config
// (timetable field — set it in the dashboard). Nothing is hardcoded: an empty
// timetable simply turns the schedule features off.
import type { ScheduleBlock } from './types.js';

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function dayBlocks(timetable: Record<string, ScheduleBlock[]>, dayIndex: number): ScheduleBlock[] {
  return timetable[String(dayIndex)] || [];
}

export function hasSchedule(timetable: Record<string, ScheduleBlock[]>): boolean {
  return Object.values(timetable).some((blocks) => blocks && blocks.length > 0);
}

function toMinutes(hhmmStr: string): number {
  const [h, m] = hhmmStr.split(':').map(Number);
  return h * 60 + m;
}

export function fmtTime(hhmmStr: string): string {
  let [h, m] = hhmmStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h} ${ampm}` : `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

export interface FreeSlot {
  start: string;
  end: string;
  minutes: number;
  label: string;
}

// Free gaps on a weekday inside the 09:00–21:00 window, minimum 45 minutes.
export function freeSlots(blocks: ScheduleBlock[], minGap = 45): FreeSlot[] {
  const sorted = [...blocks].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  const winStart = toMinutes('09:00');
  const winEnd = toMinutes('21:00');
  const gaps: { start: number; end: number }[] = [];
  let cursor = winStart;
  for (const c of sorted) {
    const s = Math.max(toMinutes(c.start), winStart);
    const e = Math.min(toMinutes(c.end), winEnd);
    if (s - cursor >= minGap) gaps.push({ start: cursor, end: s });
    cursor = Math.max(cursor, e);
  }
  if (winEnd - cursor >= minGap) gaps.push({ start: cursor, end: winEnd });
  const toHHMM = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  return gaps.map((g) => ({
    start: toHHMM(g.start),
    end: toHHMM(g.end),
    minutes: g.end - g.start,
    label: `${fmtTime(toHHMM(g.start))} – ${fmtTime(toHHMM(g.end))}`,
  }));
}

// Best (longest) free slot on a day — used for the "meet tomorrow" suggestion.
export function bestSlot(timetable: Record<string, ScheduleBlock[]>, dayIndex: number): FreeSlot | null {
  const slots = freeSlots(dayBlocks(timetable, dayIndex));
  if (!slots.length) return null;
  return slots.reduce((a, b) => (b.minutes > a.minutes ? b : a));
}

// One-line "Mon: Work 9 AM–5 PM, Gym 6 PM–7 PM | Tue: …" for the prompt.
export function scheduleSummary(timetable: Record<string, ScheduleBlock[]>): string {
  return DAY_NAMES.map((d, i) => {
    const blocks = dayBlocks(timetable, i);
    return blocks.length
      ? `${d}: ${blocks.map((c) => `${c.name} ${fmtTime(c.start)}–${fmtTime(c.end)}`).join(', ')}`
      : `${d}: nothing scheduled`;
  }).join(' | ');
}
