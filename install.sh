#!/usr/bin/env bash
# install.sh — one-command host-side install of the obsidian-vessel plugin.
#
# The plugin ships outside the Obsidian community marketplace (it runs an HTTP
# server and spawns a libp2p sidecar process, which likely violates marketplace
# guidelines), so this script IS the distribution path:
#
#   ./install.sh                                          # fully interactive
#   ./install.sh --vault ~/vaults/mine \
#       --discovery https://<discovery-endpoint> --api-key <api-key>
#   ./install.sh --vault ~/vaults/new --local            # local substrate (:18100)
#
# Point-and-go: the plugin's whole network surface is two values —
#   { discoveryVesselEndpoint, apiKey }.
# You point it at a substrate discovery endpoint and hand it an API key; that is
# all. At start the federation sidecar fetches <discovery>/bootstrap and reads the
# relay anchor, identity endpoint, and preferred transport from it, reserves a
# p2p circuit over the overlay, and registers itself — a valid API key is the sole
# gate. Nothing else is pinned. A hand-set relay multiaddr (--relay) is an OPTIONAL
# advanced override for the rare case where /bootstrap is unavailable; do not set
# it routinely — a pinned relay peer-id goes stale on every relay restart, which is
# exactly the failure /bootstrap exists to prevent.
#
# What it does:
#   1. Selects (or creates) an Obsidian vault directory.
#   2. Installs the plugin (main.js / manifest.json / styles.css) into
#      <vault>/.obsidian/plugins/obsidian-vessel/ — from this repo checkout when
#      run in place, otherwise from the latest GitHub release.
#   3. Materializes the libp2p federation sidecar (sidecar/*.ts + deps).
#   4. Writes data.json with the two point-and-go values (plus vesselId and the
#      absolute bun path); the relay multiaddr is written only when --relay is given.
#   5. Enables the plugin in the vault.
#
# Host requirements: bash, curl, jq, and bun (https://bun.sh) for the sidecar.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ID="obsidian-vessel"
RELEASE_REPO="AviGopal/obsidian-vessel"
LOCAL_DISCOVERY="http://localhost:18100"

VAULT="" DISCOVERY_URL="" API_KEY="" RELAY="" FEDERATION=1 ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --vault)     VAULT="$2"; shift 2 ;;
    --discovery) DISCOVERY_URL="$2"; shift 2 ;;
    --api-key)   API_KEY="$2"; shift 2 ;;
    --relay)     RELAY="$2"; shift 2 ;;
    --local)     DISCOVERY_URL="$LOCAL_DISCOVERY"; shift ;;
    --no-federation) FEDERATION=0; shift ;;
    -y|--yes)    ASSUME_YES=1; shift ;;
    -h|--help)   grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown flag: $1 (see --help)" >&2; exit 1 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
confirm() { # confirm "prompt" ; returns 0 on yes
  [ "$ASSUME_YES" = "1" ] && return 0
  local reply; read -rp "$1 [y/N]: " reply; [[ "$reply" =~ ^[Yy] ]]
}

# ── 0. Host dependencies ────────────────────────────────────────────────────
for dep in curl jq; do
  command -v "$dep" >/dev/null || die "$dep is required but not on PATH — install it and re-run."
done
# bun is required for the libp2p federation sidecar (the preferred transport).
BUN_PATH="$(command -v bun || true)"
if [ "$FEDERATION" = "1" ] && [ -z "$BUN_PATH" ]; then
  echo "[bun] not found on PATH — the libp2p federation sidecar needs it." >&2
  echo "      Remedy: install bun (curl -fsSL https://bun.sh/install | bash), then" >&2
  echo "      re-open your shell and re-run this installer. To install the plugin" >&2
  echo "      without the sidecar for now, re-run with --no-federation." >&2
  confirm "Continue without the sidecar (plugin installs, federation disabled until bun is present)?" \
    || die "Aborted — install bun and re-run."
  FEDERATION=0
fi

# ── 1. Vault ────────────────────────────────────────────────────────────────
if [ -z "$VAULT" ]; then
  read -rp "Vault directory (existing or new): " VAULT
fi
[ -n "$VAULT" ] || die "a vault directory is required."
VAULT="${VAULT/#\~/$HOME}"
# Reject obviously-wrong paths (a file where a directory should be).
if [ -e "$VAULT" ] && [ ! -d "$VAULT" ]; then
  die "$VAULT exists but is not a directory."
