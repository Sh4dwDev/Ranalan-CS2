#!/bin/bash
# Installs or updates Ranalan on the game server machine. Safe to run again.
# Run as root from the unpacked folder: bash deploy/install.sh
set -euo pipefail

# For another LAN, change these here or set them when running: HOST_IP=10.0.0.5 bash deploy/install.sh
HOST_IP=${HOST_IP:-10.0.1.81}
SITE_PORT=${SITE_PORT:-8088}
ADMIN_ID=${ADMIN_ID:-76561198398925364}
VOLUMES=${VOLUMES:-/var/lib/pterodactyl/volumes}

# id | name | Pterodactyl UUID | game port | GOTV port
SERVERS=(
  "wingman1|Wingman 1|f40a5013-0de9-4818-972d-d9a686748b6c|25567|25568"
  "wingman2|Wingman 2|a695f1e6-6981-4eb9-9dc1-96ecc4f5e784|25569|25570"
)

cd "$(dirname "$0")/.."

if ! docker version >/dev/null 2>&1; then
  echo "STOPPED: docker is not available on this machine. Nothing was changed."
  exit 1
fi
for ENTRY in "${SERVERS[@]}"; do
  IFS='|' read -r _ NAME UUID _ _ <<< "$ENTRY"
  if [ ! -d "$VOLUMES/$UUID/game/csgo" ]; then
    echo "STOPPED: could not find $NAME at $VOLUMES/$UUID/game/csgo. Nothing was changed."
    exit 1
  fi
done

# The key proves that match events really come from our game servers.
EVENTS_KEY=$(sed -n 's/^EVENTS_KEY=//p' .env 2>/dev/null || true)
[ -n "$EVENTS_KEY" ] || EVENTS_KEY=$(openssl rand -hex 24)

# The panel address and API key let the site turn servers on and off. Asked for once,
# with the key hidden, and kept only in this machine's .env file.
PANEL_URL=$(sed -n 's/^PANEL_URL=//p' .env 2>/dev/null || true)
PANEL_API_KEY=$(sed -n 's/^PANEL_API_KEY=//p' .env 2>/dev/null || true)
if [ -z "$PANEL_API_KEY" ] && [ -t 0 ]; then
  echo "To turn servers on and off, the site needs your Pterodactyl panel's address and an API key."
  echo "Press Enter on both to skip this for now."
  read -r -p "Panel address (like https://panel.example.com): " PANEL_URL
  read -r -s -p "API key (hidden as you type): " PANEL_API_KEY
  echo
fi

touch .env
chmod 600 .env
cat > .env <<EOF
BASE_URL=http://$HOST_IP:$SITE_PORT
ADMIN_STEAM_IDS=$ADMIN_ID
EVENTS_KEY=$EVENTS_KEY
PANEL_URL=$PANEL_URL
PANEL_API_KEY=$PANEL_API_KEY
EOF

# Reads a value saved for one server in servers.json, if it's there.
saved_value() {
  [ -f servers.json ] || return 0
  sed -n "/\"id\": \"$1\"/,/}/s/.*\"$2\": \"\(.*\)\".*/\1/p" servers.json | head -1
}

