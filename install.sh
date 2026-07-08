#!/usr/bin/env bash
# install.sh — one-command host-side install of the obsidian-vessel plugin.
#
# The plugin ships outside the Obsidian community marketplace (it runs an HTTP
# server and spawns a libp2p sidecar process, which likely violates marketplace
# guidelines), so this script IS the distribution path:
#
#   ./install.sh                                   # fully interactive
#   ./install.sh --vault ~/vaults/mine --host syzygy.host --api-key mb-...
#   ./install.sh --vault ~/vaults/new --local      # local substrate, no prompts for host
#
# What it does:
#   1. Selects (or creates) an Obsidian vault directory.
#   2. Installs the plugin (main.js / manifest.json / styles.css) into
#      <vault>/.obsidian/plugins/obsidian-vessel/ — from this repo checkout when
#      run in place, otherwise from the latest GitHub release.
#   3. Materializes the libp2p federation sidecar (sidecar/*.ts + deps) — the
#      PREFERRED transport: all substrate networking rides the relay overlay;
#      the direct HTTP endpoints are written only as same-host fallback.
#   4. Points the plugin at a discovery host (e.g. syzygy.host) and auto-derives
#      the relay multiaddr from that discovery (shape: federation_probe).
#   5. Writes data.json (identity API key + endpoints), enables the plugin.
#
# Host requirements: bash, curl, jq. bun is required for the federation sidecar
# (installed plugin still works same-host without it, but libp2p is preferred).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ID="obsidian-vessel"
RELEASE_REPO="AviGopal/obsidian-vessel"
RELAY_PORT=30333

VAULT="" HOST="" API_KEY="" RELAY="" FEDERATION=1
while [ $# -gt 0 ]; do
  case "$1" in
    --vault)   VAULT="$2"; shift 2 ;;
    --host)    HOST="$2"; shift 2 ;;
    --api-key) API_KEY="$2"; shift 2 ;;
    --relay)   RELAY="$2"; shift 2 ;;
    --local)   HOST="localhost"; shift ;;
    --no-federation) FEDERATION=0; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)"; exit 1 ;;
  esac
done

for dep in curl jq; do
  command -v "$dep" >/dev/null || { echo "ERROR: $dep is required"; exit 1; }
done

# ── 1. Vault ────────────────────────────────────────────────────────────────
if [ -z "$VAULT" ]; then
  read -rp "Vault directory (existing or new): " VAULT
fi
VAULT="${VAULT/#\~/$HOME}"
if [ ! -d "$VAULT/.obsidian" ]; then
  if [ -d "$VAULT" ]; then
    echo "[vault] $VAULT exists but is not yet an Obsidian vault — initializing .obsidian/"
  else
    echo "[vault] creating new vault at $VAULT"
  fi
  mkdir -p "$VAULT/.obsidian"
fi
PLUGIN_DIR="$VAULT/.obsidian/plugins/$PLUGIN_ID"
mkdir -p "$PLUGIN_DIR"

# ── 2. Discovery host + API key ─────────────────────────────────────────────
if [ -z "$HOST" ]; then
  read -rp "Substrate discovery host [syzygy.host]: " HOST
  HOST="${HOST:-syzygy.host}"
fi
DISCOVERY_URL="http://$HOST:18100"
ACTIVITY_URL="http://$HOST:18080"

if [ -z "$API_KEY" ]; then
  read -rsp "Identity API key (from the hub: make issue-key NAME=<you>): " API_KEY; echo
fi
[ -n "$API_KEY" ] || { echo "ERROR: an API key is required"; exit 1; }

echo "[check] probing discovery at $DISCOVERY_URL ..."
if ! curl -sf --max-time 6 "$DISCOVERY_URL/health" >/dev/null; then
  echo "[check] WARNING: $DISCOVERY_URL/health unreachable — continuing, but verify the host."
fi

# ── 3. Plugin artifacts (local checkout preferred, GitHub release fallback) ──
if [ -f "$SCRIPT_DIR/main.js" ] && [ -f "$SCRIPT_DIR/manifest.json" ]; then
  echo "[plugin] installing from local checkout ($SCRIPT_DIR)"
  cp "$SCRIPT_DIR/main.js" "$SCRIPT_DIR/manifest.json" "$SCRIPT_DIR/styles.css" "$PLUGIN_DIR/"
else
  echo "[plugin] fetching latest release from github.com/$RELEASE_REPO"
  base="https://github.com/$RELEASE_REPO/releases/latest/download"
  for f in main.js manifest.json styles.css; do
    curl -sfL "$base/$f" -o "$PLUGIN_DIR/$f" || { echo "ERROR: failed to download $f"; exit 1; }
  done
fi

# Sidecar source must be shipped alongside — the bundled main.js does not embed
# it (__SIDECAR_SOURCE__ is not defined at build time), so the plugin cannot
# self-materialize it. Copying it here is what makes libp2p work.
if [ "$FEDERATION" = "1" ]; then
  mkdir -p "$PLUGIN_DIR/sidecar"
  if [ -f "$SCRIPT_DIR/sidecar/federation-sidecar.ts" ]; then
    cp "$SCRIPT_DIR/sidecar/federation-sidecar.ts" "$SCRIPT_DIR/sidecar/package.json" "$PLUGIN_DIR/sidecar/"
  else
    raw="https://raw.githubusercontent.com/$RELEASE_REPO/dev/sidecar"
    curl -sfL "$raw/federation-sidecar.ts" -o "$PLUGIN_DIR/sidecar/federation-sidecar.ts"
    curl -sfL "$raw/package.json"          -o "$PLUGIN_DIR/sidecar/package.json"
  fi
  if command -v bun >/dev/null; then
    echo "[sidecar] pre-installing libp2p deps (bun install) ..."
    (cd "$PLUGIN_DIR/sidecar" && bun install --silent) || \
      echo "[sidecar] WARNING: bun install failed — the plugin will retry on first start"
  else
    echo "[sidecar] WARNING: bun not found on PATH — install it (https://bun.sh) to run the"
    echo "          libp2p sidecar. The plugin falls back to direct HTTP until then."
  fi
