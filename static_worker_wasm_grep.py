#!/usr/bin/env python3
"""
static_worker_wasm_grep.py — fetch every captured /_/js/ chunk body and grep for
worker / WASM / sync markers. Penetrates the "token lives in the JS body, not the
URL" pitfall that made a URL-only grep a meaningless null.

Input : D:\\program\\google\\public\\raw-cdp\\*.json  (probe v1 net.jsChunks)
Output: D:\\program\\google\\public\\worker_wasm_static.json
"""
import json, os, re, urllib.request, hashlib, sys

SRC = r"D:\program\google\public\raw-cdp"
OUT = r"D:\program\google\public\worker_wasm_static.json"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"

PATTERNS = {
    "new Worker(":            re.compile(rb"new\s+Worker\s*\("),
    "SharedWorker":           re.compile(rb"SharedWorker"),
    "importScripts":          re.compile(rb"importScripts\s*\("),
    "serviceWorker.register": re.compile(rb"serviceWorker\.register"),
    "postMessage":            re.compile(rb"\.postMessage\s*\("),
    "WebAssembly":            re.compile(rb"WebAssembly\b"),
    ".wasm":                  re.compile(rb"\.wasm\b"),
    "wasmBinary":             re.compile(rb"wasmBinary"),
    "instantiateStreaming":   re.compile(rb"instantiateStreaming"),
    "calcworker":             re.compile(rb"calcworker"),
    "onmessage(worker)":      re.compile(rb"onmessage\s*="),
    "batchexecute":           re.compile(rb"batchexecute"),
    "BrowserChannel/bind":    re.compile(rb"/channel/bind|/bind\b"),
    "webchannel":             re.compile(rb"webchannel|WebChannel"),
    "OT mutation":            re.compile(rb"mutation|revision"),
}

def fetch(url, limit=6_000_000, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read(limit)
        if r.headers.get("Content-Encoding") == "gzip":
            try:
                import gzip; raw = gzip.decompress(raw)
            except Exception: pass
        return r.status, raw

results = {}
for app in ("docs", "slides", "sheets"):
    p = os.path.join(SRC, f"{app}.json")
    if not os.path.exists(p):
        print(f"{app}: MISSING {p}"); continue
    d = json.load(open(p, encoding="utf-8", errors="replace"))
    chunks = [u for u in ((d.get("net") or {}).get("jsChunks") or []) if "docs.google.com" in u]
    print(f"\n=== {app.upper()}: {len(chunks)} docs.google.com chunks ===")
    entries = []
    for u in chunks:
        e = {"url": u}
        try:
            st, body = fetch(u)
            e["status"] = st; e["bytes"] = len(body)
            e["sha256"] = hashlib.sha256(body).hexdigest()[:16]
            e["hits"] = {k: len(p.findall(body)) for k, p in PATTERNS.items()}
            e["hits"] = {k: v for k, v in e["hits"].items() if v}
            # capture the module name (m= param)
            m = re.search(r"[?&]m=([a-zA-Z0-9_,]+)", u)
            e["module"] = m.group(1) if m else None
        except Exception as ex:
            e["error"] = repr(ex)[:120]
        entries.append(e)
        print(f"  {e.get('status','ERR')} {e.get('bytes',0):>9,}  m={e.get('module')}  hits={e.get('hits')}")
    # aggregate
    agg = {}
    for e in entries:
        for k, v in (e.get("hits") or {}).items():
            agg[k] = agg.get(k, 0) + v
    results[app] = {"chunkCount": len(chunks), "aggregateHits": agg, "chunks": entries}
    print(f"  AGGREGATE: {agg}")

json.dump(results, open(OUT, "w"), indent=1)
print("\nwrote", OUT)