# Passwords are made here and never shown, and each server keeps its own between installs.
setup_server() {
  local ID=$1 UUID=$2 GOTV_PORT=$3 PASSWORD=$4 GOTV_PASSWORD=$5
  local GAME=$VOLUMES/$UUID/game/csgo

  local CFG=$GAME/cfg/server.cfg
  [ -f "$CFG.bak-ranalan" ] || cp "$CFG" "$CFG.bak-ranalan"
  sed -i '/^rcon_password/d;/^sv_hibernate_when_empty/d;/^tv_enable/d;/^tv_port/d;/^tv_delay/d;/^tv_maxclients/d;/^tv_password/d;/^sv_deltaticks_enforce/d' "$CFG"
  # A hibernating server can't be reached with RCON, and the site needs that to load matches.
  # Without sv_deltaticks_enforce 0, GOTV viewers get "Client delta ticks out of order".
  # GOTV runs 90 seconds behind, and is locked with a password only admins see on the site.
  printf '\nrcon_password "%s"\nsv_hibernate_when_empty 0\ntv_enable 1\ntv_port %s\ntv_delay 90\ntv_maxclients 10\ntv_password "%s"\nsv_deltaticks_enforce 0\n' \
    "$PASSWORD" "$GOTV_PORT" "$GOTV_PASSWORD" >> "$CFG"
  chown pterodactyl:pterodactyl "$CFG" "$CFG.bak-ranalan"

  # The wingman game mode config loads after server.cfg and sets its own tv_delay 60,
  # so the delay is set again in its _server file, which loads last. The map change
  # waits for GOTV to catch up, so viewers see the end of every map.
  local MODE_CFG=$GAME/cfg/gamemode_competitive2v2_server.cfg
  touch "$MODE_CFG"
  sed -i '/^tv_delay[[:space:]]/d;/^tv_delaymapchange[[:space:]]/d' "$MODE_CFG"
  printf 'tv_delay 90\ntv_delaymapchange 1\n' >> "$MODE_CFG"
  chown pterodactyl:pterodactyl "$MODE_CFG"

  # The old vote plugin would lock teams on its own and clash with matches from the site.
  # It is moved aside, not deleted.
  local PLUGIN=$GAME/addons/counterstrikesharp/plugins/WarmupMapVote
  if [ -d "$PLUGIN" ]; then
    mkdir -p "/root/ranalan-backup/$ID"
    rm -rf "/root/ranalan-backup/$ID/WarmupMapVote"
    mv "$PLUGIN" "/root/ranalan-backup/$ID/"
  fi

  local MZ=$GAME/cfg/MatchZy/config.cfg
  if [ -f "$MZ.bak-vote" ]; then
    cp "$MZ.bak-vote" "$MZ"
  fi

  # Sends match events to the site. The high ready count stops admins on the empty
  # server from starting a match by accident: matches from the site don't use it.
  [ -f "$MZ.bak-ranalan" ] || cp "$MZ" "$MZ.bak-ranalan"
  sed -i '/^matchzy_kick_when_no_match_loaded/d;/^matchzy_remote_log_/d;/^matchzy_minimum_ready_required/d' "$MZ"
  cat >> "$MZ" <<EOF

matchzy_minimum_ready_required 64
matchzy_remote_log_url "http://$HOST_IP:$SITE_PORT/matchzy/events"
matchzy_remote_log_header_key "X-Ranalan-Key"
matchzy_remote_log_header_value "$EVENTS_KEY"
EOF
  chown pterodactyl:pterodactyl "$MZ" "$MZ.bak-ranalan"

  # MatchZy's live configs remove all bots, which ended round 1 of test matches early.
  # RanalanGate keeps bots at 0 outside test matches, so real matches still have none.
  local LIVE
  for LIVE in "$GAME/cfg/MatchZy/live.cfg" "$GAME/cfg/MatchZy/live_wingman.cfg"; do
    if [ -f "$LIVE" ]; then
      [ -f "$LIVE.bak-ranalan" ] || cp "$LIVE" "$LIVE.bak-ranalan"
      sed -i '/^bot_quota[[:space:]]/d;/^bot_kick/d' "$LIVE"
      chown pterodactyl:pterodactyl "$LIVE" "$LIVE.bak-ranalan"
    fi
  done

  # Keeps the server closed: only admins and the loaded match's players may stay on it.
  local GATE_DIR=$GAME/addons/counterstrikesharp/plugins/RanalanGate
  local GATE_CFG=$GAME/addons/counterstrikesharp/configs/plugins/RanalanGate
  mkdir -p "$GATE_DIR" "$GATE_CFG"
  cp deploy/RanalanGate.dll "$GATE_DIR/"
  cat > "$GATE_CFG/RanalanGate.json" <<EOF
{
  "SiteUrl": "http://$HOST_IP:$SITE_PORT",
  "Key": "$EVENTS_KEY",
  "ServerId": "$ID",
  "RecheckSeconds": 30,
  "ConfigVersion": 1
}
EOF
  chmod 600 "$GATE_CFG/RanalanGate.json"
  chown -R pterodactyl:pterodactyl "$GATE_DIR" "$GATE_CFG"
}

