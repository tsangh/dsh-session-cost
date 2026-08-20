#!/usr/bin/env bash
# install.sh — wire dsh-session-cost into a DSH profile on ANY installation,
# with no hard-coded user, path, or profile assumptions.
#
# Usage:
#   ./install.sh [--profile <id>] [--dsh-api <url>] [--usd-rate <n>] [--peak-hours <json>] [--pricing <json>] [--dry-run]
#   npm install -g dsh-session-cost && install-dsh-session-cost [same flags]
#
# Options:
#   --profile <id>    target profile under $DSH_HOME/profiles (default: "web",
#                     or the first profile that has a cordis.patch.yml)
#   --dsh-api <url>   base URL of this DSH backend to write into the row (
#                     default: auto-detect from the first listening DSH process,
#                     else the standard loopback http://127.0.0.1:3080)
#   --usd-rate <n>    CNY per 1 USD written into the config row (default none;
#                     plugin falls back to its own 7.1 => omit to keep plugin default)
#   --hkd-rate <n>    CNY per 1 HKD written into the config row (default none;
#                     plugin falls back to its own 0.91 => omit to keep plugin default)
#   --peak-hours      JSON [[start,end),…] peak hours (default none -> plugin default)
#   --pricing         JSON object of model prices (default none -> plugin default)
#   --dry-run         print what would change without writing anything
#
# Does three things (idempotent — safe to re-run):
#   1. link/copy this package into <profile>/node_modules/dsh-session-cost
#   2. append an insert row to <profile>/cordis.patch.yml (only if absent)
#   3. remind you to restart DSH
#
# No root required; the profile must be writable by your user.

