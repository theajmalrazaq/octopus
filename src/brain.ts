// Conversation dispatcher. All conversation is handled by the AI brain
// (llm.ts), which manages reminders and the meetup through tool calls.
// There are no hardcoded parsing rules here.
import { llmReply } from './llm.js';
import type { AgentConfig, MsgContext } from './types.js';

export async function handleMessage(cfg: AgentConfig, ctx: MsgContext, text: string): Promise<string[]> {
  const t = (text || '').trim();
  if (!t) return [];
  const out = await llmReply(cfg, ctx, t);
  if (out === null) return ["brain's off rn. try again in a bit"];
  return out;
}
