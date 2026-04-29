#!/usr/bin/env bash
# Relay LaunchAgent installer
# Installs a macOS LaunchAgent that runs the Relay HTTP server at login
# and keeps it running across reboots/crashes.
#
# Usage:
#   bash scripts/install.sh

set -euo pipefail

LABEL="com.chuckjob.relay"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs"
LOG_PATH="${LOG_DIR}/relay.log"
ERR_PATH="${LOG_DIR}/relay.err.log"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="${REPO_ROOT}/server"
SERVER_JS="${SERVER_DIR}/server.js"

if [[ ! -f "$SERVER_JS" ]]; then
  echo "error: server entry not found at $SERVER_JS" >&2
  echo "  (run this from inside a checked-out relay repo)" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: 'node' not found on PATH" >&2
  echo "  install Node 18+ first (https://nodejs.org or 'brew install node')" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PLIST_PATH")"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${SERVER_JS}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${SERVER_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${LOG_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${ERR_PATH}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF

# Reload: unload if already loaded, then load fresh
launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl load "$PLIST_PATH"

# Quick health check
sleep 1
if curl -sf http://127.0.0.1:9226/health >/dev/null; then
  echo "Relay LaunchAgent installed and running."
  echo "  plist:  $PLIST_PATH"
  echo "  logs:   $LOG_PATH"
  echo "  health: http://127.0.0.1:9226/health"
  echo
  echo "The server will start automatically at login. To uninstall:"
  echo "  bash scripts/uninstall.sh"
else
  echo "warning: LaunchAgent installed but server isn't responding yet." >&2
  echo "  check the logs: tail -f $ERR_PATH" >&2
  exit 1
fi
