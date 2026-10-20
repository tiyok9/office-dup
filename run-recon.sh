#!/usr/bin/env bash
# REA Google Workspace recon — Docs & Slides
# Read-only observation via CDP 127.0.0.1:9222 (isolated profile chrome-rea-debug)
set -u
export PATH="$HOME/AppData/Local/rea/node-v24.22.0-win-x64:$PATH"

EP="http://127.0.0.1:9222"
BASE="/d/program/google"
REA() { npx -y rea-agents@6.5.0 "$@" ; }

DOCS_TARGET="AB0F7764904A8AB0F26AB52AE7EAD39E"
SLIDES_TARGET="27DB8D98C66391DAFF042917E3CDBC0E"

mkdir -p "$BASE/docs/raw" "$BASE/slides/raw"

echo "### [0] targets @ $(date -u +%H:%M:%S)"
REA list-browser-targets "$EP" --format json > "$BASE/targets.json" 2>"$BASE/targets.err"
echo "targets.json bytes: $(wc -c < "$BASE/targets.json")"

run_app () {
  local app="$1" tid="$2" origin="$3"
  local out="$BASE/$app/raw"
  echo "### [$app] STATIC analyze-web-bundle @ $(date -u +%H:%M:%S)"
  REA analyze-web-bundle "$EP" "$tid" --allowed-origins "$origin" --format json \
      > "$out/bundle.json" 2>"$out/bundle.err"
  echo "[$app] bundle.json bytes: $(wc -c < "$out/bundle.json") exit=$?"

  echo "### [$app] DYNAMIC inspect-web-page @ $(date -u +%H:%M:%S)"
  REA inspect-web-page "$EP" "$tid" \
      --allowed-origins "$origin" \
      --include-accessibility-text \
      --include-console-text \
      --format json \
      > "$out/inspect.json" 2>"$out/inspect.err"
  echo "[$app] inspect.json bytes: $(wc -c < "$out/inspect.json")"

  echo "### [$app] SCREENSHOT @ $(date -u +%H:%M:%S)"
  REA capture-web-screenshot "$EP" "$tid" --allowed-origins "$origin" --format json \
      > "$out/screenshot.json" 2>"$out/screenshot.err"
  echo "[$app] screenshot.json bytes: $(wc -c < "$out/screenshot.json")"
}

run_app docs  "$DOCS_TARGET"   "https://docs.google.com"
run_app slides "$SLIDES_TARGET" "https://docs.google.com"

echo "### DONE @ $(date -u +%H:%M:%S)"
