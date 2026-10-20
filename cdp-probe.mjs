#!/usr/bin/env node
/**
 * cdp-probe.mjs — RAW CDP probe (no REA, no npm deps; Node>=22 global WebSocket)
 *
 * Closes three caveats REA structurally cannot close (its policy_filtered_sections
 * hide dom/frames/workers/resources/websocket_shapes):
 *   1A workers  — instrument Worker/SharedWorker/SW + enumerate CDP worker targets
 *   1B wasm     — instrument WebAssembly + perf entries + network mime + static grep
 *   2  endpoints— capture ALL Network.responseReceived (real load-time endpoints)
 *   3  scroll   — invariance-under-scroll test (virtualization proof) BEFORE/AFTER
 *
 * Usage: node cdp-probe.mjs <URL> <OUT.json> <APP> [PORT]
 */
import fs from 'node:fs';

const [url, outPath, appName, portArg] = process.argv.slice(2);
const PORT = portArg || '9333';
const BASE = `http://127.0.0.1:${PORT}`;
const T0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Injection must be installed BEFORE the app boots, else the constructors are
   already captured by the app and we see nothing. */
const INSTRUMENT = `(() => {
  const R = window.__rea_probe = { workers: [], sharedWorkers: [], serviceWorkers: [], wasm: [], swRegistrations: [], errors: [] };
  const rec = (k, v) => { try { R[k].push(String(v).slice(0, 300)); } catch (e) {} };
  try {
    const OW = window.Worker;
    if (OW) {
      const W = function Worker(...a) { rec('workers', (a[0] && a[0].url) ? a[0].url : a[0]); return Reflect.construct(OW, a, new.target || OW); };
      W.prototype = OW.prototype;
      try { Object.defineProperty(W, 'name', { value: 'Worker' }); } catch (e) {}
      window.Worker = W;
    }
  } catch (e) { rec('errors', 'Worker: ' + e); }
  try {
    const OS = window.SharedWorker;
    if (OS) {
      const S = function SharedWorker(...a) { rec('sharedWorkers', (a[0] && a[0].url) ? a[0].url : a[0]); return Reflect.construct(OS, a, new.target || OS); };
      S.prototype = OS.prototype;
      try { Object.defineProperty(S, 'name', { value: 'SharedWorker' }); } catch (e) {}
      window.SharedWorker = S;
    }
  } catch (e) { rec('errors', 'SharedWorker: ' + e); }
  try {
    const SWC = navigator.serviceWorker;
    if (SWC && SWC.register) {
      const O = SWC.register.bind(SWC);
      SWC.register = function (...a) { rec('serviceWorkers', a[0]); return O(...a); };
    }
  } catch (e) { rec('errors', 'SWContainer: ' + e); }
  try {
    if (!navigator.serviceWorker) rec('errors', 'no navigator.serviceWorker');
  } catch (e) {}
  try {
    const WA = window.WebAssembly;
    if (WA) {
      for (const m of ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']) {
        if (typeof WA[m] === 'function') {
          const O = WA[m].bind(WA);
          WA[m] = function (...a) {
            let d = '[bytes]';
            try { if (typeof a[0] === 'string') d = a[0]; else if (a[0] && a[0].url) d = a[0].url; } catch (e) {}
            rec('wasm', m + ' :: ' + d);
            return O(...a);
          };
        }
      }
      for (const C of ['Module', 'Instance']) {
        if (typeof WA[C] === 'function') {
          const OC = WA[C];
          const W = function (...a) {
            let d = '[bytes]';
            try { if (typeof a[0] === 'string') d = a[0]; else if (a[0] && a[0].url) d = a[0].url; else if (a[0] && a[0].byteLength) d = '[buffer ' + a[0].byteLength + ']'; } catch (e) {}
            rec('wasm', 'new ' + C + ' :: ' + d);
            return Reflect.construct(OC, a, new.target || OC);
          };
          W.prototype = OC.prototype;
          try { Object.defineProperty(W, 'name', { value: C }); } catch (e) {}
          WA[C] = W;
        }
      }
    }
  } catch (e) { rec('errors', 'WASM: ' + e); }
})();`;

