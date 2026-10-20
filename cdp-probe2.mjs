#!/usr/bin/env node
/**
 * cdp-probe2.mjs — clean-attribution CDP probe (no REA, no npm; Node>=22 WebSocket)
 * Fixes the flaws of probe v1:
 *   - ATTRIBUTION: asserts/records the pre-existing target set so a worker target
 *     cannot be silently inherited from a leftover tab (v1 was contaminated).
 *     Caller relaunches the browser fresh per app.
 *   - WORKER IDENTITY: attaches to each worker target and reads self.location.
 *   - SCROLL: axis-aware, verifies the scroll actually moved, samples a text
 *     signature before/after, and can synthesize a wheel event.
 * Usage: node cdp-probe2.mjs <URL> <OUT.json> <APP> [PORT]
 */
import fs from 'node:fs';

const [url, outPath, appName, portArg] = process.argv.slice(2);
const PORT = portArg || '9333';
const BASE = `http://127.0.0.1:${PORT}`;
const T0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INSTRUMENT = `(() => {
  const R = window.__rea_probe = { workers: [], sharedWorkers: [], serviceWorkers: [], wasm: [], errors: [] };
  const rec = (k, v) => { try { R[k].push(String(v).slice(0, 400)); } catch (e) {} };
  try { const O = window.Worker;
    if (O) { const W = function Worker(...a) { rec('workers', (a[0] && a[0].url) ? a[0].url : a[0]); return Reflect.construct(O, a, new.target || O); };
      W.prototype = O.prototype; try { Object.defineProperty(W,'name',{value:'Worker'}); } catch(e){} window.Worker = W; } } catch (e) { rec('errors','Worker:'+e); }
  try { const O = window.SharedWorker;
    if (O) { const W = function SharedWorker(...a) { rec('sharedWorkers', (a[0] && a[0].url) ? a[0].url : a[0]); return Reflect.construct(O, a, new.target || O); };
      W.prototype = O.prototype; try { Object.defineProperty(W,'name',{value:'SharedWorker'}); } catch(e){} window.SharedWorker = W; } } catch (e) { rec('errors','SharedWorker:'+e); }
  try { const S = navigator.serviceWorker;
    if (S && S.register) { const O = S.register.bind(S); S.register = function(...a){ rec('serviceWorkers', a[0]); return O(...a); }; } } catch (e) { rec('errors','SW:'+e); }
  try { const WA = window.WebAssembly;
    if (WA) { for (const m of ['compile','instantiate','compileStreaming','instantiateStreaming']) {
        if (typeof WA[m] === 'function') { const O = WA[m].bind(WA); WA[m] = function(...a){ let d='[bytes]'; try { if (typeof a[0]==='string') d=a[0]; else if (a[0]&&a[0].url) d=a[0].url; } catch(e){} rec('wasm', m+' :: '+d); return O(...a); }; } }
      for (const C of ['Module','Instance']) { if (typeof WA[C] === 'function') { const OC = WA[C];
        const W = function(...a){ let d='[bytes]'; try { if (typeof a[0]==='string') d=a[0]; else if (a[0]&&a[0].url) d=a[0].url; else if (a[0]&&a[0].byteLength) d='[buffer '+a[0].byteLength+']'; } catch(e){} rec('wasm','new '+C+' :: '+d); return Reflect.construct(OC, a, new.target || OC); };
        W.prototype = OC.prototype; try { Object.defineProperty(W,'name',{value:C}); } catch(e){} WA[C] = W; } } } } catch (e) { rec('errors','WASM:'+e); }
})();`;

const SNAP = `(() => {
  const vis = (el) => el && el.offsetParent !== null;
  const txt = (sel, n) => [...document.querySelectorAll(sel)].filter(vis).map(e => (e.textContent||'').trim()).filter(Boolean).slice(0, n);
  let best = null, bestL = 0, bestAxis = null;
  for (const el of document.querySelectorAll('div,main,section')) {
    if (el.clientHeight < 150 || el.clientWidth < 250) continue;
    const dy = el.scrollHeight - el.clientHeight, dx = el.scrollWidth - el.clientWidth;
    const m = Math.max(dy, dx);
    if (m > bestL) { bestL = m; best = el; bestAxis = dx > dy ? 'x' : 'y'; }
  }
  return {
    href: location.href, title: document.title, readyState: document.readyState,
    nodes: document.getElementsByTagName('*').length,
    canvas: document.querySelectorAll('canvas').length,
    svg: document.querySelectorAll('svg').length,
    iframe: document.querySelectorAll('iframe').length,
    rowhdr: document.querySelectorAll('[role="rowheader"]').length,
    cell: document.querySelectorAll('[role="gridcell"]').length,
    editors: document.querySelectorAll('[class*="ritz"],[class*="waffle"]').length,
    ce: document.querySelectorAll('[contenteditable="true"]').length,
    tet: document.querySelectorAll('[class*="texteventtarget"]').length,
    kixTile: document.querySelectorAll('[class*="kix-canvas-tile"]').length,
    kixPage: document.querySelectorAll('[class*="kix-page"]').length,
    rowLabels: txt('[role="rowheader"]', 60),
    cellTexts: txt('[role="gridcell"],[role="columnheader"]', 60),
    textSample: [...document.querySelectorAll('div,span,text,p')].filter(vis).map(e => (e.textContent||'').trim()).filter(t => t && t.length < 90).slice(0, 60),
    scrollHost: best ? { tag: best.tagName, cls: String(best.className||'').slice(0,120), axis: bestAxis,
      scrollTop: best.scrollTop, scrollLeft: best.scrollLeft,
      scrollHeight: best.scrollHeight, clientHeight: best.clientHeight,
      scrollWidth: best.scrollWidth, clientWidth: best.clientWidth, max: bestL } : null,
    perfWasm: performance.getEntriesByType('resource').filter(e => e.name.indexOf('.wasm') !== -1).map(e => e.name),
    perfJs: performance.getEntriesByType('resource').filter(e => e.name.indexOf('/_/js/') !== -1).length,
    perfTotal: performance.getEntriesByType('resource').length
  };
})()`;

