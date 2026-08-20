#!/usr/bin/env bash
# install.sh — wire dsh-session-cost into a DSH profile on ANY installation.
#
# Usage:
#   ./install.sh [--profile <id>] [--dry-run]
#
#   --profile <id>   target profile under $DSH_HOME/profiles (default: "web",
#                    or the first profile that has a cordis.patch.yml)
#   --dry-run        print what would change without writing anything
#
# Does three things (idempotent — safe to re-run):
#   1. symlink this package into <profile>/node_modules/dsh-session-cost
#   2. append an insert row to <profile>/cordis.patch.yml (only if absent)
#   3. remind you to restart DSH
#
# No root required; the profile must be writable by your user.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_ID=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE_ID="$2"; shift 2 ;;
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

# --- 1. symlink ---------------------------------------------------------------
LINK="$PROFILE_DIR/node_modules/dsh-session-cost"
if [[ -e "$LINK" || -L "$LINK" ]]; then
  echo "→ node_modules/dsh-session-cost already present, skip"
else
  echo "→ ln -s $PLUGIN_DIR $LINK"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    ln -s "$PLUGIN_DIR" "$LINK"
  fi
fi

# --- 2. cordis.patch.yml row --------------------------------------------------
PATCH="$PROFILE_DIR/cordis.patch.yml"
if grep -q "name: 'dsh-session-cost'" "$PATCH"; then
  echo "→ cordis.patch.yml already has the session-cost row, skip"
else
  ROW=$(cat <<'YAML'

# Per-session DeepSeek API cost (session_cost) — official peak/off-peak pricing
- insert:
    - id: session-cost
      name: 'dsh-session-cost'
      config:
        dshApi: http://127.0.0.1:3080
        usdRate: 7.1
YAML
)
  echo "→ appending session-cost row to cordis.patch.yml"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    printf '%s\n' "$ROW" >> "$PATCH"
  fi
fi

# --- 3. done ------------------------------------------------------------------
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "→ dry run: no changes written"
else
  echo "✔ installed into $PROFILE_DIR"
  echo "→ restart DSH; then call session_cost (no args = overview, or with sessionId for details)"
  echo "  pricing/peak hours/FX are configurable via the row's config (see README.md)"
fi
