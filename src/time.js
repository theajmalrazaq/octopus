// Time helpers pinned to the agent's timezone regardless of host TZ.
// Set AGENT_TZ (IANA name) in .env; defaults to Asia/Karachi.
export const TZ = process.env.AGENT_TZ || 'Asia/Karachi';

export function nowInTZ() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

export function todayStr(d = nowInTZ()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function hhmm(d = nowInTZ()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Parse "6pm", "6:30pm", "18:00", "9 am" -> "HH:MM" 24h, or null.
export function parseClock(text) {
  const m = text.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const mins = m[2] ? Number(m[2]) : 0;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || mins > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

// Build an epoch-ms due time from a PKT date (YYYY-MM-DD) + "HH:MM".
// PKT is UTC+5 year-round (no DST).
export function pktEpoch(dateStr, clock) {
  return Date.parse(`${dateStr}T${clock}:00+05:00`);
}

export function dateStrOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00+05:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return todayStr(new Date(d.toLocaleString('en-US', { timeZone: TZ })));
}

// JS weekday index (0=Sun) for a YYYY-MM-DD date in PKT.
export function weekdayOf(dateStr) {
  return new Date(`${dateStr}T12:00:00+05:00`).getUTCDay();
}
