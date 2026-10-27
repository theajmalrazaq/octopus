// WhatsApp gateway (Baileys): pairing, connection lifecycle, message intake,
// group-context caching, the access gate, and the send path. All conversation
// decisions live in the AI brain; this file is transport + guardrails.
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { HttpsProxyAgent } from 'https-proxy-agent';
import QRCode from 'qrcode';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ROOT } from './config.js';
import {
  contactCount, getContact, getGroup, getMeetupGroupJid, getOwnerLid, setContact, setGroup, setOwnerLid,
} from './db.js';
import { handleMessage } from './brain.js';
import { synthesizeVoice } from './tts.js';
import { extractQuoted, extractText, mentionedJidsOf, ownAudioNode, ownImageNode, unwrapMessage } from './message.js';
import { transcribeAudio } from './transcribe.js';
import { downloadMediaNode } from './mediadl.js';
import { isAllowed, isOwnerSender } from './access.js';
import { llmCompose } from './llm.js';
import { runScheduler } from './scheduler.js';
import { setTimezone } from './time.js';
import type { GroupInfo, MsgContext } from './types.js';

// Baileys' runtime message shape is wider than its public types
// (participantPn, lid fields) — treat raw protocol objects as any at the edge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMsg = any;

const cfg = await loadConfig();
setTimezone(cfg.timezone || process.env.AGENT_TZ || 'Asia/Karachi');
const logger = pino({ level: 'silent' });

let sock: ReturnType<typeof makeWASocket> | null = null;
let botJid = '';
let botLid = '';
let pairingRequested = false;
let isRegistered = false;

function isMentioned(msg: AnyMsg): boolean {
  const m = unwrapMessage(msg.message);
  const ctxInfo =
    m?.extendedTextMessage?.contextInfo ||
    m?.imageMessage?.contextInfo ||
    m?.videoMessage?.contextInfo;
  const mentioned: string[] = ctxInfo?.mentionedJid || [];
  const mine = [botJid.split('@')[0], botLid].filter(Boolean);
  return mentioned.some((j) => mine.includes(j.split('@')[0].split(':')[0]));
}

async function send(jid: string, text: string, mentions?: string[]): Promise<void> {
  if (!sock) return;
  try {
    await sock.sendMessage(jid, { text, ...(mentions && mentions.length ? { mentions } : {}) });
  } catch (e) {
    console.error('send failed', jid, (e as Error)?.message);
  }
}

// Outbound channel for the send_message tool: text, or a voice note
// synthesized on demand. Reports success/failure back to the brain.
async function sendOut(jid: string, payload: { text: string; voice: boolean }): Promise<{ ok: boolean; error?: string }> {
  if (!sock) return { ok: false, error: 'not connected' };
  try {
    if (payload.voice) {
      const ogg = await synthesizeVoice(payload.text);
      await sock.sendMessage(jid, { audio: ogg, ptt: true, mimetype: 'audio/ogg; codecs=opus' });
    } else {
      await sock.sendMessage(jid, { text: payload.text });
    }
    return { ok: true };
  } catch (e) {
    console.error('sendOut failed', jid, (e as Error)?.message);
    return { ok: false, error: (e as Error)?.message };
  }
}

