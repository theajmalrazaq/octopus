// Text-to-speech for outgoing voice notes. Provider: ElevenLabs (your key
// in .env) with the multilingual model, which handles mixed-language text
// in the agent's voice. Output is transcoded with ffmpeg to OGG/Opus — the
// container WhatsApp requires for real PTT voice notes. ffmpeg must be on
// the PATH for voice notes out; without an ELEVENLABS_API_KEY the feature
// simply stays off.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// undici's own fetch — the global fetch rejects a ProxyAgent built by a
// different undici version (same constraint as llm.ts).
import { fetch as undiciFetch, ProxyAgent } from 'undici';

const execFileP = promisify(execFile);

function loadDotEnv(): void {
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
}
loadDotEnv();

const API_KEY = process.env.ELEVENLABS_API_KEY || '';
// Default: a stock ElevenLabs preset voice. Pick any voice from your
// ElevenLabs library and override with ELEVENLABS_VOICE_ID.
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'cgSgspJ2msm6clMCkdW9';
const MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
const dispatcher = process.env.WA_USE_PROXY === '1'
  ? new ProxyAgent(process.env.WA_PROXY_URL || 'http://hatch-egress-proxy:3128')
  : undefined;

export function ttsConfigured(): boolean {
  return Boolean(API_KEY);
}

/** Synthesize text into an OGG/Opus buffer ready for a WhatsApp voice note. */
export async function synthesizeVoice(text: string): Promise<Buffer> {
  if (!API_KEY) throw new Error('ELEVENLABS_API_KEY not set');
  const res = await undiciFetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': API_KEY },
      body: JSON.stringify({
        text,
        model_id: MODEL,
        voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.2 },
      }),
      dispatcher,
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
  const mp3 = Buffer.from(await res.arrayBuffer());
  if (!mp3.length) throw new Error('ElevenLabs returned no audio');
  const stamp = `${process.pid}-${Date.now()}`;
  const inFile = path.join(os.tmpdir(), `octopus-tts-${stamp}.mp3`);
  const outFile = path.join(os.tmpdir(), `octopus-tts-${stamp}.ogg`);
  try {
    fs.writeFileSync(inFile, mp3);
    await execFileP('ffmpeg', ['-y', '-loglevel', 'error', '-i', inFile, '-ar', '48000', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', outFile]);
    return fs.readFileSync(outFile);
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}
