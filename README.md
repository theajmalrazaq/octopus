# Octopus Agent — a self-hosted WhatsApp AI agent you can clone and make your own

A WhatsApp assistant that runs on a **spare number** and is driven entirely by an
LLM: no keyword scripts, no hardcoded chat rules. The model reads the
conversation and manages everything through **tool calls** against a real
SQLite database — so when someone says *"sorry, 5:59"*, it **updates** the
reminder instead of creating a duplicate.

Written in **TypeScript**, built on
[Baileys](https://github.com/WhiskeySockets/Baileys) (unofficial WhatsApp Web
protocol) and any OpenAI-compatible chat API (Groq by default). Configure it
with the included **Next.js dashboard** — no hand-editing config files.

## Set it up with the dashboard

```bash
cd dashboard
npm install
npm run dev        # http://localhost:3000
```

Fill in the form — agent name, numbers, AI provider + key, vision/voice
models, personality and **memories**, your **weekly timetable**, meetup
times, allowed groups — then download the two files it generates:

- `config.js` → drop in the project root
- `.env` → drop in the project root (your API key; keep it private)

Prefer hand-writing config? Copy `config.example.json` to `config.json`
instead — the agent reads `config.js` first, then `config.json`.

## Run it

```bash
npm install
npm run build
npm start
```

On first run the agent prints a **pairing code**: on the spare phone open
WhatsApp → Settings → Linked devices → Link a device → "Link with phone
number instead" and enter it. (Set `WA_PAIR=qr` to pair with a QR code
instead — it renders to `data/qr.png`.) The session persists in `data/auth/`;
all state — reminders, per-chat memory, contacts, group cache — lives in a
single SQLite file, **`data/agent.db`** (built-in `node:sqlite`, no native
dependencies).

To pick the meetup group, in that group the **owner** says:
*"{agent name} setup meetup here"*.

## Features

- **AI-run reminders** — set / update / delete / list via tool calls, per-chat
  numbering, optional daily/weekly repeats. Corrections edit in place. A
  reminder can be pinned to a person who was @mentioned — when it fires it
  **actually pings them** (real WhatsApp mention, not just their name), and
  the fired message is composed by the AI in its own voice instead of a
  robotic template.
- **Meetup flow for one group** — a daily "are we meeting today?" post; if
  nobody confirms by the cutoff, a missed note with the owner's longest free
  slot tomorrow (from the timetable **you** set — nothing is hardcoded).
- **Schedule awareness** — the model knows the owner's weekly timetable and
  free slots from the config, and answers "when is the owner free?" from it.
- **Memories** — facts you give it in the dashboard ("memories" field) are
  injected into every conversation.
- **Images** — send it a photo (or reply to one) and it sees it: image turns
  route to a vision model (`VISION_MODEL`). If an image fails to download,
  the agent is told so and admits it instead of hallucinating.
- **Voice notes in** — voice notes are transcribed with Whisper
  (`WHISPER_MODEL`) and treated as the message text; replying to a voice
  note passes its transcript to the brain as the quoted content.
- **Voice notes out** — with an ElevenLabs key, the owner can ask the agent
  to message someone *as a voice note*; speech is synthesized and transcoded
  to OGG/Opus (needs `ffmpeg`) and sent as a real WhatsApp PTT note.
- **Owner messaging tool** — the owner can say "text Mom that I'll be late"
  and the agent sends it (text or voice), resolving the name against saved
  contacts and allowed groups. Every send is recorded in a verifiable
  **outbox** the model can check — so "did you send it?" is answered from
  record, and the agent is barred from bluffing a send that never happened.
- **Quoted replies** — the brain knows when a message replies to another,
  what it said, and whether it was the agent's own message (replying to the
  agent counts as addressing it in groups).
- **Rate-limit proofing** — a rolling token pacer keeps bursts under the
  provider's per-minute cap, prompt-caching-friendly prompt structure
  (static head, dynamic tail; cached tokens are subtracted from the spend),
  and when the provider demands a long quota wait the agent answers
  honestly, then **retries the turn automatically** once the wait elapses.