fi
if [ ! -d "$VAULT/.obsidian" ]; then
  if [ -d "$VAULT" ]; then
    echo "[vault] $VAULT exists but is not yet an Obsidian vault — initializing .obsidian/"
  else
    confirm "[vault] $VAULT does not exist — create a new vault there?" \
      || die "Aborted — pass an existing vault with --vault."
    echo "[vault] creating new vault at $VAULT"
  fi
  mkdir -p "$VAULT/.obsidian" || die "could not create $VAULT/.obsidian (check permissions)."
fi
PLUGIN_DIR="$VAULT/.obsidian/plugins/$PLUGIN_ID"

# Confirm before overwriting an existing install.
if [ -f "$PLUGIN_DIR/main.js" ] || [ -f "$PLUGIN_DIR/data.json" ]; then
  echo "[vault] an obsidian-vessel install already exists at $PLUGIN_DIR"
  confirm "Overwrite it (plugin files replaced; data.json merged, vesselId preserved)?" \
    || die "Aborted — nothing changed."
fi
mkdir -p "$PLUGIN_DIR"

# ── 2. Discovery endpoint (the point-and-go anchor) ─────────────────────────
if [ -z "$DISCOVERY_URL" ]; then
  echo "Substrate discovery endpoint — a full URL, scheme://host:port."
  echo "  local substrate: $LOCAL_DISCOVERY    remote hub: https://<discovery-endpoint>"
  read -rp "Discovery endpoint: " DISCOVERY_URL
