// Voice-note transcription via the same provider's Whisper endpoint
// (default whisper-large-v3-turbo, e.g. on Groq; override with
// WHISPER_MODEL). Returns the transcript text, or '' on any failure —
// a failed transcription just means the turn is skipped, never a crash.
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

export async function transcribeAudio(cfg: AgentConfig, audio: Buffer, mime: string): Promise<string> {
  const apiKey = process.env.LLM_API_KEY || '';
  if (!apiKey) return '';
  const apiBase = (process.env.LLM_API_BASE || cfg.llm.apiBase || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  try {
    const form = new FormData();
    form.append('model', WHISPER_MODEL);
    form.append('response_format', 'json');
    form.append('file', new File([new Uint8Array(audio)], `voice.${extForMime(mime || '')}`, { type: mime || 'audio/ogg' }));
    const res = await undiciFetch(`${apiBase}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      dispatcher,
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