// Fetch and cache a group's name, description and member list.
// Each group's context is stored under its own JID and only ever used there.
const GROUP_TTL_MS = 6 * 3600 * 1000;
async function refreshGroup(jid: string, force = false): Promise<void> {
  if (!sock || !jid.endsWith('@g.us')) return;
  const cached = getGroup(jid);
  if (!force && cached && Date.now() - (cached.updatedAt || 0) < GROUP_TTL_MS) return;
  try {
    const md = await sock.groupMetadata(jid);
    const members = (md.participants || []).map((p: AnyMsg) => {
      const pn = (p.phoneNumber || (p.id?.endsWith('@s.whatsapp.net') ? p.id : '') || '').split('@')[0];
      const lid = (p.lid || (p.id?.endsWith('@lid') ? p.id : '') || '').split('@')[0];
      const prev = cached?.members?.find((m) => (lid && m.lid === lid) || (pn && m.pn === pn));
      return {
        pn,
        lid,
        // Name sources, best first: learned from their messages, then the
        // synced contact book (saved name or the profile name they set).
        name: prev?.name || getContact(pn) || getContact(lid) || '',
        admin: Boolean(p.admin),
      };
    });
    const info: GroupInfo = {
      name: md.subject || '',
      desc: (md as AnyMsg).desc || '',
      members,
      updatedAt: Date.now(),
    };
    setGroup(jid, info);
    console.log(`group context cached for ${jid}: "${info.name}" (${members.length} members)`);
  } catch (e) {
    console.error('groupMetadata failed', jid, (e as Error)?.message);
  }
}

