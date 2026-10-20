#!/usr/bin/env bash
# Raw-CDP probe runner. Works around MSYS path mangling:
#   - cd into the app dir, use RELATIVE script/out paths
#   - MSYS2_ARG_CONV_EXCL='*' so args are not rewritten (D:\d\... bug)
set -u
NODE="$HOME/AppData/Local/rea/node-v24.22.0-win-x64/node.exe"
cd /d/program/google || exit 1
mkdir -p public/raw-cdp
echo "cwd=$(pwd)"
MSYS2_ARG_CONV_EXCL='*' "$NODE" -e 'console.log("node_ok", process.version)' || exit 1
echo "probe_exists=$(ls -la cdp-probe.mjs | awk '{print $5}') bytes"

run() {
  local app="$1" url="$2"
  echo "=================== $app ==================="
  echo "url: $url"
  MSYS2_ARG_CONV_EXCL='*' timeout 300 "$NODE" cdp-probe.mjs "$url" "public/raw-cdp/$app.json" "$app" 9333 2>&1 \
    | sed "s/^/[$app] /"
  echo "[$app] json_bytes=$(wc -c < "public/raw-cdp/$app.json" 2>/dev/null || echo 0)"
  echo
  sleep 4
}

run docs   "https://docs.google.com/document/d/0B2DZqTRLDhefWTFjWTVKeWMwalE/edit"
run slides "https://docs.google.com/presentation/d/1--vRBDTp0pf_Eck2Ga8XffBWn7gbUpnbuehkRnJE8vg/edit"
run sheets "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit"

echo "ALL_PROBES_DONE"
