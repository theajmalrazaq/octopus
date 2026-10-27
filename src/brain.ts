// Conversation dispatcher. All conversation is handled by the AI brain
// (llm.ts), which manages reminders and the meetup through tool calls.
// There are no hardcoded parsing rules here.
import { llmReply } from './llm.js';
import type { SendOut } from './actions.js';
import type { AgentConfig, MsgContext } from './types.js';

export async function handleMessage(cfg: AgentConfig, ctx: MsgContext, text: string, sendOut?: SendOut, defer?: (delaySec: number) => void): Promise<string[]> {
  const t = (text || '').trim();
  // Empty text is fine when the turn carries an image or a quoted reply.
  if (!t && !ctx.image && !ctx.quoted) return [];
  const out = await llmReply(cfg, ctx, t, sendOut, defer);
  if (out === null) return ["brain's off rn. try again in a bit"];
  return out;
}
