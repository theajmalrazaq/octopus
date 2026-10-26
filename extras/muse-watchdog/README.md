# Muse watchdog (optional)

Only relevant if you run the agent inside Muse's VM: VM replacements wipe
`/etc/systemd`, silently killing the service while everything in your home
directory (code, `data/`, session) survives.

`octopus-watchdog.sh` is a Muse hook script: it polls every 60 seconds and
wakes the agent only when the service is down. The woken agent reinstalls the
unit from the copy in your workspace, starts it, and verifies the WhatsApp
connection. Copy it to `~/hooks/scripts/` and register it with the hooks
tool (60s poll); adjust the service name if yours differs.

On a normal server you don't need this — the systemd unit already has
`Restart=always`.