# Passwords are read before servers.json gets rewritten below.
SERVERS_JSON=""
for ENTRY in "${SERVERS[@]}"; do
  IFS='|' read -r ID NAME UUID PORT GOTV_PORT <<< "$ENTRY"
  PASSWORD=$(saved_value "$ID" rconPassword)
  [ -n "$PASSWORD" ] || PASSWORD=$(openssl rand -hex 24)
  GOTV_PASSWORD=$(saved_value "$ID" gotvPassword)
  [ -n "$GOTV_PASSWORD" ] || GOTV_PASSWORD=$(openssl rand -hex 8)

  setup_server "$ID" "$UUID" "$GOTV_PORT" "$PASSWORD" "$GOTV_PASSWORD"

  [ -z "$SERVERS_JSON" ] || SERVERS_JSON+=","
  SERVERS_JSON+="
  {
    \"id\": \"$ID\",
    \"name\": \"$NAME\",
    \"host\": \"$HOST_IP\",
    \"port\": $PORT,
    \"gotvPort\": $GOTV_PORT,
    \"gotvPassword\": \"$GOTV_PASSWORD\",
    \"mode\": \"wingman\",
    \"panelId\": \"${UUID%%-*}\",
    \"rconPassword\": \"$PASSWORD\"
  }"
done

printf '[%s\n]\n' "$SERVERS_JSON" > servers.json
chown 1000:1000 servers.json
chmod 600 servers.json

docker build -t ranalan .
docker rm -f ranalan >/dev/null 2>&1 || true
docker run -d --name ranalan --restart unless-stopped \
  -p "$SITE_PORT:3000" \
  --env-file .env \
  --add-host host.docker.internal:host-gateway \
  -v ranalan-data:/data \
  -v "$PWD/servers.json:/config/servers.json:ro" \
  ranalan >/dev/null

sleep 2
echo
echo "--- Result ---"
docker ps --filter name=^ranalan$ --format '{{.Names}}: {{.Status}}'
curl -s -o /dev/null -w 'Site answers with HTTP %{http_code}\n' "http://$HOST_IP:$SITE_PORT/" || echo "Site does not answer yet"
if command -v ufw >/dev/null 2>&1; then ufw status | head -1; fi

for ENTRY in "${SERVERS[@]}"; do
  IFS='|' read -r ID NAME UUID PORT GOTV_PORT <<< "$ENTRY"
  GAME=$VOLUMES/$UUID/game/csgo
  echo "--- $NAME"
  if [ -n "$PANEL_API_KEY" ]; then
    # Only the status code is shown, so the key stays out of the terminal.
    curl -s -o /dev/null -w 'Panel connection (should be 200): %{http_code}\n' \
      -H "Authorization: Bearer $PANEL_API_KEY" -H 'Accept: application/json' \
      "$PANEL_URL/api/client/servers/${UUID%%-*}/resources" || echo "Panel connection: could not reach the panel"
  else
    echo "Panel connection: not set up, so servers won't turn on and off by themselves"
  fi
  grep -c '^rcon_password' "$GAME/cfg/server.cfg" | sed 's/^/RCON lines in server.cfg (should be 1): /' || true
  grep -c '^matchzy_remote_log_url' "$GAME/cfg/MatchZy/config.cfg" | sed 's/^/Event lines in MatchZy config (should be 1): /' || true
  sha256sum "$GAME/addons/counterstrikesharp/plugins/RanalanGate/RanalanGate.dll" | cut -c1-8 | sed 's/^/Gate plugin checksum (should be 8f36b05a): /'
  PORTS=$(docker port "$UUID" 2>/dev/null | grep -c "$PORT/udp\|$GOTV_PORT/udp" || true)
  echo "Game and GOTV ports assigned (should be 2 while running): $PORTS"
done

echo "Done. Now restart both game servers in the panel, then open http://$HOST_IP:$SITE_PORT"
