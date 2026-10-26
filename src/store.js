import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

const STORE_PATH = join(ROOT, 'data', 'store.json');

const DEFAULTS = {
  reminders: [], // { id, jid, text, dueAt (epoch ms), repeat: null | 'daily' | weekday index, createdBy }
  meetupState: {
    date: '',        // PKT date string YYYY-MM-DD the state belongs to
    asked: false,    // daily ask posted
    status: 'idle',  // idle | pending | confirmed | missed
    missedPosted: false,
  },
  histories: {}, // per-chat LLM conversation memory: { [jid]: [{role, content}] }
  groups: {},    // per-group context: { [jid]: { name, desc, members: [{pn, lid, name, admin}], updatedAt } }
  contacts: {},  // display names by pn and by lid: { [id]: name } — from the phone's contact sync + pushNames
  ownerLid: '',  // owner's WhatsApp LID, learned from group messages
  nextId: 1,
};

export function loadStore() {
  if (!existsSync(STORE_PATH)) return structuredClone(DEFAULTS);
  try {
    return { ...structuredClone(DEFAULTS), ...JSON.parse(readFileSync(STORE_PATH, 'utf8')) };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveStore(store) {
  const tmp = `${STORE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, STORE_PATH);
}