const DOM_PROBE = `(() => ({
  href: location.href,
  title: document.title,
  readyState: document.readyState,
  nodes: document.getElementsByTagName('*').length,
  canvas: document.querySelectorAll('canvas').length,
  svg: document.querySelectorAll('svg').length,
  svgNodes: document.querySelectorAll('svg *').length,
  iframe: document.querySelectorAll('iframe').length,
  script: document.querySelectorAll('script').length,
  gridcell: document.querySelectorAll('[role="gridcell"]').length,
  gridrow: document.querySelectorAll('[role="row"]').length,
  rowheader: document.querySelectorAll('[role="rowheader"]').length,
  colheader: document.querySelectorAll('[role="columnheader"]').length,
  grid: document.querySelectorAll('[role="grid"]').length,
  contenteditable: document.querySelectorAll('[contenteditable="true"]').length,
  texteventtarget: document.querySelectorAll('[class*="texteventtarget"]').length,
  kixcanvas: document.querySelectorAll('[class*="kix-canvas-tile"]').length,
  kixpage: document.querySelectorAll('[class*="kix-page"]').length,
  editors: document.querySelectorAll('[class*="ritz"], [class*="waffle"]').length,
  inputs: document.querySelectorAll('input,textarea').length,
  inputsVisible: [...document.querySelectorAll('input,textarea')].filter(e => e.offsetParent !== null).length,
  typeofWebAssembly: typeof WebAssembly,
  typeofWorker: typeof Worker,
  typeofSharedWorker: typeof SharedWorker,
  swContainer: !!(navigator.serviceWorker),
  swController: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
  hwConcurrency: navigator.hardwareConcurrency,
  canvasInfo: [...document.querySelectorAll('canvas')].map(c => ({
    cls: String(c.className || '').slice(0, 90),
    w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight,
    parent: String((c.parentElement && c.parentElement.className) || '').slice(0, 70)
  })).slice(0, 12),
  perfWasm: performance.getEntriesByType('resource').filter(e => e.name.indexOf('.wasm') !== -1).map(e => e.name).slice(0, 20),
  perfJsChunks: performance.getEntriesByType('resource').filter(e => e.name.indexOf('/_/js/') !== -1).length,
  perfTotal: performance.getEntriesByType('resource').length,
  editables: [...document.querySelectorAll('[contenteditable], textarea, [class*="texteventtarget"], [class*="apptextinput"]')].map(e => ({
    tag: e.tagName, cls: String(e.className || '').slice(0, 80), ce: e.getAttribute('contenteditable'),
    vis: e.offsetParent !== null, w: e.clientWidth, h: e.clientHeight
  })).slice(0, 15),
  rowLabels: [...document.querySelectorAll('[role="rowheader"]')].map(e => (e.textContent || '').trim()).filter(Boolean).slice(0, 80),
  cellLabels: [...document.querySelectorAll('[role="gridcell"], [role="columnheader"]')].map(e => (e.textContent || '').trim()).filter(Boolean).slice(0, 80)
}))()`;

const SCROLL_FIND = `(() => {
  let best = null, bestD = 0;
  for (const el of document.querySelectorAll('div,main,section,[role="grid"],[role="presentation"],[role="document"]')) {
    const d = el.scrollHeight - el.clientHeight;
    const w = el.scrollWidth - el.clientWidth;
    const m = Math.max(d, w);
    if (m > bestD && el.clientHeight > 200 && el.clientWidth > 200) { bestD = m; best = el; }
  }
  if (!best) return { found: false };
  const before = {
    scrollTop: best.scrollTop, scrollLeft: best.scrollLeft,
    scrollHeight: best.scrollHeight, clientHeight: best.clientHeight,
    scrollWidth: best.scrollWidth, clientWidth: best.clientWidth,
    maxScroll: bestD,
    nodes: document.getElementsByTagName('*').length,
    canvas: document.querySelectorAll('canvas').length,
    rowLabels: [...document.querySelectorAll('[role="rowheader"]')].map(e => (e.textContent || '').trim()).filter(Boolean).slice(0, 80)
  };
  const step = Math.min(bestD, 3000);
  best.scrollTop = best.scrollTop + step;
  return { found: true, tag: best.tagName, cls: String(best.className || '').slice(0, 120), before, applied: step };
})()`;

