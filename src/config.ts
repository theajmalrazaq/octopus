// Configuration. The dashboard (dashboard/) generates a config.js for you —
// or copy config.example.json to config.json and edit it by hand.
// Load order: config.js first, then config.json, then built-in defaults.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import type { AgentConfig } from './types.js';

const dir = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(dir, '..');
const CONFIG_JS = join(ROOT, 'config.js');
const CONFIG_JSON = join(ROOT, 'config.json');

export const DEFAULTS: AgentConfig = {
  botName: 'Nova',
  botNumber: '',
  ownerNumber: '',
  timezone: 'Asia/Karachi',
  llm: {
    enabled: true,
    model: 'openai/gpt-oss-120b',
    apiBase: 'https://api.groq.com/openai/v1',
  },
  persona: {
    gender: 'neutral',
    voiceNotes: '',
    ownerNotes: '',
  },
  timetable: {},
  meetup: {
    enabled: false,
    groupJid: '',
    askTime: '10:00',
    cutoffTime: '20:00',
  },
  access: {
    groupJids: [],
  },
};

function merge(raw: Partial<AgentConfig> | null | undefined): AgentConfig {
  const r = (raw || {}) as Partial<AgentConfig>;
  return {
    ...structuredClone(DEFAULTS),
    ...r,
    llm: { ...DEFAULTS.llm, ...(r.llm || {}) },
    persona: { ...DEFAULTS.persona, ...(r.persona || {}) },
    meetup: { ...DEFAULTS.meetup, ...(r.meetup || {}) },
    access: { ...DEFAULTS.access, ...(r.access || {}) },
    timetable: r.timetable || {},
  };
}

export async function loadConfig(): Promise<AgentConfig> {
  if (existsSync(CONFIG_JS)) {
    try {
      const mod = await import(pathToFileURL(CONFIG_JS).href);
      return merge((mod.default || mod) as Partial<AgentConfig>);
    } catch (err) {
      console.error('config.js failed to load, falling back:', (err as Error).message);
    }
  }
  if (!existsSync(CONFIG_JSON)) {
    writeFileSync(CONFIG_JSON, JSON.stringify(DEFAULTS, null, 2));
    return structuredClone(DEFAULTS);
  }
  return merge(JSON.parse(readFileSync(CONFIG_JSON, 'utf8')) as Partial<AgentConfig>);
}
