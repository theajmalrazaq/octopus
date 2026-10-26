// Access control: who may talk to the agent at all.
// - DMs: ONLY the owner, identified by phone number OR LID — WhatsApp
//   addresses chats either way, so both identifiers are accepted.
// - Groups: only allowlisted groups (plus the meetup group), where members
//   talk to the agent by mentioning it.
// Everyone else gets total silence: no reply, no LLM call, no quota spent.
import type { AgentConfig } from './types.js';
import { allGroups, getMeetupGroupJid, getOwnerLid } from './db.js';

// The owner's LID set: the learned owner LID plus any LID paired with the
// owner's number in a cached group's member list.
export function ownerLids(cfg: AgentConfig): Set<string> {
  const ids = new Set<string>();
  const pinned = getOwnerLid();
  if (pinned) ids.add(pinned);
  for (const g of allGroups()) {
    for (const m of g.members || []) {
      if (m.pn === cfg.ownerNumber && m.lid) ids.add(m.lid);
    }
  }
  return ids;
}

export function isOwnerSender(cfg: AgentConfig, senderNumber: string, senderLid: string): boolean {
  if (senderNumber && cfg.ownerNumber && senderNumber === cfg.ownerNumber) return true;
  const ids = ownerLids(cfg);
  if (!ids.size) return false;
  // In LID-addressed chats the sender id itself is the LID digits.
  return Boolean((senderLid && ids.has(senderLid)) || (senderNumber && ids.has(senderNumber)));
}

export function isAllowed(
  cfg: AgentConfig,
  args: { jid: string; isGroup: boolean; senderNumber: string; senderLid: string },
): boolean {
  if (args.isGroup) {
    if ((cfg.access.groupJids || []).includes(args.jid)) return true;
    const meetupJid = getMeetupGroupJid(cfg);
    if (meetupJid && meetupJid === args.jid) return true;
    return false;
  }
  // DM: owner only, by number or LID.
  return isOwnerSender(cfg, args.senderNumber, args.senderLid);
}