# Resolve this package's own real directory. Works whether invoked directly
# (./install.sh) or as the npm-installed bin (install-dsh-session-cost), whose
# argv[0] resolves into node_modules/.bin -> ../dsh-session-cost/install.sh.
resolve_self() {
  local src="${BASH_SOURCE[0]:-$0}"
  while [[ -h "$src" ]]; do
    local dir
    dir="$(cd -P "$(dirname "$src")" >/dev/null 2>&1 && pwd)"
    src="$(readlink "$src")"
    [[ "$src" != /* ]] && src="$dir/$src"
  done
  cd -P "$(dirname "$src")" >/dev/null 2>&1 && pwd
}
PLUGIN_DIR="$(resolve_self)"
# When running via node_modules/.bin, the package dir sits next to .bin.
if [[ -d "$PLUGIN_DIR/../dsh-session-cost/index.js" ]]; then
  PLUGIN_DIR="$(cd "$PLUGIN_DIR/../dsh-session-cost" && pwd)"
elif [[ -d "$PLUGIN_DIR/index.js" ]]; then
  : # direct repo invocation — PLUGIN_DIR already correct
fi

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_ID=""
DSH_API=""
USD_RATE=""
HKD_RATE=""
PEAK_HOURS=""
PRICING=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE_ID="$2"; shift 2 ;;
    --dsh-api) DSH_API="$2"; shift 2 ;;
    --usd-rate) USD_RATE="$2"; shift 2 ;;
    --hkd-rate) HKD_RATE="$2"; shift 2 ;;
    --peak-hours) PEAK_HOURS="$2"; shift 2 ;;
    --pricing) PRICING="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# --- locate the profile ------------------------------------------------------
if [[ -z "$PROFILE_ID" ]]; then
  if [[ -d "$DSH_HOME/profiles/web" ]]; then
    PROFILE_ID="web"
  else
    PROFILE_ID="$(ls -d "$DSH_HOME"/profiles/*/ 2>/dev/null | head -1 | xargs -n1 basename 2>/dev/null || true)"
  fi
fi
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_ID"
if [[ ! -d "$PROFILE_DIR" ]]; then
  echo "error: profile dir not found: $PROFILE_DIR" >&2
  echo "       pass --profile <id> (a subdir of $DSH_HOME/profiles)" >&2
  exit 1
fi
if [[ ! -f "$PROFILE_DIR/cordis.patch.yml" ]]; then
  echo "error: $PROFILE_DIR/cordis.patch.yml not found (not a DSH profile?)" >&2
  exit 1
fi
if [[ ! -d "$PROFILE_DIR/node_modules" ]]; then
  echo "error: $PROFILE_DIR/node_modules not found" >&2
  exit 1
fi

echo "→ target profile: $PROFILE_DIR"
echo "→ plugin source:  $PLUGIN_DIR"

# --- auto-detect the DSH API base --------------------------------------------
if [[ -z "$DSH_API" ]]; then
  # Prefer whatever loopback DSH is actually listening (any port). This makes
  # the row correct on servers where DSH runs on a non-3080 port.
  PORT="$(
    (ss -tlnp 2>/dev/null || netstat -tln 2>/dev/null || true) \
      | awk '{print $4}' | sed 's/.*://' | tr -d '[:space:]' \
      | awk '!/[^0-9]/ && $1>=3000 && $1<=4000' | sort -n | head -1
  )"
  if [[ -n "$PORT" ]]; then
    DSH_API="http://127.0.0.1:$PORT"
  else
    DSH_API="http://127.0.0.1:3080"
  fi
fi

# --- 1. install the package dir ------------------------------------------------
LINK="$PROFILE_DIR/node_modules/dsh-session-cost"
if [[ -e "$LINK" || -L "$LINK" ]]; then
  echo "→ node_modules/dsh-session-cost already present, skip"
else
  # If the source is on the same filesystem, a symlink keeps it updatable in
  # place; otherwise copy the tree so it is self-contained on any server.
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "→ would link/copy $PLUGIN_DIR -> $LINK"
  elif ln -s "$PLUGIN_DIR" "$LINK" 2>/dev/null; then
    echo "→ symlinked $PLUGIN_DIR -> $LINK"
  else
    mkdir -p "$LINK"
    cp -R "$PLUGIN_DIR"/. "$LINK"/ 2>/dev/null
    rm -f "$LINK/install.sh" "$LINK"/*.tgz
    echo "→ copied plugin tree to $LINK"
  fi
fi

# --- 2. cordis.patch.yml row --------------------------------------------------
PATCH="$PROFILE_DIR/cordis.patch.yml"
if grep -q "name: 'dsh-session-cost'" "$PATCH"; then
  echo "→ cordis.patch.yml already has the session-cost row, skip"
else
  ROW="# Per-session DeepSeek API cost (session_cost) — official peak/off-peak pricing"
  ROW+=$'\n'"- insert:"
  ROW+=$'\n'"    - id: session-cost"
  ROW+=$'\n'"      name: 'dsh-session-cost'"
  ROW+=$'\n'"      config:"
  ROW+=$'\n'"        dshApi: $DSH_API"
  if [[ -n "$USD_RATE" ]]; then
    ROW+=$'\n'"        usdRate: $USD_RATE"
  fi
  if [[ -n "$HKD_RATE" ]]; then
    ROW+=$'\n'"        hkdRate: $HKD_RATE"
  fi
  if [[ -n "$PEAK_HOURS" ]]; then
    ROW+=$'\n'"        peakHours: $PEAK_HOURS"
  fi
  if [[ -n "$PRICING" ]]; then
    ROW+=$'\n'"        pricing: $PRICING"
  fi
  ROW+=$'\n'
  echo "→ appending session-cost row to cordis.patch.yml"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    printf '%s\n' "$ROW" >> "$PATCH"
  else
    echo "-------------------- (would append) --------------------"
    printf '%s\n' "$ROW"
    echo "--------------------------------------------------------"
  fi
fi

# --- 3. done ------------------------------------------------------------------
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "→ dry run: no changes written"
else
  echo "✔ installed into $PROFILE_DIR"
  echo "→ restart DSH; then call session_cost (no args = overview, or with sessionId for details)"
  echo "  config written: dshApi=$DSH_API (override with --dsh-api); see README.md for --usd-rate/--hkd-rate/--peak-hours/--pricing"
fi