fi

# ── 4. Relay multiaddr (libp2p-first) ───────────────────────────────────────
# Derive it from discovery: any vessel registered over libp2p advertises a
# circuit multiaddr /ip4/<relay>/tcp/30333/p2p/<relayPeer>/p2p-circuit/p2p/<peer>;
# stripping the /p2p-circuit suffix recovers the relay's own multiaddr.
if [ "$FEDERATION" = "1" ] && [ -z "$RELAY" ]; then
  echo "[relay] deriving relay multiaddr from $DISCOVERY_URL ..."
  RELAY=$(curl -sf --max-time 8 -X POST "$DISCOVERY_URL/resolve" \
      -H "Content-Type: application/json" -H "Authorization: ApiKey $API_KEY" \
      -d '{"pointer":{"type":"vesselCapability","shape":"federation_probe"}}' \
    | jq -r '[.content.vessels[]?.libp2p_multiaddr[]? // empty
              | select(contains("/p2p-circuit"))][0] // empty
              | split("/p2p-circuit")[0]' 2>/dev/null || true)
  if [ -n "$RELAY" ]; then
    echo "[relay] $RELAY"
  else
    echo "[relay] could not derive it automatically (no libp2p vessel registered?)."
    read -rp "Relay multiaddr (/ip4/<ip>/tcp/$RELAY_PORT/p2p/<peerId>), empty to skip: " RELAY
  fi
fi
if [ "$FEDERATION" = "1" ] && [ -z "$RELAY" ]; then
  echo "[relay] no relay available — federation sidecar will stay disabled (direct HTTP only)."
  FEDERATION=0
fi

# ── 5. data.json (merge over any existing settings, preserve vesselId) ──────
HOST_LABEL="$( (hostname -s 2>/dev/null || uname -n) | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/-*$//')"
FED_VESSEL_ID="obsidian-${HOST_LABEL:-host}-vessel"
NEW_SETTINGS=$(jq -n \
  --arg apiKey "$API_KEY" --arg act "$ACTIVITY_URL" --arg disc "$DISCOVERY_URL" \
  --arg cdb "http://$HOST:18260" --arg gh "http://$HOST:18210" \
  --arg ws "ws://$HOST:18080/ws" --arg relay "$RELAY" --arg fvid "$FED_VESSEL_ID" \
  --argjson fed "$([ "$FEDERATION" = "1" ] && echo true || echo false)" '{
    apiKey: $apiKey,
    activityApiUrl: $act,
    discoveryVesselEndpoint: $disc,
    conceptDbEndpoint: $cdb,
    goalHostEndpoint: $gh,
    websocketUrl: $ws,
    serverEnabled: true,
    enableFederationSidecar: $fed,
    federationRelayMultiaddr: $relay,
    federationDiscoveryUrl: $disc,
    federationVesselId: $fvid
  }')
if [ -f "$PLUGIN_DIR/data.json" ]; then
  echo "[settings] merging into existing data.json (vesselId preserved)"
  jq -s '.[0] * .[1]' "$PLUGIN_DIR/data.json" <(echo "$NEW_SETTINGS") > "$PLUGIN_DIR/data.json.tmp"
  mv "$PLUGIN_DIR/data.json.tmp" "$PLUGIN_DIR/data.json"
else
  echo "$NEW_SETTINGS" > "$PLUGIN_DIR/data.json"
fi
chmod 600 "$PLUGIN_DIR/data.json"   # it holds the API key

# ── 6. Enable the plugin in the vault ───────────────────────────────────────
CP_JSON="$VAULT/.obsidian/community-plugins.json"
if [ -f "$CP_JSON" ]; then
  jq --arg id "$PLUGIN_ID" '(. + [$id]) | unique' "$CP_JSON" > "$CP_JSON.tmp" && mv "$CP_JSON.tmp" "$CP_JSON"
else
  echo "[\"$PLUGIN_ID\"]" > "$CP_JSON"
fi
[ -f "$VAULT/.obsidian/app.json" ] || echo '{}' > "$VAULT/.obsidian/app.json"

# ── Done ────────────────────────────────────────────────────────────────────
echo
echo "── obsidian-vessel installed ──────────────────────────────────────────"
echo "  vault:      $VAULT"
echo "  substrate:  $HOST (discovery $DISCOVERY_URL)"
if [ "$FEDERATION" = "1" ]; then
  echo "  transport:  libp2p via relay  $RELAY"
  echo "              (vessel id: $FED_VESSEL_ID; sidecar health: http://127.0.0.1:8402/health)"
else
  echo "  transport:  direct HTTP only (no relay — rerun with --relay <multiaddr> to enable libp2p)"
fi
echo
echo "Next: open the vault in Obsidian (community plugins must be allowed once in"
echo "Settings if this is a brand-new vault). Verify with:"
echo "  curl -s http://localhost:27182/health"