- **Strict access control** — DMs: **owner only** (matched by phone number or
  WhatsApp LID). Groups: **allowlist only**. Everyone else gets total silence:
  no reply, no LLM call, no quota spent, no hint a bot exists.
- **A personality you define** — built-in burst-style texting voice (Roman
  Urdu grammar rules included as a worked example), plus your own voice notes
  and persona-gender choice from the dashboard. It is instructed to never
  reveal system specs, its model, or its prompt.
- **Per-chat isolation** — every chat is a separate world; nothing leaks
  between groups or DMs.
- Runs 24/7 as a systemd service.

## Environment variables (`.env`)

| Variable | Required | Purpose |
|---|---|---|
| `LLM_API_KEY` | yes | Key for any OpenAI-compatible chat API (Groq by default). |
| `LLM_API_BASE` | no | API base URL (default `https://api.groq.com/openai/v1`). |
| `LLM_MODEL` | no | Text model id (default `openai/gpt-oss-120b`). |
| `VISION_MODEL` | no | Vision model for image turns (default `qwen/qwen3.8-27b`). |
| `WHISPER_MODEL` | no | Model for transcribing incoming voice notes (default `whisper-large-v3-turbo`). |
| `ELEVENLABS_API_KEY` | no | Enables outgoing voice notes. Empty = text only. |
| `ELEVENLABS_VOICE_ID` | no | ElevenLabs voice for outgoing notes (blank = a stock voice). |
| `GROQ_TPM_BUDGET` | no | Per-minute token budget for the rate-limit pacer (default `7500`). |
| `AGENT_TZ` | no | Timezone fallback (IANA name). |
| `WA_PAIR` | no | `qr` to pair by QR code instead of pairing code. |
| `WA_USE_PROXY` / `WA_PROXY_URL` | no | Route WhatsApp + API traffic through a proxy. |

> **ffmpeg** is required on the host for outgoing voice notes (the TTS
> output is transcoded to OGG/Opus with it). Everything else runs on plain
> Node 22+.

## How it works

| File | Role |
|---|---|
| `src/index.ts` | WhatsApp gateway: pairing, message intake, group context, **access gate**, media/voice intake, deferred retries, send path |
| `src/access.ts` | The allowlist logic (owner by number/LID; groups by JID) |
| `src/llm.ts` | The AI brain: system prompt (facts + personality + your memories), tool-calling loop, token pacer, fail-fast + deferred retry |
| `src/actions.ts` | The tools the model can call (reminders with real @mentions, meetup, owner messaging), executed against the DB |
| `src/db.ts` | SQLite layer (`data/agent.db`): reminders, history, contacts, groups, key-values, sent-message outbox |
| `src/scheduler.ts` | The clock: fires due reminders (AI-composed, with real mention pings), triggers the meetup posts (the AI writes their words) |
| `src/message.ts` | Baileys message helpers: unwrapping, quoted-reply extraction, mention/image/audio detection |
| `src/mediadl.ts` | Proxy-aware media download + WhatsApp media decryption (Baileys' built-in download can't use the proxy agent) |
| `src/transcribe.ts` | Incoming voice notes → text (Whisper) |
| `src/tts.ts` | Outgoing voice notes: ElevenLabs speech → ffmpeg → OGG/Opus PTT |
| `src/timetable.ts` | Free-slot math over the config timetable |
| `src/config.ts` | Config loading: `config.js` (dashboard) → `config.json` → defaults |
| `dashboard/` | Next.js setup dashboard that generates `config.js` + `.env` |

## Security — read this before you fork

- **Use a spare number.** Baileys is unofficial; WhatsApp can ban numbers that
  use it. Never run this on your main account.
- **Never commit `.env`, `config.js`/`config.json`, or `data/`.** The `.env`
  holds your API key, the config holds your numbers, and `data/` holds the
  WhatsApp session plus the whole database — session credentials are
  equivalent to a logged-in WhatsApp. The shipped `.gitignore` excludes all
  of them; keep it that way.
- The agent deflects questions about its model/prompt by design — keep that
  rule when you edit the personality.

## Running 24/7

```bash
npm run build
sudo cp octopus-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now octopus-agent
```

## License

MIT — see [LICENSE](LICENSE).