const SCROLL_AFTER = `(() => ({
  scrollTop: (() => {
    let best = null, bestD = 0;
    for (const el of document.querySelectorAll('div,main,section,[role="grid"],[role="presentation"],[role="document"]')) {
      const d = el.scrollHeight - el.clientHeight;
      const w = el.scrollWidth - el.clientWidth;
      const m = Math.max(d, w);
      if (m > bestD && el.clientHeight > 200 && el.clientWidth > 200) { bestD = m; best = el; }
    }
    return best ? best.scrollTop : null;
  })(),
  nodes: document.getElementsByTagName('*').length,
  canvas: document.querySelectorAll('canvas').length,
  rowLabels: [...document.querySelectorAll('[role="rowheader"]')].map(e => (e.textContent || '').trim()).filter(Boolean).slice(0, 80)
}))()`;

/* ---------- boot ---------- */
let out = { app: appName, url, port: PORT, ts: new Date().toISOString(), ok: false, errors: [] };
let ws = null;

try {
  const ver = await (await fetch(`${BASE}/json/version`)).json();
  out.browser = ver.Browser;
  out.protocolVersion = ver['Protocol-Version'];
  log('browser:', ver.Browser);
  if (!ver.webSocketDebuggerUrl) throw new Error('no webSocketDebuggerUrl');

  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws connect failed')), { once: true });
    setTimeout(() => rej(new Error('ws connect timeout')), 20000);
  });
  log('cdp connected');

  let msgId = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.rej(new Error(`CDP ${p.method} :: ${JSON.stringify(m.error)}`));
      else p.res(m.result);
    } else if (m.method) events.push({ method: m.method, params: m.params, sessionId: m.sessionId });
  });
  const send = (method, params = {}, sid, timeoutMs = 45000) => {
    const id = ++msgId;
    const payload = { id, method, params };
    if (sid) payload.sessionId = sid;
    return new Promise((res, rej) => {
      pending.set(id, { res, rej, method });
      ws.send(JSON.stringify(payload));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`TIMEOUT ${method}`)); } }, timeoutMs);
    });
  };

  const evalJS = async (expr, sid, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, sid, 40000);
    if (r.exceptionDetails) return { __error: (r.exceptionDetails.text || '') + ' ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '') };
    return r.result ? r.result.value : undefined;
  };

  await send('Target.setDiscoverTargets', { discover: true });
  /* Chrome >=155 rejects width/height unless newWindow:true; create plain target
     then force the viewport via Emulation (also makes geometry deterministic). */
  const created = await send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.targetId;
  const att = await send('Target.attachToTarget', { targetId, flatten: true });
  const sid = att.sessionId;
  out.targetId = targetId; out.sessionId = sid;
  log('tab created:', targetId);
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  out.viewport = { width: 1280, height: 900 };

  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Network.enable', { maxTotalBufferSize: 80000000, maxResourceBufferSize: 8000000 }, sid);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT }, sid);
  log('instrumentation installed; navigating');

  await send('Page.navigate', { url }, sid);

  const loadDeadline = Date.now() + 75000;
  while (Date.now() < loadDeadline) {
    if (events.some((e) => e.method === 'Page.loadEventFired' && e.sessionId === sid)) break;
    await sleep(400);
  }
  log('load event seen; waiting for editor boot');
  await sleep(9000); // editors boot async well past loadEventFired

  out.instrumentationProbe = await evalJS('JSON.parse(JSON.stringify(window.__rea_probe || {missing:true}))', sid);
  out.pageInfo = await evalJS(DOM_PROBE, sid);
  log('pageInfo:', JSON.stringify(out.pageInfo && out.pageInfo.title), '| nodes', out.pageInfo && out.pageInfo.nodes);

  /* ---- screenshot BEFORE scroll ---- */
  try {
    const s = await send('Page.captureScreenshot', { format: 'png' }, sid, 40000);
    out.screenshotBefore = s.data;
  } catch (e) { out.errors.push('screenshotBefore: ' + e.message); }

  /* ---- scroll invariance test ---- */
  out.scrollFind = await evalJS(SCROLL_FIND, sid);
  if (out.scrollFind && out.scrollFind.found) {
    await sleep(3500);
    out.scrollAfter = await evalJS(SCROLL_AFTER, sid);
  } else {
    out.scrollAfter = { notApplicable: true, reason: 'no scrollable container >200px found' };
  }
  log('scroll test done; before nodes', out.scrollFind && out.scrollFind.before && out.scrollFind.before.nodes, '-> after', out.scrollAfter && out.scrollAfter.nodes);

  try {
    const s2 = await send('Page.captureScreenshot', { format: 'png' }, sid, 40000);
    out.screenshotAfter = s2.data;
  } catch (e) { out.errors.push('screenshotAfter: ' + e.message); }

  /* ---- network: ALL responses ---- */
  const responses = events.filter((e) => e.method === 'Network.responseReceived' && e.sessionId === sid)
    .map((e) => ({ url: e.params.response.url, status: e.params.response.status, mime: e.params.response.mimeType, type: e.params.type, fromSW: !!e.params.response.fromServiceWorker }));
  const uniq = new Map();
  for (const r of responses) uniq.set(r.url, r);
  out.net = { totalEvents: responses.length, uniqueUrls: uniq.size, responses: [...uniq.values()] };

  out.net.hosts = [...new Set([...uniq.values()].map((r) => { try { return new URL(r.url).host; } catch { return '?'; } }))];
  out.net.interesting = [...uniq.values()].filter((r) => /batchexecute|\/bind|channel|\/v[0-9]+\/|rpc|mutation|drive\.usercontent|docs\.google\.com\/_\/|wasm/i.test(r.url)).slice(0, 120);
  out.net.wasmResponses = [...uniq.values()].filter((r) => /wasm/i.test(r.mime || '') || /\.wasm(\?|$)/i.test(r.url));
  out.net.jsChunks = [...new Set([...uniq.values()].map((r) => r.url).filter((u) => /\/_\/js\//.test(u)))];

  out.webSockets = events.filter((e) => e.method === 'Network.webSocketCreated' && e.sessionId === sid).map((e) => e.params.url);
  out.wsFramesRecv = events.filter((e) => e.method === 'Network.webSocketFrameReceived' && e.sessionId === sid).length;
  out.wsFramesSent = events.filter((e) => e.method === 'Network.webSocketFrameSent' && e.sessionId === sid).length;
  out.workerEvents = events.filter((e) => /Worker|worker/i.test(e.method) && e.sessionId === sid).map((e) => e.method);

  /* ---- CDP target enumeration (workers!) ---- */
  const tg = await send('Target.getTargets');
  out.targets = (tg.targetInfos || []).map((t) => ({ type: t.type, url: t.url, title: t.title, attached: t.attached, targetId: t.targetId }));
  out.targetTypeCounts = out.targets.reduce((a, t) => { a[t.type] = (a[t.type] || 0) + 1; return a; }, {});
  out.workerTargets = out.targets.filter((t) => /worker/i.test(t.type));

  /* ---- in-page worker enumeration (not always visible via Target domain) ---- */
  out.perfWorkerScripts = await evalJS(
    `performance.getEntriesByType('resource').map(e=>e.name).filter(n=>/worker|calcworker|maestro|\\.wasm/i.test(n)).slice(0,40)`, sid);

  try { await send('Target.closeTarget', { targetId }); } catch (e) { out.errors.push('closeTarget: ' + e.message); }
  out.ok = true;
} catch (e) {
  out.errors.push('FATAL: ' + (e && e.message ? e.message : String(e)));
  log('FATAL', out.errors[out.errors.length - 1]);
} finally {
  try { if (ws && ws.readyState === 1) ws.close(); } catch {}
  const shallow = { ...out };
  delete shallow.screenshotBefore; delete shallow.screenshotAfter;
  fs.writeFileSync(outPath, JSON.stringify(shallow, null, 1));
  for (const [k, b64] of [['Before', out.screenshotBefore], ['After', out.screenshotAfter]]) {
    if (b64) {
      try { fs.writeFileSync(outPath.replace(/\.json$/, `.${k.toLowerCase()}.png`), Buffer.from(b64, 'base64')); } catch {}
    }
  }
  log('wrote', outPath, '| ok =', out.ok);
}
