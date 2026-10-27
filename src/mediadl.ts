// Media download for hosts that sit behind a proxy — Baileys' own
// downloadMediaMessage fetches through Node's global fetch, which cannot
// use the npm undici ProxyAgent ("invalid onRequestStart method"), so on a
// proxied host image/voice downloads fail. This module does the HTTP via
// undici's fetch + ProxyAgent (the same pairing llm.ts uses), and
// reimplements the WhatsApp media decryption from Baileys' scheme —
// HKDF-SHA256 expansion of the media key to 112 bytes ("WhatsApp <Type>
// Keys"), iv = [0:16], cipherKey = [16:48], AES-256-CBC over the payload
// minus its 10-byte MAC trailer. HKDF output verified byte-identical to
// Baileys' rust-bridge implementation. Without WA_USE_PROXY the dispatcher
// is unset and downloads go direct, exactly like the rest of the agent.
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

const dispatcher = process.env.WA_USE_PROXY === '1'
  ? new ProxyAgent(process.env.WA_PROXY_URL || 'http://hatch-egress-proxy:3128')
  : undefined;

const HKDF_INFO: Record<string, string> = {
  image: 'Image',
  sticker: 'Image',
  product: 'Image',
  video: 'Video',
  gif: 'Video',
  audio: 'Audio',
  ptt: 'Audio',
  document: 'Document',
};

export interface MediaNode {
  url?: string;
  directPath?: string;
  mediaKey?: unknown;
  mimetype?: string;
}

export async function downloadMediaNode(media: MediaNode, type: string): Promise<Buffer> {
  const url = media.url || (media.directPath ? `https://mmg.whatsapp.net${media.directPath}` : '');
  if (!url) throw new Error('media node has no url/directPath');
  const mk = media.mediaKey;
  const keyBuf =
    mk instanceof Uint8Array ? Buffer.from(mk) :
    typeof mk === 'string' ? Buffer.from(mk, 'base64') :
    Buffer.alloc(0);
  if (!keyBuf.length) throw new Error('media node has no mediaKey');
  const expanded = Buffer.from(
    hkdfSync('sha256', keyBuf, Buffer.alloc(0), `WhatsApp ${HKDF_INFO[type] || 'Image'} Keys`, 112),
  );
  const iv = expanded.subarray(0, 16);
  const cipherKey = expanded.subarray(16, 48);
  const res = await undiciFetch(url, {
    headers: { Origin: 'https://web.whatsapp.com' },
    dispatcher,
  });
  if (!res.ok) throw new Error(`media HTTP ${res.status}`);
  const enc = Buffer.from(await res.arrayBuffer());
  if (enc.length <= 10) throw new Error('media payload too short');
  const data = enc.subarray(0, enc.length - 10); // strip the 10-byte MAC trailer
  const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
