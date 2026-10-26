// Access control: who may talk to Octopus at all.
// - DMs: ONLY the owner, identified by phone number OR LID — WhatsApp
//   addresses chats either way, so both identifiers are accepted.
// - Groups: only allowlisted groups (plus the meetup group), where members
//   talk to the bot by mentioning it.
// Everyone else gets total silence: no reply, no LLM call, no quota spent.

// The owner's LID set: the pinned ownerLid plus any LID paired with the
// owner's number in a group's member list.
export function ownerLids(cfg, store) {
  const ids = new Set();
  if (store.ownerLid) ids.add(store.ownerLid);
  for (const g of Object.values(store.groups || {})) {
    for (const m of g.members || []) {
      if (m.pn === cfg.ownerNumber && m.lid) ids.add(m.lid);
    }
  }
  return ids;
}

export function isOwnerSender(cfg, store, senderNumber, senderLid) {
  if (senderNumber && cfg.ownerNumber && senderNumber === cfg.ownerNumber) return true;
  const ids = ownerLids(cfg, store);
  if (!ids.size) return false;
  // In LID-addressed chats the sender id itself is the LID digits.
  return Boolean((senderLid && ids.has(senderLid)) || (senderNumber && ids.has(senderNumber)));
}

export function isAllowed(cfg, store, { jid, isGroup, senderNumber, senderLid }) {
  if (isGroup) {
    const access = cfg.access || { groupJids: [] };
    if ((access.groupJids || []).includes(jid)) return true;
    if (cfg.meetup && cfg.meetup.groupJid && cfg.meetup.groupJid === jid) return true;
    return false;
  }
  // DM: owner only, by number or LID.
  return isOwnerSender(cfg, store, senderNumber, senderLid);
}
