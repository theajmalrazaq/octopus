// Time helpers pinned to the agent's timezone (config.timezone), regardless
// of the host clock. index.ts calls setTimezone() once at boot.
let TZ = process.env.AGENT_TZ || 'Asia/Karachi';
export function setTimezone(tz: string): void {
  if (tz) TZ = tz;
}
export function tz(): string {
  return TZ;
}

export function nowInTZ(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

export function todayStr(d: Date = nowInTZ()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function hhmm(d: Date = nowInTZ()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Parse "6pm", "6:30pm", "18:00", "9 am" -> "HH:MM" 24h, or null.
export function parseClock(text: string): string | null {
  const m = text.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const mins = m[2] ? Number(m[2]) : 0;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || mins > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

// Epoch ms for a wall-clock time in the agent's timezone. Resolves the zone
// offset through Intl, so it works for any IANA zone (including DST zones,
// single-pass — close enough for reminder scheduling).
export function tzEpoch(dateStr: string, clock: string): number {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = clock.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(guess));
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return guess - (asUTC - guess);
}

export function addDays(dateStr: string, days: number): string {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + days, 12));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// JS weekday index (0=Sun) for a YYYY-MM-DD calendar date.
export function weekdayOf(dateStr: string): number {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
}
