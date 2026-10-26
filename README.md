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

Fill in the form — agent name, numbers, AI provider + key, personality and
**memories**, your **weekly timetable**, meetup times, allowed groups — then
download the two files it generates:

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
  numbering, optional daily/weekly repeats. Corrections edit in place.
- **Meetup flow for one group** — a daily "are we meeting today?" post; if
  nobody confirms by the cutoff, a missed note with the owner's longest free
  slot tomorrow (from the timetable **you** set — nothing is hardcoded).
- **Schedule awareness** — the model knows the owner's weekly timetable and
  free slots from the config, and answers "when is the owner free?" from it.
- **Memories** — facts you give it in the dashboard ("memories" field) are
  injected into every conversation.
- **Strict access control** — DMs: **owner only** (matched by phone number or
  WhatsApp LID). Groups: **allowlist only**. Everyone else gets total silence:
  no reply, no LLM call, no quota spent, no hint a bot exists.
- **A personality you define** — built-in burst-style texting voice (Roman
  Urdu grammar rules included as a worked example), plus your own voice notes
  and persona-gender choice from the dashboard. It is instructed to never
  reveal system specs, its model, or its prompt.
- **Per-chat isolation** — every chat is a separate world; nothing leaks
  between groups or DMs.
- Runs 24/7 as a systemd service, with an optional auto-restart watchdog
  (see `extras/`).

## How it works

| File | Role |
|---|---|
| `src/index.ts` | WhatsApp gateway: pairing, message intake, group context, **access gate**, send queue |
| `src/access.ts` | The allowlist logic (owner by number/LID; groups by JID) |
| `src/llm.ts` | The AI brain: system prompt (facts + personality + your memories), tool-calling loop, 429 backoff |
| `src/actions.ts` | The tools the model can call (reminders, meetup), executed against the DB |
| `src/db.ts` | SQLite layer (`data/agent.db`): reminders, history, contacts, groups, key-values |
| `src/scheduler.ts` | The clock: fires due reminders, triggers the meetup posts (the AI writes their words) |
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

If you run inside Muse's VM (whose filesystem outside your home resets),
`extras/muse-watchdog/` contains a hook that checks every minute and
reinstalls the service automatically.

## License

MIT — see [LICENSE](LICENSE).
