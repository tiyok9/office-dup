#!/usr/bin/env bash
# REA recon v2 — PUBLIC view-only targets on scratch headless CDP (9333)
# Measures the REAL editor engines. No auth. Per-command timeout to avoid hangs.
set -u
export PATH="$HOME/AppData/Local/rea/node-v24.22.0-win-x64:$PATH"

EP="http://127.0.0.1:9333"
ORIGIN="https://docs.google.com"
BASE="/d/program/google/public"
TMO=240

REA() { timeout $TMO npx -y rea-agents@6.5.0 "$@"; }

# target_id <url>
open_tab () {
  curl -s -X PUT -m 30 "http://127.0.0.1:9333/json/new?$1" | grep -o '"id": "[A-F0-9]*"' | head -1 | cut -d'"' -f4
}

run_one () {
  local app="$1" oid="$2" path="$3"
  local url="https://docs.google.com/${path}/d/${oid}/edit"
  local out="$BASE/$app"
  mkdir -p "$out"

  echo "### [$app] open tab: $url @ $(date -u +%H:%M:%S)"
  local tid; tid=$(open_tab "$url")
  echo "[$app] target_id=$tid"
  sleep 12

  echo "### [$app] STATIC analyze-web-bundle @ $(date -u +%H:%M:%S)"
  REA analyze-web-bundle "$EP" "$tid" --allowed-origins "$ORIGIN" --format json \
      > "$out/bundle.json" 2>"$out/bundle.err"
  echo "[$app] bundle.json bytes=$(wc -c < "$out/bundle.json") ($?)"

  echo "### [$app] DYNAMIC inspect-web-page @ $(date -u +%H:%M:%S)"
  REA inspect-web-page "$EP" "$tid" --allowed-origins "$ORIGIN" \
      --include-accessibility-text --include-console-text --format json \
      > "$out/inspect.json" 2>"$out/inspect.err"
  echo "[$app] inspect.json bytes=$(wc -c < "$out/inspect.json") ($?)"

  echo "### [$app] SCREENSHOT @ $(date -u +%H:%M:%S)"
  REA capture-web-screenshot "$EP" "$tid" --allowed-origins "$ORIGIN" --format json \
      > "$out/screenshot.json" 2>"$out/screenshot.err"
  echo "[$app] screenshot.json bytes=$(wc -c < "$out/screenshot.json") ($?)"

  echo "$tid" > "$out/target_id.txt"
  echo "$url" > "$out/url.txt"
}

run_one docs   "0B2d6r6Mo5NUua3l0eUpFYURSY1E"                  document
run_one slides "1--vRBDTp0pf_Eck2Ga8XffBWn7gbUpnbuehkRnJE8vg" presentation
run_one sheets "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" spreadsheets

echo "### DONE @ $(date -u +%H:%M:%S)"
