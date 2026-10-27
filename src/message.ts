// Pure helpers for reading Baileys messages: unwrapping ephemeral/view-once
// wrappers, extracting text, quoted-reply context, and image detection.
// Kept separate from the gateway so they can be unit-tested.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMsg = any;

export function unwrapMessage(m: AnyMsg): AnyMsg {
  let cur = m || {};
  for (let i = 0; i < 5; i++) {
    const inner =
      cur.ephemeralMessage?.message ||
      cur.viewOnceMessage?.message ||
      cur.viewOnceMessageV2?.message ||
      cur.documentWithCaptionMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

export function messageText(node: AnyMsg): string {
  const m = unwrapMessage(node);
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  );
}

export function extractText(msg: AnyMsg): string {
  return messageText(msg.message);
}

export interface QuotedContext {
  /** Text of the quoted message ('' when it has none, e.g. a bare image). */
  text: string;
  /** True when the quoted message contains an image. */
  hasImage: boolean;
  /** True when the quoted message is a voice note / audio. */
  hasAudio: boolean;
  /** The raw quoted message node (for media download), or null. */
  node: AnyMsg | null;
  /** contextInfo.stanzaId — the quoted message's id. */
  stanzaId: string;
  /** contextInfo.participant — JID/LID of the quoted message's author. */
  participant: string;
}

// If this message is a quoted reply, describe what it replies to.
// The contextInfo sits on the text/image/video node of THIS message.
export function extractQuoted(msg: AnyMsg): QuotedContext | null {
  const m = unwrapMessage(msg.message);
  const node = m.extendedTextMessage || m.imageMessage || m.videoMessage || m.documentMessage;
  const ctx = node?.contextInfo;
  if (!ctx || !ctx.quotedMessage) return null;
  const quoted = unwrapMessage(ctx.quotedMessage);
  return {
    text: messageText(ctx.quotedMessage).trim(),
    hasImage: Boolean(quoted.imageMessage),
    hasAudio: Boolean(quoted.audioMessage),
    node: ctx.quotedMessage,
    stanzaId: ctx.stanzaId || '',
    participant: ctx.participant || '',
  };
}

export function ownImageNode(msg: AnyMsg): AnyMsg | null {
  const m = unwrapMessage(msg.message);
  return m.imageMessage ? m : null;
}

// Voice notes and audio files both arrive as audioMessage (voice notes have
// ptt: true). Returns the unwrapped node when the message carries audio.
export function ownAudioNode(msg: AnyMsg): AnyMsg | null {
  const m = unwrapMessage(msg.message);
  return m.audioMessage ? m : null;
}

// JIDs @mentioned in this message (from contextInfo), raw as WhatsApp sent
// them — may be phone JIDs or LID JIDs, possibly with device suffixes.
export function mentionedJidsOf(msg: AnyMsg): string[] {
  const m = unwrapMessage(msg.message);
  const out: string[] = [];
  for (const node of Object.values(m)) {
    const list = (node as { contextInfo?: { mentionedJid?: unknown } } | null)?.contextInfo?.mentionedJid;
    if (Array.isArray(list)) for (const j of list) out.push(String(j));
  }
  return [...new Set(out)];
}
