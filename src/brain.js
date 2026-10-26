// Conversation dispatcher. All conversation is handled by the AI brain
// (llm.js), which manages reminders and the meetup through tool calls.
// There are no hardcoded parsing rules here anymore.
import { llmReply } from './llm.js';

export async function handleMessage({ cfg, store, jid, isGroup, senderNumber, isOwner, senderName, text, groupContext, saveCfg }) {
  const t = (text || '').trim();
  if (!t) return [];
  const out = await llmReply(
    cfg, store,
    { jid, isGroup, isOwner, senderName, senderNumber, groupContext, saveCfg },
    t
  );
  if (out === null) return ["brain's off rn. try again in a bit"];
  return out;
}
