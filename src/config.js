import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(dir, '..');
const CONFIG_PATH = join(ROOT, 'config.json');

const DEFAULTS = {
  botName: 'Nova',
  // Spare WhatsApp number that IS the assistant (digits only, with country code, e.g. 92xxxxxxxxxx)
  botNumber: '',
  // The owner's main number (digits only) — owner-only tools work from this number
  ownerNumber: '',
  timezone: 'Asia/Karachi',
  llm: {
    enabled: true,
    model: 'openai/gpt-oss-120b',
    apiBase: 'https://api.groq.com/openai/v1',
  },
  meetup: {
    enabled: false,
    groupJid: '',        // set with the in-group command: "nova setup meetup here"
    askTime: '10:00',    // daily "are we meeting today?" post time (PKT)
    cutoffTime: '20:00', // if not confirmed by then, post the missed/tomorrow message
  },
  access: {
    groupJids: [],   // groups the bot will respond in (meetup group is always
                     // allowed). DMs are owner-only — there is no DM list.
  },
};

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
    return structuredClone(DEFAULTS);
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  return {
    ...DEFAULTS,
    ...raw,
    meetup: { ...DEFAULTS.meetup, ...(raw.meetup || {}) },
    llm: { ...DEFAULTS.llm, ...(raw.llm || {}) },
    access: { ...DEFAULTS.access, ...(raw.access || {}) },
  };
}

export function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