fi
[ -n "$DISCOVERY_URL" ] || die "a discovery endpoint is required (e.g. $LOCAL_DISCOVERY)."
DISCOVERY_URL="${DISCOVERY_URL%/}"   # strip a trailing slash
# Validate it is a real endpoint, not a bare hostname (the old :18100-assuming trap).
if ! [[ "$DISCOVERY_URL" =~ ^https?://[^/[:space:]]+ ]]; then
  die "'$DISCOVERY_URL' is not a valid endpoint — use a full URL, e.g. $LOCAL_DISCOVERY or https://<discovery-endpoint>"
fi

# ── 3. API key (the sole gate) ──────────────────────────────────────────────
if [ -z "$API_KEY" ]; then
  echo "API key — retrieve the operator key from the substrate host with:"
  echo "  docker exec substrate-live substrate-key show"
  read -rsp "API key: " API_KEY; echo
fi
[ -n "$API_KEY" ] || die "an API key is required."

# ── 4. Verify point-and-go: /bootstrap must be reachable and well-formed ─────
# This is the single pre-auth read the plugin depends on; if it is wrong here,
# it will be wrong for the sidecar too — so fail loudly now, not silently later.
echo "[check] fetching $DISCOVERY_URL/bootstrap ..."
BOOTSTRAP="$(curl -sf --max-time 8 "$DISCOVERY_URL/bootstrap" 2>/dev/null || true)"
if [ -z "$BOOTSTRAP" ]; then
  echo "ERROR: could not reach $DISCOVERY_URL/bootstrap." >&2
  echo "  - Confirm the discovery endpoint (scheme, host, and PORT) is exactly right." >&2
  echo "    A non-default PORT_OFFSET substrate does NOT use :18100 — pass its actual port." >&2
  echo "  - Confirm the substrate is up and reachable from this host (try:" >&2
  echo "      curl -s $DISCOVERY_URL/health )." >&2
  die "discovery /bootstrap unreachable."
fi
if ! echo "$BOOTSTRAP" | jq -e '.relay_multiaddrs? // .identity_endpoint? // .discovery_endpoint?' >/dev/null 2>&1; then
  die "$DISCOVERY_URL/bootstrap did not return the expected point-and-go body {relay_multiaddrs, identity_endpoint, discovery_endpoint, prefer_transport}. Is this actually a discovery endpoint?"
fi
RELAY_PREVIEW="$(echo "$BOOTSTRAP" | jq -r '.relay_multiaddrs[0] // empty' 2>/dev/null || true)"
echo "[check] point-and-go OK — the sidecar will fetch relay + identity anchors from /bootstrap at start."
[ -n "$RELAY_PREVIEW" ] && echo "[check]   relay anchor (preview, resolved live at start): $RELAY_PREVIEW"

# ── 5. Plugin artifacts (local checkout preferred, GitHub release fallback) ──
if [ -f "$SCRIPT_DIR/main.js" ] && [ -f "$SCRIPT_DIR/manifest.json" ]; then
  echo "[plugin] installing from local checkout ($SCRIPT_DIR)"
  cp "$SCRIPT_DIR/main.js" "$SCRIPT_DIR/manifest.json" "$SCRIPT_DIR/styles.css" "$PLUGIN_DIR/" \
    || die "failed to copy plugin files into $PLUGIN_DIR."
else
  echo "[plugin] fetching latest release from github.com/$RELEASE_REPO"
  base="https://github.com/$RELEASE_REPO/releases/latest/download"
  for f in main.js manifest.json styles.css; do
    curl -sfL "$base/$f" -o "$PLUGIN_DIR/$f" || die "failed to download $f from the latest release."
  done
fi

# Current builds embed the sidecar source (esbuild define) and self-materialize
# it on first start; copying it here is belt-and-braces so older builds and
# offline installs work too, and pre-installing deps avoids a first-start wait.
if [ "$FEDERATION" = "1" ]; then
  mkdir -p "$PLUGIN_DIR/sidecar"
  if [ -f "$SCRIPT_DIR/sidecar/federation-sidecar.ts" ]; then
    cp "$SCRIPT_DIR/sidecar/federation-sidecar.ts" "$SCRIPT_DIR/sidecar/package.json" "$PLUGIN_DIR/sidecar/"
  else
    raw="https://raw.githubusercontent.com/$RELEASE_REPO/dev/sidecar"
    curl -sfL "$raw/federation-sidecar.ts" -o "$PLUGIN_DIR/sidecar/federation-sidecar.ts" \
      || die "failed to download the federation sidecar source."
    curl -sfL "$raw/package.json"          -o "$PLUGIN_DIR/sidecar/package.json" \
      || die "failed to download the sidecar package.json."
  fi
  echo "[sidecar] pre-installing libp2p deps (bun install) ..."
  (cd "$PLUGIN_DIR/sidecar" && bun install --silent) \
    || echo "[sidecar] WARNING: bun install failed — the plugin will retry on first start."
fi

# ── 6. data.json — the two point-and-go values (+ vesselId, bun path) ───────
# Config surface = { discoveryVesselEndpoint, apiKey }. Identity, activity, relay,
# and every other endpoint are resolved from <discovery>/bootstrap at start, so
# they are NOT written here. federationRelayMultiaddr is written only when the
# operator passed --relay as an explicit override.
#
# vesselId must be non-empty at registration time or discovery rejects with
# "Missing required fields". Reuse an existing one; generate otherwise.
VESSEL_ID=$(jq -r '.vesselId // empty' "$PLUGIN_DIR/data.json" 2>/dev/null || true)
[ -n "$VESSEL_ID" ] || VESSEL_ID="obsidian-vessel-$(date +%s)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"

# GUI-launched Obsidian does not inherit the shell PATH (spawn('bun') ENOENT on
# macOS), so persist bun's ABSOLUTE path for the sidecar.
NEW_SETTINGS=$(jq -n \
  --arg apiKey "$API_KEY" --arg disc "$DISCOVERY_URL" \
  --arg vid "$VESSEL_ID" --arg bun "${BUN_PATH:-bun}" --arg relay "$RELAY" '{
    vesselId: $vid,
    apiKey: $apiKey,
    discoveryVesselEndpoint: $disc,
    serverEnabled: true,
    federationBunPath: $bun
  } + (if $relay == "" then {} else { federationRelayMultiaddr: $relay } end)')

if [ -f "$PLUGIN_DIR/data.json" ]; then
  echo "[settings] merging into existing data.json (vesselId preserved)"
  jq -s '.[0] * .[1]' "$PLUGIN_DIR/data.json" <(echo "$NEW_SETTINGS") > "$PLUGIN_DIR/data.json.tmp" \
    && mv "$PLUGIN_DIR/data.json.tmp" "$PLUGIN_DIR/data.json"
else
  echo "$NEW_SETTINGS" > "$PLUGIN_DIR/data.json"
fi
chmod 600 "$PLUGIN_DIR/data.json"   # it holds the API key

# ── 7. Enable the plugin in the vault ───────────────────────────────────────
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
echo "  discovery:  $DISCOVERY_URL   (relay + identity resolved via /bootstrap)"
if [ "$FEDERATION" = "1" ] && [ -n "$RELAY" ]; then
  echo "  transport:  libp2p — relay OVERRIDE pinned: $RELAY"
  echo "              (a pinned relay can go stale on relay restart; clear it to return to /bootstrap)"
elif [ "$FEDERATION" = "1" ]; then
  echo "  transport:  libp2p federation sidecar (relay anchor fetched from /bootstrap at start)"
  echo "              (sidecar health: http://127.0.0.1:8402/health)"
else
  echo "  transport:  direct HTTP only (sidecar disabled — install bun and rerun to enable federation)"
fi
echo
echo "Next: open the vault in Obsidian (community plugins must be allowed once in"
echo "Settings if this is a brand-new vault). Verify the local server with:"
echo "  curl -s http://localhost:27182/health"
