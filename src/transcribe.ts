// Voice-note transcription via the same provider's Whisper endpoint
// (default whisper-large-v3-turbo, e.g. on Groq; override with
// WHISPER_MODEL). Returns the transcript text, or '' on any failure —
// a failed transcription just means the turn is skipped, never a crash.
//
// Language behaviour: Whisper auto-detects by default; set
// WHISPER_LANGUAGE to pin a language code (e.g. 'en', 'ur'). Auto-detect
// sometimes hears one language as a close relative and returns a script
// the brain can't act on — Urdu heard as Hindi comes back in Devanagari
// script, for example. If your speakers hit that, set
// WHISPER_RETRY_LANGUAGE to the language they actually speak (e.g.
// 'ur'): a transcript in Devanagari script then gets one retry pinned
// to that language.
import { fetch as undiciFetch, ProxyAgent, FormData } from 'undici';
import type { AgentConfig } from './types.js';

const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-large-v3-turbo';
const dispatcher = process.env.WA_USE_PROXY === '1'
  ? new ProxyAgent(process.env.WA_PROXY_URL || 'http://hatch-egress-proxy:3128')
  : undefined;

function extForMime(mime: string): string {
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('webm')) return 'webm';
  return 'ogg'; // WhatsApp voice notes are ogg/opus
}

async function transcribeOnce(cfg: AgentConfig, audio: Buffer, mime: string, language?: string): Promise<string> {
  const apiKey = process.env.LLM_API_KEY || '';
  if (!apiKey) return '';
  const apiBase = (process.env.LLM_API_BASE || cfg.llm.apiBase || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  try {
    const form = new FormData();
    form.append('model', WHISPER_MODEL);
    form.append('response_format', 'json');
    if (language) form.append('language', language);
    form.append('file', new File([new Uint8Array(audio)], `voice.${extForMime(mime || '')}`, { type: mime || 'audio/ogg' }));
    const res = await undiciFetch(`${apiBase}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      dispatcher,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.error(`transcription HTTP ${res.status}:`, (await res.text()).slice(0, 160));
      return '';
    }
    const data = (await res.json()) as { text?: string };
    return (data.text || '').trim();
  } catch (err) {
    console.error('transcription failed:', (err as Error).message);
    return '';
  }
}

export async function transcribeAudio(cfg: AgentConfig, audio: Buffer, mime: string): Promise<string> {
  let text = await transcribeOnce(cfg, audio, mime, process.env.WHISPER_LANGUAGE || undefined);
  // Mis-detection guard: a Devanagari transcript for speakers who don't
  // speak Hindi is Whisper hearing a related language wrong. Retry once
  // pinned to the configured real language when one is set.
  const retryLang = process.env.WHISPER_RETRY_LANGUAGE || '';
  if (retryLang && retryLang !== 'hi' && /[\u0900-\u097F]/.test(text)) {
    const retry = await transcribeOnce(cfg, audio, mime, retryLang);
    if (retry) text = retry;
  }
  return text;
}
