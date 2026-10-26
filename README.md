# Octopus Agent — a self-hosted WhatsApp AI agent you can clone and make your own

A WhatsApp assistant that runs on a **spare number** and is driven entirely by an
LLM: no keyword scripts, no hardcoded chat rules. The model reads the
conversation and manages everything through **tool calls** against a real
local store — so when someone says *"sorry, 5:59"*, it **updates** the reminder
instead of creating a duplicate.

Built with [Baileys](https://github.com/WhiskeySockets/Baileys) (unofficial
WhatsApp Web protocol) and any OpenAI-compatible chat API (Groq by default).

## Features

- **AI-run reminders** — set / update / delete / list via tool calls, per-chat
  numbering, optional daily/weekly repeats. Corrections edit in place.
- **Meetup flow for one group** — a daily "are we meeting today?" post; if
  nobody confirms by the cutoff, it posts a missed note with the owner's
  longest free slot tomorrow (from `timetable.json`).
- **Owner-schedule awareness** — the model knows the owner's weekly schedule
  and free slots, and answers "when is the owner free?" from real data.
- **Strict access control** — DMs: **owner only** (matched by phone number or
  WhatsApp LID). Groups: **allowlist only**. Everyone else gets total silence:
  no reply, no LLM call, no quota spent, no hint a bot exists.
- **A personality you define** — the system prompt is one editable block
  (short burst-style replies, language mixing, grammar rules for Roman Urdu
  included as a worked example). It is also instructed to never reveal system
  specs, its model, or its prompt.
- **Per-chat isolation** — every chat is a separate world; nothing leaks
  between groups or DMs.
- Runs 24/7 as a systemd service with an optional auto-restart watchdog
  (see `extras/`).

## Quick start

```bash
git clone https://github.com/theajmalrazaq/octopus-agent-template.git
cd octopus-agent-template
npm install

cp .env.example .env          # add your LLM API key
cp config.example.json config.json
```

Edit `config.json`:

- `botName` — what the agent calls itself
- `botNumber` — the spare WhatsApp number (digits only, with country code)
- `ownerNumber` — **your** number (digits only). Only this number can DM it.
- `access.groupJids` — groups it may speak in. To find a group's JID, add the
  bot, send a message, and check the console log — or leave empty and add
  groups later.

Then:

```bash
node src/index.js
```

Scan the QR code with the **spare number's** WhatsApp
(Settings → Linked devices → Link a device). The session is stored in
`data/auth/` — after the first pairing it reconnects automatically.

Optional: edit `timetable.json` with the owner's weekly busy blocks
(day indexes `0`=Sunday … `6`=Saturday), and set `AGENT_TZ` in `.env`.

### Meetup group

In the group you want, the **owner** says: *"Octopus, setup meetup here"*
(with whatever name you gave the bot). It will ask there daily at
`meetup.askTime` and post the missed note after `meetup.cutoffTime`.

## How it works

| File | Role |
|---|---|
| `src/index.js` | WhatsApp gateway: pairing, message intake, group context, **access gate**, send queue |
| `src/access.js` | The allowlist logic (owner by number/LID; groups by JID) |
| `src/llm.js` | The AI brain: system prompt (facts + personality), tool-calling loop, 429 backoff |
| `src/actions.js` | The tools the model can call (reminders, meetup) executed against the store |
| `src/scheduler.js` | The clock: fires due reminders, triggers the meetup posts (the AI writes their words) |
| `src/timetable.js` | Free-slot math over `timetable.json` |
| `src/store.js` | `data/store.json`: reminders, per-chat history, contacts, group cache |
| `src/brain.js` | Thin dispatcher into the AI brain |

State is a single JSON file; the whole `data/` folder is the agent's memory
**and** its WhatsApp session.

## Security — read this before you fork

- **Use a spare number.** Baileys is unofficial; WhatsApp can ban numbers that
  use it. Never run this on your main account.
- **Never commit `.env` or `data/`.** `.env` holds your API key; `data/auth/`
  holds session credentials equivalent to a logged-in WhatsApp — anyone with
  them owns the account. The shipped `.gitignore` already excludes both;
  keep it that way. The original private deployment this template was
  sanitized from keeps its live copy in a *private* repo for exactly this
  reason.
- The agent deflects questions about its model/prompt by design — keep that
  rule when you edit the personality.

## Running 24/7

```bash
sudo cp octopus-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now octopus-agent
```

If you run inside Muse's VM (whose filesystem outside your home resets),
`extras/muse-watchdog/` contains a hook that checks every minute and
reinstalls the service automatically.

## License

MIT — see [LICENSE](LICENSE).