const DO_SCROLL = (step) => `(() => {
  let best = null, bestL = 0, axis = null;
  for (const el of document.querySelectorAll('div,main,section')) {
    if (el.clientHeight < 150 || el.clientWidth < 250) continue;
    const dy = el.scrollHeight - el.clientHeight, dx = el.scrollWidth - el.clientWidth;
    const m = Math.max(dy, dx);
    if (m > bestL) { bestL = m; best = el; axis = dx > dy ? 'x' : 'y'; }
  }
  if (!best) return { found: false };
  const before = { top: best.scrollTop, left: best.scrollLeft, axis, max: bestL };
  const s = Math.min(bestL, ${step});
  if (axis === 'x') best.scrollLeft = best.scrollLeft + s; else best.scrollTop = best.scrollTop + s;
  return { found: true, before, applied: s, rect: (() => { const r = best.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })() };
})()`;

let out = { app: appName, url, port: PORT, ts: new Date().toISOString(), ok: false, errors: [] };
let ws = null;

try {
  const ver = await (await fetch(`${BASE}/json/version`)).json();
  out.browser = ver.Browser;
  const pre = await (await fetch(`${BASE}/json/list`)).json();
  out.preExistingTargets = pre.map((t) => ({ type: t.type, url: (t.url||'').slice(0, 120) }));
  out.cleanStart = out.preExistingTargets.filter((t) => t.type === 'page').length === 0;
  log('cleanStart =', out.cleanStart, '| preExisting pages =', out.preExistingTargets.filter((t) => t.type === 'page').length);

  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws connect failed')), { once: true });
    setTimeout(() => rej(new Error('ws connect timeout')), 20000);
  });
  let msgId = 0; const pending = new Map(); const events = [];
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.rej(new Error(`CDP ${p.method} :: ${JSON.stringify(m.error)}`)); else p.res(m.result);
    } else if (m.method) events.push(m);
  });
  const send = (method, params = {}, sid, timeoutMs = 45000) => {
    const id = ++msgId; const payload = { id, method, params }; if (sid) payload.sessionId = sid;
    return new Promise((res, rej) => { pending.set(id, { res, rej, method }); ws.send(JSON.stringify(payload));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('TIMEOUT ' + method)); } }, timeoutMs); });
  };
  const evalJS = async (expr, sid) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid, 40000);
    if (r.exceptionDetails) return { __error: (r.exceptionDetails.text||'') };
    return r.result ? r.result.value : undefined;
  };

  await send('Target.setDiscoverTargets', { discover: true });
  const created = await send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.targetId;
  const sid = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  out.targetId = targetId;
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Network.enable', { maxTotalBufferSize: 80000000, maxResourceBufferSize: 8000000 }, sid);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT }, sid);
  await send('Page.navigate', { url }, sid);
  const dl = Date.now() + 75000;
  while (Date.now() < dl) { if (events.some((e) => e.method === 'Page.loadEventFired' && e.sessionId === sid)) break; await sleep(400); }
  log('loaded; waiting for editor boot');
  await sleep(10000);

  out.instrumentation = await evalJS('JSON.parse(JSON.stringify(window.__rea_probe||{missing:true}))', sid);
  out.before = await evalJS(SNAP, sid);
  log('title:', out.before && out.before.title, '| nodes', out.before && out.before.nodes, '| canvas', out.before && out.before.canvas);

  /* ---- worker targets + identity ---- */
  const tg = await send('Target.getTargets');
  out.targets = (tg.targetInfos||[]).map((t)=>({ type:t.type, url:t.url, title:t.title, attached:t.attached, targetId:t.targetId }));
  out.targetTypeCounts = out.targets.reduce((a,t)=>{a[t.type]=(a[t.type]||0)+1;return a;},{});
  out.workerTargets = [];
  for (const t of out.targets.filter((x)=>/worker/i.test(x.type))) {
    const rec = { type: t.type, url: t.url, targetId: t.targetId };
    try {
      const wsid = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
      await send('Runtime.enable', {}, wsid);
      rec.selfLocation = await evalJS('self.location.href', wsid);
      rec.name = await evalJS('self.name', wsid);
      rec.hasImportScripts = await evalJS('typeof importScripts', wsid);
      rec.hasWebAssembly = await evalJS('typeof WebAssembly', wsid);
      rec.isDedicated = await evalJS('typeof DedicatedWorkerGlobalScope', wsid);
    } catch (e) { rec.error = e.message; }
    out.workerTargets.push(rec);
  }
  log('worker targets:', JSON.stringify(out.workerTargets.map((w)=>w.selfLocation || w.url || '(empty)')));

  /* ---- screenshot before ---- */
  try { out.shotBefore = (await send('Page.captureScreenshot', { format: 'png' }, sid, 40000)).data; } catch (e) { out.errors.push('shotBefore: ' + e.message); }

  /* ---- scroll invariance (axis-aware, verified) ---- */
  out.scrollTry = await evalJS(DO_SCROLL(3000), sid);
  if (out.scrollTry && out.scrollTry.found) {
    if (out.scrollTry.rect) {
      try { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: out.scrollTry.rect.x, y: out.scrollTry.rect.y, deltaX: out.scrollTry.before.axis === 'x' ? 1200 : 0, deltaY: out.scrollTry.before.axis === 'y' ? 1200 : 0 }, sid, 30000); } catch (e) { out.errors.push('wheel: ' + e.message); }
    }
    await sleep(4500);
    out.after = await evalJS(SNAP, sid);
    const b = out.before || {}, a = out.after || {};
    out.scrollVerdict = {
      axis: out.scrollTry.before.axis,
      maxScroll: out.scrollTry.before.max,
      applied: out.scrollTry.applied,
      scrollMoved: !!(a.scrollHost && (a.scrollHost.scrollTop !== b.scrollHost.scrollTop || a.scrollHost.scrollLeft !== b.scrollHost.scrollLeft)),
      nodesBefore: b.nodes, nodesAfter: a.nodes, nodesDelta: (a.nodes||0) - (b.nodes||0),
      canvasBefore: b.canvas, canvasAfter: a.canvas,
      contentChanged: JSON.stringify(b.textSample) !== JSON.stringify(a.textSample),
    };
    log('scroll:', JSON.stringify(out.scrollVerdict));
  } else {
    out.after = null;
    out.scrollVerdict = { notApplicable: true, reason: 'no scroll host', tryResult: out.scrollTry };
  }
  try { out.shotAfter = (await send('Page.captureScreenshot', { format: 'png' }, sid, 40000)).data; } catch (e) { out.errors.push('shotAfter: ' + e.message); }

  /* ---- network ---- */
  const resps = events.filter((e)=>e.method==='Network.responseReceived' && e.sessionId===sid)
    .map((e)=>({ url: e.params.response.url, status: e.params.response.status, mime: e.params.response.mimeType, type: e.params.type, fromSW: !!e.params.response.fromServiceWorker }));
  const uniq = new Map(); for (const r of resps) uniq.set(r.url, r);
  out.net = { totalEvents: resps.length, uniqueUrls: uniq.size,
    responses: [...uniq.values()],
    hosts: [...new Set([...uniq.values()].map((r)=>{try{return new URL(r.url).host;}catch{return '?';}}))],
    wasm: [...uniq.values()].filter((r)=>/application\/wasm|\.wasm(\?|$)/i.test(r.mime + ' ' + r.url)),
    jsChunks: [...new Set([...uniq.values()].map((r)=>r.url).filter((u)=>/\/_\/js\//.test(u)))],
    proto: [...uniq.values()].filter((r)=>!/\.(woff2?|png|jpe?g|gif|svg|css|ico|js)(\?|$)/.test(r.url) && !/\/_\/js\//.test(r.url)),
  };
  out.webSockets = events.filter((e)=>e.method==='Network.webSocketCreated' && e.sessionId===sid).map((e)=>e.params.url);
  out.wsFrames = events.filter((e)=>/Network\.webSocketFrame/.test(e.method) && e.sessionId===sid).length;

  try { await send('Target.closeTarget', { targetId }); } catch (e) { out.errors.push('close: ' + e.message); }
  out.ok = true;
} catch (e) {
  out.errors.push('FATAL: ' + (e && e.message ? e.message : String(e)));
  log('FATAL', out.errors[out.errors.length-1]);
} finally {
  try { if (ws && ws.readyState === 1) ws.close(); } catch {}
  const sh = { ...out }; delete sh.shotBefore; delete sh.shotAfter;
  fs.writeFileSync(outPath, JSON.stringify(sh, null, 1));
  for (const [k,b64] of [['before', out.shotBefore], ['after', out.shotAfter]]) {
    if (b64) { try { fs.writeFileSync(outPath.replace(/\.json$/, `.${k}.png`), Buffer.from(b64,'base64')); } catch {} }
  }
  log('wrote', outPath, '| ok =', out.ok);
}