async function onMessage(msg: AnyMsg): Promise<void> {
  if (!msg.message || msg.key.fromMe) return;
  const jid: string = msg.key.remoteJid || '';
  if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) return;
  const isGroup = jid.endsWith('@g.us');
  // WhatsApp now addresses group members by LID; participantPn carries the
  // phone number when available. Learn the owner's LID when we see both.
  const participant: string = isGroup ? (msg.key.participant || '') : jid;
  const participantPn: string = isGroup ? (msg.key.participantPn || '') : jid;
  const senderNumber = participantPn.split('@')[0].split(':')[0];
  const senderLid = participant.endsWith('@lid') ? participant.split('@')[0] : '';
  if (senderLid && senderNumber && cfg.ownerNumber && senderNumber === cfg.ownerNumber) {
    if (getOwnerLid() !== senderLid) setOwnerLid(senderLid);
  }

  // Group context: keep the cache fresh and learn speakers' display names.
  let groupContext: GroupInfo | null = null;
  if (msg.pushName && senderNumber) {
    if (getContact(senderNumber) !== msg.pushName) setContact(senderNumber, msg.pushName);
    if (senderLid && getContact(senderLid) !== msg.pushName) setContact(senderLid, msg.pushName);
  }
  if (isGroup) {
    refreshGroup(jid).catch(() => {});
    const g = getGroup(jid);
    if (g) {
      const me = g.members.find((m) => (senderLid && m.lid === senderLid) || (senderNumber && m.pn === senderNumber));
      if (me && msg.pushName && me.name !== msg.pushName) {
        me.name = msg.pushName;
        setGroup(jid, g);
      }
      groupContext = g;
    }
  }

  // Other people @mentioned in this message (the bot excluded), with names —
  // so the brain knows who a request is about and can pin reminders to them.
  const mentions = mentionedJidsOf(msg)
    .filter((j) => {
      const d = j.split('@')[0].split(':')[0];
      return d && d !== botJid.split('@')[0] && d !== botLid && d !== cfg.botNumber;
    })
    .map((j) => {
      const d = j.split('@')[0].split(':')[0];
      const member = groupContext?.members.find((m) => m.lid === d || m.pn === d);
      return { jid: j, name: member?.name || getContact(d) || '' };
    });

  const raw = extractText(msg).trim();
  // Quoted replies: what message is this a reply to, and was it the bot's?
  const quoted = extractQuoted(msg);
  const quotedDigits = (quoted?.participant || '').split('@')[0].split(':')[0];
  const quotedFromBot = Boolean(quoted && quotedDigits &&
    [botJid.split('@')[0], botLid, cfg.botNumber].filter(Boolean).includes(quotedDigits));
  console.log(`msg from ${senderNumber} (${isGroup ? 'group ' + jid : 'dm'}): ${JSON.stringify(raw.slice(0, 80))}`);
  // A bare image with no caption still deserves a reaction; other empty
  // messages (stickers, reactions, calls) are ignored.
  if (!raw && !ownImageNode(msg) && !ownAudioNode(msg)) return;

  // Addressing rules: DM -> always; group -> mentioned, name-prefixed, or meetup group flow.
  // Mentions may reference the bot's phone number OR its LID.
  const nameLower = cfg.botName.toLowerCase();
  const rawLower = raw.toLowerCase();
  const startsWithName = rawLower.startsWith(nameLower);
  const mentionsBot =
    isMentioned(msg) ||
    (botLid && raw.includes(`@${botLid}`)) ||
    raw.includes(`@${botJid.split('@')[0]}`);
  const meetupJid = getMeetupGroupJid(cfg);
  const inMeetupGroup = cfg.meetup.enabled && Boolean(meetupJid) && meetupJid === jid;
  const meetupWord = /^(yes|yeah|yep|no|confirmed|done|met|we met|ok|okay|can'?t|cannot|not today)\b/i.test(raw);

  const audioNode = ownAudioNode(msg);
  if (!audioNode && isGroup && !mentionsBot && !startsWithName && !quotedFromBot && !(inMeetupGroup && meetupWord)) return;

  // Clean the text for the brain: drop leading @mentions and the bot's name.
  let text = raw.replace(/^@\d+\s*/g, '').trim();
  if (text.toLowerCase().startsWith(nameLower)) {
    text = text.slice(cfg.botName.length).replace(/^[\s,:-]+/, '');
  }

  const isOwner = isOwnerSender(cfg, senderNumber, senderLid);

  // Access gate: strangers get total silence — no reply, no LLM call.
  if (!isAllowed(cfg, { jid, isGroup, senderNumber, senderLid })) {
    console.log(`blocked: ${senderNumber} in ${isGroup ? 'group ' + jid : 'dm'} — not on the allowlist`);
    return;
  }

  // Voice notes (only after the gate, so strangers cost nothing): transcribe
  // and treat the transcript as the message text. In groups the addressing
  // rules are then applied to the transcript — a voice note that never
  // mentions the bot is none of its business.
  let voiceNote = false;
  let quotedText = quoted?.text || '';
  if (audioNode) {
    try {
      const buf = await downloadMediaNode(audioNode.audioMessage, 'audio');
      const transcript = await transcribeAudio(cfg, buf, audioNode.audioMessage?.mimetype || 'audio/ogg');
      if (!transcript) {
        if (!isGroup) await send(jid, 'voice note samajh nahi ayi.. dobara bhej do');
        return;
      }
      text = transcript;
      voiceNote = true;
      if (isGroup) {
        const t = text.toLowerCase();
        const addressed =
          quotedFromBot ||
          (botLid && text.includes(`@${botLid}`)) ||
          text.includes(`@${botJid.split('@')[0]}`) ||
          t.startsWith(nameLower) ||
          (inMeetupGroup && /^(yes|yeah|yep|no|confirmed|done|met|we met|ok|okay|can'?t|cannot|not today)\b/i.test(text));
        if (!addressed) return;
        text = text.replace(/^@\d+\s*/g, '').trim();
        if (text.toLowerCase().startsWith(nameLower)) {
          text = text.slice(cfg.botName.length).replace(/^[\s,:-]+/, '');
        }
      }
      console.log(`voice note from ${senderNumber} transcribed: ${JSON.stringify(text.slice(0, 80))}`);
    } catch (e) {
      console.error('voice note handling failed:', (e as Error)?.message);
      return;
    }
  } else if (quoted?.hasAudio && quoted.node) {
    // A text reply to a voice note ("what did they say?") — give the brain
    // the transcript as the quoted content.
    try {
      const qAudio = unwrapMessage(quoted.node)?.audioMessage;
      if (!qAudio) throw new Error('quoted audio node missing');
      const buf = await downloadMediaNode(qAudio, 'audio');
      const transcript = await transcribeAudio(cfg, buf, 'audio/ogg');
      if (transcript) quotedText = transcript;
    } catch (e) {
      console.error('quoted voice note transcription failed:', (e as Error)?.message);
    }
  }

  // Media (only after the gate, so strangers cost nothing): the message's own
  // image, or the image it quotes. Failures just mean a text-only turn —
  // except the brain is told (imageFailed), so it admits it can't see it
  // instead of hallucinating a description.
  let image: MsgContext['image'] = null;
  let imageFailed = false;
  try {
    if (ownImageNode(msg)) {
      const node = ownImageNode(msg)?.imageMessage;
      const buf = await downloadMediaNode(node, 'image');
      image = { base64: buf.toString('base64'), mime: node?.mimetype || 'image/jpeg' };
    } else if (quoted?.hasImage && quoted.node) {
      const qImg = unwrapMessage(quoted.node)?.imageMessage;
      if (!qImg) throw new Error('quoted image node missing');
      const buf = await downloadMediaNode(qImg, 'image');
      image = { base64: buf.toString('base64'), mime: qImg?.mimetype || 'image/jpeg' };
    }
  } catch (e) {
    imageFailed = Boolean(ownImageNode(msg) || quoted?.hasImage);
    console.error('media download failed:', (e as Error)?.message);
  }

  const ctx: MsgContext = {
    jid, isGroup, senderNumber, isOwner, groupContext,
    senderName: msg.pushName || '',
    quoted: quoted ? { text: quotedText, hasImage: quoted.hasImage, fromBot: quotedFromBot } : null,
    image,
    imageFailed,
    voiceNote,
    mentions,
  };
  // Deferred retry: when the brain is quota-blocked with a known wait, it
  // tells the chat it will try again after that long and hands the turn
  // here — re-run it once when the wait elapses. In-memory on purpose: a
  // restart during the wait drops the retry (acceptable, the owner can
  // simply re-ask).
  const defer = (delaySec: number): void => {
    console.log(`deferring turn in ${jid} by ${delaySec}s (quota)`);
    setTimeout(() => {
      void (async () => {
        try {
          const retryCtx: MsgContext = { ...ctx, deferredOnce: true };
          const out = await handleMessage(cfg, retryCtx, text, sendOut, defer);
          for (const r of out) await send(jid, r);
        } catch (e) {
          console.error('deferred retry failed', jid, (e as Error)?.message);
        }
      })();
    }, delaySec * 1000);
  };
  const replies = await handleMessage(cfg, ctx, text, sendOut, defer);
  for (const r of replies) await send(jid, r);
}

async function start(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(join(ROOT, 'data', 'auth'));
  // A paired account has creds.me set; creds.registered stays false after QR
  // pairing in current Baileys, so check both.
  isRegistered = Boolean(state.creds.registered || state.creds.me?.id);

  // Direct connection by default. Set WA_USE_PROXY=1 to route through a proxy
  // instead (WA_PROXY_URL or the standard *_PROXY env vars).
  const proxyUrl = process.env.WA_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || '';
  const agent = process.env.WA_USE_PROXY === '1' && proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  if (agent) console.log('Routing WhatsApp connection through the egress proxy.');

  sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '22.04'],
    agent,
  });

  sock.ev.on('creds.update', saveCreds);

  // Pairing: WA_PAIR=qr for QR-code mode (renders data/qr.png), otherwise
  // pairing-code mode. The code is requested once, a few seconds after the
  // socket starts (requesting during the handshake gets the connection closed).
  const pairMode = process.env.WA_PAIR === 'qr' ? 'qr' : 'code';
  if (!isRegistered && cfg.botNumber && !pairingRequested && pairMode === 'code') {
    pairingRequested = true;
    const s = sock;
    setTimeout(async () => {
      try {
        const code = await s.requestPairingCode(cfg.botNumber.replace(/\D/g, ''));
        writeFileSync(join(ROOT, 'data', 'pairing-code.txt'), code);
        console.log(`PAIRING CODE for ${cfg.botNumber}: ${code}`);
        console.log('Enter it in WhatsApp on the spare phone: Settings > Linked devices > Link a device > Link with phone number instead.');
      } catch (e) {
        console.error('pairing code request failed:', (e as Error)?.message);
        pairingRequested = false;
      }
    }, 3000);
  } else if (!isRegistered && !cfg.botNumber) {
    console.error('SETUP NEEDED: put the spare WhatsApp number in your config as botNumber, then restart.');
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && pairMode === 'qr') {
      try {
        await QRCode.toFile(join(ROOT, 'data', 'qr.png'), qr, { width: 512, margin: 2 });
        console.log('QR refreshed -> data/qr.png');
      } catch (e) {
        console.error('qr render failed:', (e as Error)?.message);
      }
    }
    if (connection === 'open') {
      isRegistered = true;
      const user = sock?.user as AnyMsg;
      botJid = (user?.id || '').split(':')[0] + '@s.whatsapp.net';
      botLid = (user?.lid || '').split(':')[0].split('@')[0];
      console.log(`CONNECTED as ${user?.id} (bot jid ${botJid}, lid ${botLid || 'none'})`);
    }
    if (connection === 'close') {
      const code = (lastDisconnect?.error as AnyMsg)?.output?.statusCode as number | undefined;
      const reason = (lastDisconnect?.error as Error)?.message || '';
      console.log(`connection closed (code ${code}${reason ? `: ${reason}` : ''})`);
      if (code === DisconnectReason.loggedOut && isRegistered) {
        console.error('LOGGED OUT. Delete data/auth and pair again.');
        process.exit(1);
      }
      // Tear the old socket down fully before replacing it — overlapping
      // sockets to WhatsApp kill each other ("connection replaced" loop).
      try {
        (sock?.ev as AnyMsg)?.removeAllListeners();
        sock?.end(new Error('reconnect'));
      } catch { /* already gone */ }
      // Pre-registration closes (incl. pairing hiccups) just reconnect,
      // and allow a fresh pairing code on the next connection.
      pairingRequested = false;
      console.log('reconnecting in 5s…');
      setTimeout(() => { void start(); }, 5000);
    }
  });

  sock.ev.on('group-participants.update', async ({ id }: { id: string }) => {
    try { await refreshGroup(id, true); } catch { /* ignore */ }
  });

  // Contact sync from the phone: the name each person has set (their profile
  // name) or their saved contact name, keyed by number and by LID.
  const onContacts = (contacts: AnyMsg[]): void => {
    let changed = false;
    for (const c of contacts || []) {
      const display: string = c.name || c.notify || c.verifiedName || '';
      if (!display) continue;
      const pn = (c.phoneNumber || (c.id?.endsWith('@s.whatsapp.net') ? c.id : '') || '').split('@')[0];
      const lid = (c.lid || (c.id?.endsWith('@lid') ? c.id : '') || '').split('@')[0];
      for (const k of [pn, lid]) {
        if (k && getContact(k) !== display) {
          setContact(k, display);
          changed = true;
        }
      }
    }
    if (changed) console.log(`contacts synced: ${contactCount()} named contacts`);
  };
  sock.ev.on('contacts.upsert', onContacts as AnyMsg);
  sock.ev.on('contacts.update', onContacts as AnyMsg);

  sock.ev.on('messages.upsert', async ({ messages, type }: { messages: AnyMsg[]; type: string }) => {
    console.log(`upsert type=${type} count=${messages.length}`);
    if (type !== 'notify') return;
    for (const msg of messages) {
      try { await onMessage(msg); } catch (e) { console.error('onMessage error', e); }
    }
  });
}

// Scheduler tick
setInterval(async () => {
  if (!sock) return;
  try {
    await runScheduler(cfg, {
      send,
      compose: (jid, instruction, groupContext) => llmCompose(cfg, jid, instruction, groupContext),
    });
  } catch (e) {
    console.error('scheduler error', e);
  }
}, 20000);

if (!existsSync(join(ROOT, 'data', 'auth'))) {
  console.log('No auth yet — pairing on first run.');
}
void start();
