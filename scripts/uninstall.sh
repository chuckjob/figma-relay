#!/usr/bin/env bash
# Relay LaunchAgent uninstaller
# Stops and removes the LaunchAgent installed by scripts/install.sh.

set -euo pipefail

LABEL="com.chuckjob.relay"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [[ -f "$PLIST_PATH" ]]; then
  launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
  rm -f "$PLIST_PATH"
  echo "Relay LaunchAgent removed."
else
  echo "Relay LaunchAgent isn't installed (no plist at $PLIST_PATH)."
fi
