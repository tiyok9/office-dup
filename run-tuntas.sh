#!/usr/bin/env bash
# TUNTAS runner: for each app, RELAUNCH the scratch browser fresh (kills any
# leftover tab that contaminated v1), then run the clean probe. Also introspect
# the calcworker WASM with Node's real WebAssembly engine.
set -u
NODE="$HOME/AppData/Local/rea/node-v24.22.0-win-x64/node.exe"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
PROFILE='C:\Users\USER\rea-google\scratch-9333'
PROFILE_U='/c/Users/USER/rea-google/scratch-9333'
cd /d/program/google || exit 1
mkdir -p public/raw-cdp2

kill9333() {
  local pid
  pid=$(netstat -ano | grep ':9333' | grep LISTENING | awk '{print $5}' | head -1)
  if [ -n "${pid:-}" ]; then
    powershell.exe -NoProfile -Command "Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1
  fi
  sleep 3
}

launch9333() {
  powershell.exe -NoProfile -Command "Start-Process -FilePath 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList '--headless=new','--remote-debugging-port=9333','--remote-allow-origins=*','--user-data-dir=$PROFILE','--no-first-run','--no-default-browser-check','--disable-gpu','--disable-dev-shm-usage','about:blank'" >/dev/null 2>&1
  local i
  for i in $(seq 1 20); do
    if netstat -ano | grep -q ':9333.*LISTENING'; then sleep 3; return 0; fi
    sleep 1
  done
  echo "!! 9333 failed to listen"; return 1
}

run() {
  local app="$1" url="$2"
  echo "================================================================"
  echo "### $app — fresh browser"
  kill9333
  rm -rf "$PROFILE_U" 2>/dev/null
  launch9333 || return 1
  echo "pre-targets: $(curl -s -m 6 http://127.0.0.1:9333/json/list | grep -c '"type": "page"' || echo '?') page targets"
  MSYS2_ARG_CONV_EXCL='*' timeout 300 "$NODE" cdp-probe2.mjs "$url" "public/raw-cdp2/$app.json" "$app" 9333 2>&1 | sed "s/^/[$app] /"
  echo "[$app] json_bytes=$(wc -c < "public/raw-cdp2/$app.json" 2>/dev/null || echo 0)"
  sleep 2
}

run docs   "https://docs.google.com/document/d/0B2DZqTRLDhefWTFjWTVKeWMwalE/edit"
run slides "https://docs.google.com/presentation/d/1--vRBDTp0pf_Eck2Ga8XffBWn7gbUpnbuehkRnJE8vg/edit"
run sheets "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit"

echo "================================================================"
echo "### WASM introspection (Node WebAssembly.Module)"
MSYS2_ARG_CONV_EXCL='*' "$NODE" wasm-introspect.mjs public/sheets/calcworker_wasm_cd.wasm public/raw-cdp2/sheets_wasm.json 2>&1 | sed 's/^/[wasm] /'

echo "### static chunk-body grep (worker/wasm/sync markers)"
MSYS2_ARG_CONV_EXCL='*' python static_worker_wasm_grep.py 2>&1 | sed 's/^/[grep] /'

echo "### shutting down scratch 9333"
kill9333
echo "final ports:"; netstat -ano | grep -E ':(9222|9333)' || echo "(none)"
echo "ALL_TUNTAS_DONE"
