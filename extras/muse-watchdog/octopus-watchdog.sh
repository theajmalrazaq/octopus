#!/usr/bin/env bash
# Muse hook: Octopus Agent (systemd service) must run 24/7.
# Muse VM replacements wipe /etc/systemd and kill the service silently.
# Wake when the unit file is missing or the service is not active.
# Install: copy to ~/hooks/scripts/, register with the hooks tool (poll 60s),
# with a worker prompt that reinstalls the unit from the workspace copy.
set -uo pipefail
source "$HATCH_HOOK_RUNTIME"

UNIT="/etc/systemd/system/octopus-agent.service"

if [[ -f "$UNIT" ]] && systemctl is-active --quiet octopus-agent.service 2>/dev/null; then
  silent "octopus agent running" "{}"
  exit 0
fi

log "octopus_down" "{\"unit_file_present\": $([[ -f "$UNIT" ]] && echo true || echo false)}"
wake "octopus_down" "{}"
exit 0
