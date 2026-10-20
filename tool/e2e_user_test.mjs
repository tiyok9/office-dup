// D:\program\google\tool\e2e_user_test.mjs
// UJI E2E TINGKAT USER — klik mouse & ketik keyboard NYATA via CDP.
// Chrome headless TERISOLASI (profil scratch, port debug 9445). Port 9222 TIDAK disentuh.
// Prinsip: setiap dokumen uji DIBUAT lewat klik UI, seed data asli TIDAK dimutasi.

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9445;
const PROFILE = 'C:/Users/USER/rea-google/scratch-e2e';
const SHOTS = 'D:/program/google/public/shots';
const DIALOG_TEXT = 'DIPERBARUI-OLEH-USER';

// ==== ISOLASI STORE (agar E2E tidak mencemari Drive/demo) ====
// E2E menjalankan SERVER SENDIRI di port terpisah, memakai direktori store
// sekali-pakai (dev/store-e2e). Server demo di 8765 (beserta data user) tidak
// pernah disentuh. Bila env E2E_USE_EXTERNAL_SERVER=1, pakai server luar apa adanya.
const NODE = process.env.E2E_NODE || 'C:/Users/USER/AppData/Local/rea/node-v24.22.0-win-x64/node.exe';
const EXTERNAL = process.env.E2E_USE_EXTERNAL_SERVER === '1';
const API_PORT = EXTERNAL ? 8765 : 9450;
const STORE_E2E = 'D:/program/google/tool/dev/store-e2e';
const APP_URL = `http://127.0.0.1:${API_PORT}/`;
const API = `http://127.0.0.1:${API_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PASS = 0, FAIL = 0;
const results = [];
const pageErrors = [];
const consoleErrors = [];

function check(name, ok, detail = '') {
  if (ok) PASS++; else FAIL++;
  const line = `${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' :: ' + detail : ''}`;
  results.push(line);
  console.log('  ' + line);
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    });
  }
  on(fn) { this.handlers.push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }
  async waitFor(expr, timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch {}
      await sleep(120);
    }
    return false;
  }
  // Klik elemen berdasar ekspresi JS (mengembalikan elemen).
  // Dua syarat wajib agar ini menyerupai klik user nyata:
  //   1. Titik klik harus DI DALAM viewport. Elemen tinggi (kanvas Kix 900px,
  //      top ~546px) punya titik tengah di luar layar, sehingga klik "pusat
  //      elemen" tidak akan pernah mendarat.
  //   2. Titik harus benar-benar MENGENAI elemen (atau keturunannya). Menerima
  //      leluhur (`hit.contains(e)`) salah: handler klik dipasang pada elemen,
  //      bukan pada pembungkusnya — klik di area pembungkus jadi tidak berbuat apa-apa.
  async click(jsExpr, clickCount = 1) {
    // 0. Gulir elemen ke tengah viewport lebih dulu — persis perilaku user saat
    //    daftar panjang (kartu Drive bertambah, tombol bisa jatuh di bawah
    //    lipatan layar). Tanpa ini, klik "gagal" padahal user hanya perlu scroll.
    await this.eval(`(() => { const e = ${jsExpr}; if (e && e.scrollIntoView) { try { e.scrollIntoView({ block: 'center', inline: 'center' }); } catch (err) {} } return true; })()`);
    await sleep(250);
    const r = await this.eval(`(() => {
      const e = ${jsExpr};
      if (!e) return null;
      const b = e.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      // Sapu dari tengah ke atas: elemen sangat tinggi (kanvas Kix 900px) punya
      // titik tengah di luar viewport, sehingga hanya bagian atasnya yang bisa
      // diklik user.
      const fxList = [0.5, 0.25, 0.75, 0.1, 0.9];
      const fyList = [0.5, 0.4, 0.3, 0.2, 0.1, 0.05];
      for (const fy of fyList) {
        for (const fx of fxList) {
          const x = b.left + b.width * fx, y = b.top + b.height * fy;
          if (x < 2 || y < 2 || x > vw - 2 || y > vh - 2) continue;
          const hit = document.elementFromPoint(x, y);
          if (hit && (hit === e || e.contains(hit))) return { x: Math.round(x), y: Math.round(y) };
        }
      }
      return null;
    })()`);
    if (!r) throw new Error('Titik klik tidak terjangkau viewport untuk: ' + jsExpr);
    await this.clickAt(r.x, r.y, clickCount);
  }
  async clickAt(x, y, clickCount = 1) {
    // Lindungi dari koordinat tidak valid. Chrome menolak dispatchMouseEvent
    // dengan "double value expected" dan SELURUH skrip E2E berhenti, sehingga
    // kegagalan sesungguhnya (target tak terjangkau) tertutup oleh error lain.
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`clickAt: koordinat tidak valid (${x}, ${y}) — target tidak terjangkau?`);
    }
    const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y, clickCount: 0 });
    if (clickCount === 2) {
      // Urutan dblclick standar: press/release (count 1) lalu press/release (count 2)
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, clickCount: 1 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, clickCount: 1 });
      await sleep(40);
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, clickCount: 2 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, clickCount: 2 });
    } else {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    }
    await sleep(200);
  }
  // Ctrl+A nyata: butuh virtual key code, jika tidak browser tidak mengenali select-all
  async selectAll() {
    const k = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    await sleep(90);
  }
  // Titik layar yang benar-benar mengenai elemen (seperti user membidik dengan mata)
  async hitPoint(sel) {
    const s = JSON.stringify(sel);
    return await this.eval(`(() => {
      const el = document.querySelector(${s});
      if (!el) return null;
      const b = el.getBoundingClientRect();
      for (let dx = 3; dx < b.width - 2; dx += 3) {
        for (let dy = 3; dy < b.height - 2; dy += 3) {
          const x = b.left + dx, y = b.top + dy;
          const hit = document.elementFromPoint(x, y);
          if (hit === el || (hit && hit.getAttribute && el.getAttribute('data-element-id') && hit.getAttribute('data-element-id') === el.getAttribute('data-element-id'))) return { x, y };
        }
      }
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`);
  }
  // Koordinat pusat sel grid Sheets (row 1-based, col 0-based)
  async cellXY(col, row) {
    const o = await this.eval('(() => { const c = document.getElementById("sheetsGridCanvas"); const b = c.getBoundingClientRect(); return { left: b.left, top: b.top }; })()');
    return { x: o.left + 46 + col * 110 + 55, y: o.top + 28 + (row - 1) * 26 + 13 };
  }
  // Koordinat layar dari koordinat viewBox SVG Slides (960x540)
  async svgXY(vx, vy) {
    return await this.eval(`(() => { const s = document.getElementById("punchSvgStage"); const b = s.getBoundingClientRect(); return { x: b.left + ${vx} * b.width / 960, y: b.top + ${vy} * b.height / 540 }; })()`);
  }
  async drag(from, to) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.x), y: Math.round(from.y) });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(from.x), y: Math.round(from.y), button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', button: 'left',
        x: Math.round(from.x + (to.x - from.x) * i / 6),
        y: Math.round(from.y + (to.y - from.y) * i / 6)
      });
      await sleep(30);
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(to.x), y: Math.round(to.y), button: 'left', clickCount: 1 });
    await sleep(250);
  }
  // Tombol edit (Backspace/Delete) butuh virtual key code; tanpa itu Chrome
  // tidak menghasilkan penghapusan teks pada input (bukan perilaku user nyata).
  async key(key, modifiers = 0) {
    const VK = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
    const p = { key, modifiers };
    if (VK[key]) { p.windowsVirtualKeyCode = VK[key]; p.nativeVirtualKeyCode = VK[key]; }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...p });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await sleep(60);
  }
  async type(str) {
    for (const ch of str) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      await sleep(22);
    }
  }
  async insertText(str) {
    await this.send('Input.insertText', { text: str });
    await sleep(80);
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const p = `${SHOTS}/${file}`;
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return fs.statSync(p).size;
  }
}

async function apiList() { const r = await fetch(`${API}/api/documents`); return r.ok ? r.json() : null; }
async function apiGet(id) { const r = await fetch(`${API}/api/documents/${id}`); return r.ok ? r.json() : null; }

// Windows sering menahan handle profil Chrome sesaat setelah proses mati -> EPERM.
async function cleanProfile() {
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); return; }
    catch { await sleep(400); }
  }
}

let chrome = null, ws = null, server = null;

// Jalankan server uji sekali-pakai: port API_PORT + store dev/store-e2e.
// Server demo 8765 dan data user TIDAK disentuh sama sekali.
async function startIsolatedServer() {
  if (EXTERNAL) return;
  fs.rmSync(STORE_E2E, { recursive: true, force: true });
  fs.mkdirSync(STORE_E2E, { recursive: true });
  server = spawn(NODE, ['server.mjs'], {
    cwd: 'D:/program/google/tool',
    env: { ...process.env, PORT: String(API_PORT), WORKSPACE_STORE_DIR: STORE_E2E },
    stdio: 'ignore'
  });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${API}/api/documents`);
      if (r.ok) { await r.json(); return; }
    } catch {}
    await sleep(250);
  }
  throw new Error(`Server uji terisolasi gagal siap di port ${API_PORT}`);
}

async function stopIsolatedServer() {
  if (EXTERNAL || !server) return;
  await new Promise((res) => execFile('taskkill', ['/F', '/T', '/PID', String(server.pid)], () => res()));
  server = null;
  await sleep(300);
  try { fs.rmSync(STORE_E2E, { recursive: true, force: true }); } catch {}
}

(async () => {
  console.log('================================================================');
  console.log(' UJI E2E USER — Dashboard Google Workspace (klik & ketik nyata)');
  console.log('================================================================');

  await startIsolatedServer();
  console.log(`  Server uji: ${API}  (store: ${EXTERNAL ? 'store/ produksi' : STORE_E2E})`);
  await cleanProfile();
  chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
    '--disable-gpu', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-breakpad', '--no-sandbox',
    '--window-size=1280,900',
    'about:blank'
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) { wsUrl = t.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(250);
  }
  if (!wsUrl) throw new Error('Chrome debug port tidak aktif');

  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);

  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const t = msg.params.args.map(a => a.value || a.description || '').join(' ');
      if (!/favicon/i.test(t)) consoleErrors.push(t);
    }
    if (msg.method === 'Page.javascriptDialogOpening') {
      cdp.send('Page.handleJavaScriptDialog', {
        accept: true,
        promptText: msg.params.type === 'prompt' ? DIALOG_TEXT : undefined
      }).catch(() => {});
    }
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  const seedBefore = (await apiList() || []).map(d => d.id).sort();

  // ================= S0 =================
  console.log('\n--- S0: Boot halaman & inisialisasi shell ---');
  await cdp.send('Page.navigate', { url: APP_URL });
  await cdp.waitFor('!!window.workspaceApp');
  await sleep(900);

  // Instrumentasi: catat setiap pemakaian dialog bawaan browser. Editor teks
  // Slide harus memakai input in-place, BUKAN window.prompt.
  await cdp.eval('(() => { window.__promptCalls = []; const orig = window.prompt; window.prompt = function (...a) { window.__promptCalls.push(String(a[0] || "")); return orig.apply(window, a); }; })()');

  check('Halaman memuat & WorkspaceAppShell ter-inisialisasi', await cdp.eval('!!window.workspaceApp'));
  check('Editor Kix (Docs) ter-instansiasi', await cdp.eval('!!window.workspaceApp.kix'));
  check('Editor Ritz (Sheets) ter-instansiasi', await cdp.eval('!!window.workspaceApp.ritz'));
  check('Editor Punch (Slides) ter-instansiasi', await cdp.eval('!!window.workspaceApp.punch'));
  check('Tidak ada exception JS saat boot', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  const tileCount = await cdp.eval('document.querySelectorAll("#docsScrollBox .kix-page").length');
  // Jumlah tile mengikuti PAGINASI DINAMIS (bisa >1 halaman). Yang diuji adalah
  // kanvas benar-benar ter-render tanpa infinite loop, bukan angka tetap.
  check('Kanvas tile Docs ter-render (tanpa infinite loop)', tileCount >= 1, 'tile=' + tileCount);
  check('Judul dokumen seed termuat', (await cdp.eval('document.getElementById("docTitle").value')) === '2002 Nominee List (1).docx');
  check('Doctor: seluruh kelas editor global tersedia', await cdp.eval('!!window.KixDocsEditor && !!window.RitzSpreadsheetEditor && !!window.PunchSlidesEditor && !!window.WorkspaceAppShell'));
  check('Doctor: method kritis ada (applyFormat/applyFormatting/startPresentationMode)', await cdp.eval('typeof window.workspaceApp.ritz.applyFormat === "function" && typeof window.workspaceApp.kix.applyFormatting === "function" && typeof window.workspaceApp.punch.startPresentationMode === "function"'));

  // ================= S1: DRIVE — buat dokumen baru lewat klik =================
  console.log('\n--- S1: Drive Hub — buat dokumen baru via klik tombol ---');
  await cdp.click('document.getElementById("tab-drive")');
  check('Tab Drive aktif', (await cdp.eval('getComputedStyle(document.getElementById("view-drive")).display')) !== 'none');
  const cardsBefore = await cdp.eval('document.querySelectorAll("#driveGridContainer .drive-card").length');
  check('Kartu Drive ter-render dari API store', cardsBefore === seedBefore.length, `kartu=${cardsBefore} seed=${seedBefore.length}`);
  const thumbLoaded = await cdp.eval('(() => { const i = document.querySelector("#driveGridContainer img"); return i ? (i.naturalWidth > 0) : false; })()');
  check('Thumbnail screenshot kartu Drive benar-benar termuat', thumbLoaded);

  await cdp.click('([...document.querySelectorAll(".new-doc-btn")].find(b => b.textContent.includes("Dokumen Baru")))');
  await sleep(1300);
  const docsId = await cdp.eval('window.workspaceApp.currentDocId');
  check('Klik "+ Dokumen Baru" membuat & membuka dokumen baru', /^docs-/.test(docsId || ''), 'id=' + docsId);
  check('Tab otomatis pindah ke Docs', (await cdp.eval('window.workspaceApp.currentApp')) === 'docs');

  // ================= S2: DOCS (Kix) — ketik & format nyata =================
  console.log('\n--- S2: Google Dokumen (Kix) — ketik & format nyata ---');
  await cdp.click('document.querySelector("#docsScrollBox .kix-page canvas")');
  check('Klik kanvas menfokuskan interceptor input Kix', (await cdp.eval('document.activeElement && document.activeElement.id')) === 'kixHiddenInput');

  const lineBefore = await cdp.eval('window.workspaceApp.kix.pages[0].lines[window.workspaceApp.kix.activeLineIdx].text');
  await cdp.type('DIKETIK-OLEH-USER');
  const lineAfter = await cdp.eval('window.workspaceApp.kix.pages[0].lines[window.workspaceApp.kix.activeLineIdx].text');
  check('Ketikan keyboard nyata masuk ke model teks Kix', lineAfter.includes('DIKETIK-OLEH-USER'), `"${lineBefore}" -> "${lineAfter}"`);

  // Semua asersi berikut RELATIF terhadap baris yang benar-benar terpilih oleh
  // klik user (bukan indeks hard-coded), karena posisi klik menentukan baris aktif.
  const baseIdx = await cdp.eval('window.workspaceApp.kix.activeLineIdx');
  const linesBefore = await cdp.eval('window.workspaceApp.kix.pages[0].lines.length');
  await cdp.key('Enter');
  await cdp.type('baris baru');
  const linesAfter = await cdp.eval('window.workspaceApp.kix.pages[0].lines.length');
  check('Tombol Enter membuat baris baru', linesAfter === linesBefore + 1, `${linesBefore} -> ${linesAfter}`);

  const curIdx = await cdp.eval('window.workspaceApp.kix.activeLineIdx');
  check('Kursor berada di baris baru hasil Enter', curIdx === baseIdx + 1, `base=${baseIdx} cur=${curIdx}`);
  const beforeBackspace = await cdp.eval(`window.workspaceApp.kix.pages[0].lines[${curIdx}].text`);
  await cdp.key('Backspace');
  const afterBackspace = await cdp.eval(`window.workspaceApp.kix.pages[0].lines[${curIdx}].text`);
  check('Backspace menghapus 1 karakter terakhir', afterBackspace === beforeBackspace.slice(0, -1), `"${beforeBackspace}" -> "${afterBackspace}"`);

  await cdp.key('ArrowUp');
  const upIdx = await cdp.eval('window.workspaceApp.kix.activeLineIdx');
  check('Panah Atas memindah kursor ke baris sebelumnya', upIdx === curIdx - 1, 'activeLineIdx=' + upIdx);

  const boldBefore = await cdp.eval(`!!window.workspaceApp.kix.pages[0].lines[${upIdx}].bold`);
  await cdp.click('document.getElementById("tbBold")');
  const boldAfter = await cdp.eval(`!!window.workspaceApp.kix.pages[0].lines[${upIdx}].bold`);
  check('Toolbar "B" (Bold) mengubah baris aktif', boldBefore !== boldAfter, `${boldBefore} -> ${boldAfter}`);

  const sizeBefore = await cdp.eval(`window.workspaceApp.kix.pages[0].lines[${upIdx}].size`);
  await cdp.eval(`(() => { const sel = document.getElementById("tbFontSize"); sel.value = "24"; sel.dispatchEvent(new Event("change")); })()`);
  const sizeAfter = await cdp.eval(`window.workspaceApp.kix.pages[0].lines[${upIdx}].size`);
  check('Dropdown ukuran font mengubah ukuran baris aktif', sizeBefore !== sizeAfter, `${sizeBefore} -> ${sizeAfter}`);

  const canvasPainted = await cdp.eval('(() => { const c = document.getElementById("kixCanvas1"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; })()');
  check('Kanvas Kix benar-benar ter-paint (piksel non-transparan)', canvasPainted > 5000, 'piksel=' + canvasPainted);

  // Regresi word-wrap: TIDAK boleh ada segmen teks yang meluber keluar margin kanvas.
  // Bug ini lolos asersi model (line.text tetap benar) tetapi teks tak terlihat oleh
  // user — jadi harus diuji pada geometri render nyata.
  const wrapCheck = await cdp.eval(`(() => {
    const kix = window.workspaceApp.kix;
    const canvas = document.getElementById("kixCanvas1");
    const ctx = canvas.getContext("2d");
    const margin = 30, maxW = canvas.width - 60;
    let worst = 0, overflowLines = 0, totalSegs = 0;
    for (const p of kix.pages) {
      for (const line of p.lines) {
        if (!line.text) continue;
        const segs = kix.wrapSegmentsFor(canvas, line.text, line.size || 13, line.bold, line.italic);
        totalSegs += segs.length;
        for (const s of segs) {
          let st = ""; if (line.italic) st += "italic "; if (line.bold) st += "bold ";
          ctx.font = st + (line.size || 13) + "px Arial, sans-serif";
          const w = ctx.measureText(s.text).width;
          if (w > worst) worst = Math.round(w);
          if (w > maxW) overflowLines++;
        }
      }
    }
    return JSON.stringify({ maxSegPx: worst, availPx: maxW, overflowSegs: overflowLines, totalSegs });
  })()`);
  const wrap = JSON.parse(wrapCheck);
  check('Word-wrap: tidak ada segmen teks meluber keluar margin kanvas', wrap.overflowSegs === 0 && wrap.maxSegPx <= wrap.availPx, `segmen maks=${wrap.maxSegPx}px / tersedia=${wrap.availPx}px, overflow=${wrap.overflowSegs}`);

  const words = await cdp.eval('window.workspaceApp.kix.calculateWordCount()');
  check('Penghitung kata berjalan', typeof words === 'number' && words > 0, 'kata=' + words);
  const statusText = await cdp.eval('document.getElementById("docsStatusText").innerText');
  check('Status bar menampilkan halaman & jumlah kata', /Halaman \d+ dari \d+/.test(statusText), statusText.trim());

  await sleep(1800);
  const saveStatus = await cdp.eval('document.getElementById("saveStatusIndicator").innerText');
  check('Indikator autosave menyatakan tersimpan di Drive', saveStatus.includes('disimpan'), saveStatus.trim());

  const persistedDoc = await apiGet(docsId);
  check('Autosave benar-benar tertulis ke disk (dibaca ulang via API)', JSON.stringify(persistedDoc?.data || {}).includes('DIKETIK-OLEH-USER'));
  const szDocs = await cdp.shot('test_user_docs.png');
  check('Screenshot Docs tersimpan (bukan blank)', szDocs > 20000, szDocs + ' bytes');

  // ================= S3: SHEETS (Ritz) =================
  console.log('\n--- S3: Google Spreadsheet (Ritz) — sel, navigasi & formula nyata ---');
  await cdp.click('document.getElementById("tab-drive")');
  await cdp.click('([...document.querySelectorAll(".new-doc-btn")].find(b => b.textContent.includes("Spreadsheet Baru")))');
  await sleep(1300);
  const sheetsId = await cdp.eval('window.workspaceApp.currentDocId');
  check('Klik "+ Spreadsheet Baru" membuat & membuka spreadsheet baru', /^sheets-/.test(sheetsId || ''), 'id=' + sheetsId);
  check('Tab otomatis pindah ke Sheets', (await cdp.eval('window.workspaceApp.currentApp')) === 'sheets');

  let p = await cdp.cellXY(2, 1);
  await cdp.clickAt(p.x, p.y);
  check('Klik kanvas grid memilih sel C1', (await cdp.eval('window.workspaceApp.ritz.getActiveCoord()')) === 'C1');
  check('Kotak nama sel (Name Box) sinkron', (await cdp.eval('document.getElementById("sheetActiveCell").innerText')) === 'C1');

  await cdp.key('ArrowRight');
  check('Panah Kanan memindah seleksi ke D1', (await cdp.eval('window.workspaceApp.ritz.getActiveCoord()')) === 'D1');
  await cdp.key('ArrowDown');
  check('Panah Bawah memindah seleksi ke D2', (await cdp.eval('window.workspaceApp.ritz.getActiveCoord()')) === 'D2');

  for (const [row, val] of [[2, '120'], [3, '45'], [4, '85']]) {
    const q = await cdp.cellXY(2, row);
    await cdp.clickAt(q.x, q.y);
    await cdp.click('document.getElementById("sheetFormulaInput")');
    await cdp.selectAll();
    await cdp.insertText(val);
    await cdp.click('([...document.querySelectorAll(".calc-btn")][0])');
    await sleep(500);
  }
  const c2 = await cdp.eval('window.workspaceApp.ritz.cells["C2"] && window.workspaceApp.ritz.cells["C2"].val');
  const c3 = await cdp.eval('window.workspaceApp.ritz.cells["C3"] && window.workspaceApp.ritz.cells["C3"].val');
  const c4 = await cdp.eval('window.workspaceApp.ritz.cells["C4"] && window.workspaceApp.ritz.cells["C4"].val');
  check('Ketikan nilai sel C2/C3/C4 tersimpan (120/45/85)', c2 === 120 && c3 === 45 && c4 === 85, `${c2}/${c3}/${c4}`);

  const q1 = await cdp.cellXY(2, 1);
  await cdp.clickAt(q1.x, q1.y);
  await cdp.click('document.getElementById("sheetFormulaInput")');
  await cdp.selectAll();
  await cdp.insertText('=SUM(C2:C4)');
  await cdp.click('([...document.querySelectorAll(".calc-btn")][0])');
  await sleep(700);
  const c1v = await cdp.eval('window.workspaceApp.ritz.cells["C1"] && window.workspaceApp.ritz.cells["C1"].val');
  check('Formula =SUM(C2:C4) ter-evaluasi jadi 250 di grid', c1v === 250, 'C1.val=' + c1v);

  const gridPainted = await cdp.eval('(() => { const c = document.getElementById("sheetsGridCanvas"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; })()');
  check('Kanvas grid Sheets benar-benar ter-paint', gridPainted > 5000, 'piksel=' + gridPainted);

  // bukti evaluasi DINAMIS: ubah C2 -> C1 harus ikut berubah otomatis
  const q2 = await cdp.cellXY(2, 2);
  await cdp.clickAt(q2.x, q2.y);
  await cdp.click('document.getElementById("sheetFormulaInput")');
  await cdp.selectAll();
  await cdp.insertText('200');
  await cdp.click('([...document.querySelectorAll(".calc-btn")][0])');
  await sleep(800);
  const c1recalc = await cdp.eval('window.workspaceApp.ritz.cells["C1"] && window.workspaceApp.ritz.cells["C1"].val');
  check('Evaluasi dinamis: C2=200 membuat C1 otomatis jadi 330', c1recalc === 330, 'C1.val=' + c1recalc);

  await sleep(1800);
  const persistedSheets = await apiGet(sheetsId);
  const pCells = persistedSheets?.data?.cells || {};
  check('Spreadsheet tersimpan ke disk dengan val & raw benar', pCells['C1']?.val === 330 && pCells['C2']?.val === 200, `C1=${pCells['C1']?.val} C2=${pCells['C2']?.val}`);
  const szSheets = await cdp.shot('test_user_sheets.png');
  check('Screenshot Sheets tersimpan', szSheets > 20000, szSheets + ' bytes');

  // ================= S4: SLIDES (Punch) =================
  console.log('\n--- S4: Google Slide (Punch) — filmstrip, tambah slide, drag, dialog, presentasi ---');
  await cdp.click('document.getElementById("tab-drive")');
  await cdp.click('([...document.querySelectorAll(".new-doc-btn")].find(b => b.textContent.includes("Presentasi Baru")))');
  await sleep(1300);
  const slidesId = await cdp.eval('window.workspaceApp.currentDocId');
  check('Klik "+ Slide Baru" membuat & membuka presentasi baru', /^slides-/.test(slidesId || ''), 'id=' + slidesId);
  check('Tab otomatis pindah ke Slides', (await cdp.eval('window.workspaceApp.currentApp')) === 'slides');
  check('Stage Slides murni SVG (0 elemen canvas)', (await cdp.eval('document.querySelectorAll("#view-slides canvas").length')) === 0);

  await cdp.click('([...document.querySelectorAll("#slidesFilmstrip div")].find(d => d.textContent.includes("+ Slide Baru")))');
  await sleep(500);
  check('Klik "+ Slide Baru" menambah slide (1 -> 2)', (await cdp.eval('window.workspaceApp.punch.slides.length')) === 2);
  const thumbCount = await cdp.eval('document.querySelectorAll("#slidesFilmstrip .filmstrip-item").length');
  check('Filmstrip menampilkan seluruh slide', thumbCount === 2, 'thumb=' + thumbCount);

  await cdp.click('document.querySelectorAll("#slidesFilmstrip .filmstrip-item")[0]');
  check('Klik thumbnail memindah slide aktif ke 1', (await cdp.eval('window.workspaceApp.punch.activeSlideIdx')) === 0);
  await cdp.click('document.querySelectorAll("#slidesFilmstrip .filmstrip-item")[1]');
  check('Klik thumbnail memindah slide aktif ke 2', (await cdp.eval('window.workspaceApp.punch.activeSlideIdx')) === 1);
  check('Stage SVG berganti mengikuti slide aktif', (await cdp.eval('document.getElementById("punchSvgStage").textContent')).includes('Judul Slide 2'));

  const dragSel = '#punchSvgStage [data-element-id]';
  const targetId = await cdp.eval('window.workspaceApp.punch.getActiveSlide().elements.find(e => e.type === "text").id');
  const hp = await cdp.hitPoint(`#punchSvgStage [data-element-id="${targetId}"]`);
  const posBefore = await cdp.eval(`JSON.stringify((() => { const e = window.workspaceApp.punch.getActiveSlide().elements.find(x => x.id === "${targetId}"); return { x: e.x, y: e.y }; })())`);
  await cdp.drag(hp, { x: hp.x + 70, y: hp.y + 50 });
  const posAfter = await cdp.eval(`JSON.stringify((() => { const e = window.workspaceApp.punch.getActiveSlide().elements.find(x => x.id === "${targetId}"); return { x: e.x, y: e.y }; })())`);
  check('Drag & drop elemen di stage SVG mengubah koordinat', posBefore !== posAfter, `${posBefore} -> ${posAfter}`);

  // Ubah-ukuran lewat 8 handle (ala Google Slides) — bukan hanya drag.
  const rectBefore = await cdp.eval('(() => { const els = window.workspaceApp.punch.getActiveSlide().elements; const el = els.find(x => x.type === "rect" && x.x > 0 && x.y > 0 && (x.x + x.width) < 900 && (x.y + x.height) < 520) || els.find(x => x.type === "rect") || els[0]; return JSON.stringify({ id: el.id, w: el.width || el.r * 2, h: el.height || el.r * 2 }); })()');
  const rb = JSON.parse(rectBefore);
  await cdp.eval(`window.workspaceApp.punch.selectedElementId = "${rb.id}"; window.workspaceApp.punch.renderStage();`);
  await sleep(300);
  const handleCount = await cdp.eval('document.querySelectorAll("#punchSvgStage [data-handle]").length');
  check('Elemen terpilih menampilkan 8 handle ubah-ukuran', handleCount === 8, 'handle=' + handleCount);

  const sePoint = await cdp.eval('(() => { const h = document.querySelector(\'#punchSvgStage [data-handle="se"]\'); if (!h) return null; const b = h.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()');
  await cdp.drag(sePoint, { x: sePoint.x + 40, y: sePoint.y + 30 });
  const rectAfter = await cdp.eval(`JSON.stringify((() => { const el = window.workspaceApp.punch.getActiveSlide().elements.find(x => x.id === "${rb.id}"); return { w: el.width || el.r * 2, h: el.height || el.r * 2 }; })())`);
  const ra = JSON.parse(rectAfter);
  check('Drag handle tenggara (se) memperbesar elemen, bukan memindahkannya', ra.w > rb.w && ra.h > rb.h, `${rb.w}x${rb.h} -> ${ra.w}x${ra.h}`);

  // Sunting teks DI TEMPAT (input melayang), bukan dialog prompt browser.
  const hp2 = await cdp.hitPoint(`#punchSvgStage [data-element-id="${targetId}"]`);
  await cdp.clickAt(hp2.x, hp2.y, 2);
  await sleep(700);
  const inlineOpen = await cdp.eval('!!document.getElementById("punchInlineTextInput")');
  check('Double-click membuka editor teks DI TEMPAT (di atas kanvas)', inlineOpen === true);
  // Instrumentasi NYATA: window.prompt dibungkus sejak awal agar pemakaian
  // dialog bawaan browser benar-benar terdeteksi (bukan asersi yang selalu lolos).
  const promptCalls = await cdp.eval('JSON.stringify(window.__promptCalls || [])');
  check('Tidak ada dialog prompt bawaan browser yang dipakai', promptCalls === '[]', 'prompt=' + promptCalls);
  if (inlineOpen) {
    await cdp.eval('(() => { const i = document.getElementById("punchInlineTextInput"); i.value = ""; i.focus(); })()');
    await cdp.insertText(DIALOG_TEXT);
    await cdp.key('Enter');
    await sleep(600);
  }
  const editedText = await cdp.eval(`(() => { const e = window.workspaceApp.punch.getActiveSlide().elements.find(x => x.id === "${targetId}"); return e ? e.text : null; })()`);
  check('Mengetik di editor in-place + Enter mengubah teks slide', editedText === DIALOG_TEXT, 'text=' + editedText);
  check('Editor in-place ditutup setelah komit', !(await cdp.eval('!!document.getElementById("punchInlineTextInput")')));

  // Catatan pembicara tersimpan & terbaca kembali dari slide.
  await cdp.click('document.getElementById("tbSpeakerNotes")');
  await sleep(500);
  check('Tombol Catatan membuka panel catatan pembicara', (await cdp.eval('getComputedStyle(document.getElementById("speakerNotesPanel")).display')) !== 'none');
  await cdp.click('document.getElementById("speakerNotesInput")');
  await cdp.insertText('CATATAN-UJI-PEMBICARA');
  await sleep(900);
  const notesVal = await cdp.eval('window.workspaceApp.punch.getSpeakerNotes()');
  check('Catatan pembicara tersimpan pada slide aktif', notesVal === 'CATATAN-UJI-PEMBICARA', 'notes=' + notesVal);
  await cdp.click('document.getElementById("tbSpeakerNotes")');
  await sleep(400);
  check('Tombol Catatan menutup kembali panel', (await cdp.eval('getComputedStyle(document.getElementById("speakerNotesPanel")).display')) === 'none');

  await cdp.click('([...document.querySelectorAll(".tb-btn")].find(b => b.textContent.includes("Presentasikan")))');
  await sleep(600);
  check('Mode presentasi slideshow tampil', (await cdp.eval('document.getElementById("slidesPresentOverlay") && getComputedStyle(document.getElementById("slidesPresentOverlay")).display')) === 'flex');
  await cdp.key('ArrowLeft');
  await sleep(300);
  check('Panah Kiri menavigasi ke slide sebelumnya di mode presentasi', (await cdp.eval('window.workspaceApp.punch.activeSlideIdx')) === 0);
  await cdp.key('Escape');
  await sleep(400);
  check('Escape keluar dari mode presentasi', (await cdp.eval('getComputedStyle(document.getElementById("slidesPresentOverlay")).display')) === 'none');

  await sleep(1800);
  const persistedSlides = await apiGet(slidesId);
  check('Presentasi tersimpan ke disk (teks hasil sunting ada)', JSON.stringify(persistedSlides?.data || {}).includes(DIALOG_TEXT));
  const szSlides = await cdp.shot('test_user_slides.png');
  check('Screenshot Slides tersimpan', szSlides > 20000, szSlides + ' bytes');

  // ================= S5: MENU, SHARE, TELEMETRY =================
  console.log('\n--- S5: Menu dropdown, Modal Bagikan & Telemetry Drawer ---');
  await cdp.click('([...document.querySelectorAll(".menu-item")].find(m => m.dataset.menu === "file"))');
  await sleep(300);
  check('Menu "File" membuka dropdown', await cdp.eval('!!document.getElementById("activeMenuDropdown")'));
  const fileOpts = await cdp.eval('document.getElementById("activeMenuDropdown").innerText');
  check('Menu File memuat opsi Nyata (Unduh/Cetak/Drive)', /Unduh|Cetak|Drive/.test(fileOpts));
  // Menu ditutup dengan Escape — perilaku user nyata. (Klik di area dokumen tidak
  // dipakai karena mousedown editor memang menelan event; itu batasan renderer,
  // bukan jalur penutupan menu yang dijanjikan aplikasi.)
  await cdp.key('Escape');
  await sleep(300);
  check('Tombol Escape menutup dropdown menu', !(await cdp.eval('!!document.getElementById("activeMenuDropdown")')));

  // Buktikan dropdown benar-benar interaktif: memilih opsi menjalankan aksinya.
  await cdp.click('([...document.querySelectorAll(".menu-item")].find(m => m.dataset.menu === "view"))');
  await sleep(300);
  await cdp.click('([...document.querySelectorAll("#activeMenuDropdown .menu-option")].find(d => /Drive Hub/.test(d.textContent)))');
  await sleep(500);
  check('Memilih opsi menu menjalankan aksinya (buka Drive Hub)', (await cdp.eval('getComputedStyle(document.getElementById("view-drive")).display')) !== 'none');
  await cdp.click('document.getElementById("tab-docs")');
  await sleep(300);

  await cdp.click('document.getElementById("shareModalBtn")');
  await sleep(500);
  check('Modal "Bagikan" terbuka', (await cdp.eval('getComputedStyle(document.getElementById("gwsShareModal")).display')) === 'flex');
  const modalTxt = await cdp.eval('document.getElementById("gwsShareModal").innerText');
  check('Modal menampilkan judul dokumen & opsi akses', modalTxt.includes('Bagikan') && /link/i.test(modalTxt));
  await cdp.click('([...document.querySelectorAll("#gwsShareModal button")].find(b => b.textContent.includes("Selesai")))');
  await sleep(300);
  check('Tombol Selesai menutup modal', (await cdp.eval('getComputedStyle(document.getElementById("gwsShareModal")).display')) === 'none');

  const drawerBefore = await cdp.eval('document.getElementById("telemetryDrawer").classList.contains("minimized")');
  await cdp.click('document.querySelector("#telemetryDrawer .drawer-header")');
  await sleep(350);
  const drawerAfter = await cdp.eval('document.getElementById("telemetryDrawer").classList.contains("minimized")');
  check('Telemetry drawer dapat ciutkan/buka', drawerBefore !== drawerAfter);
  // Pastikan drawer dalam keadaan TERBUKA sebelum mengklik tombol uji di dalamnya
  // (saat minimized, tombol tergeser keluar viewport sehingga klik tidak mengenainya)
  await cdp.eval('document.getElementById("telemetryDrawer").classList.remove("minimized")');
  await sleep(400);
  await cdp.click('document.querySelector("#telemetryDrawer .drawer-test-btn")');
  await sleep(1400);
  let softRes = await cdp.eval('document.getElementById("soft404Result").innerText');
  check('Uji soft-404 di drawer mengembalikan status SOFT_404', softRes.includes('SOFT_404'), softRes.replace(/\s+/g, ' ').slice(0, 90));

  // ================= S6: PERSISTENSI SETELAH RELOAD =================
  console.log('\n--- S6: Reload halaman — bukti persistensi ke disk ---');
  await cdp.send('Page.reload');
  await cdp.waitFor('!!window.workspaceApp');
  await sleep(1300);
  const afterReload = await apiGet(docsId);
  check('Data ketikan tetap ada di disk setelah reload', JSON.stringify(afterReload?.data || {}).includes('DIKETIK-OLEH-USER'));
  const docsCount = await cdp.eval('window.workspaceApp.documents.length');
  check('Drive memuat seluruh dokumen setelah reload', docsCount === seedBefore.length + 3, `docs=${docsCount}`);
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(400);
  const szDrive = await cdp.shot('test_user_drive.png');
  check('Screenshot Drive Hub tersimpan', szDrive > 20000, szDrive + ' bytes');

  // ================= S7: FITUR LENGKAP (toolbar kontekstual, shape, ekspor, Drive Hub) =================
  console.log('\n--- S7: Fitur lanjutan — format sel, formula IF, shape, ekspor, pencarian Drive ---');
  const extraIds = [];

  // --- S7a: Sheets — format mata uang + formula IF ---
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(300);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${sheetsId}"]')`);
  await sleep(1000);
  check('Buka kembali spreadsheet uji lewat klik kartu Drive', (await cdp.eval('window.workspaceApp.currentApp')) === 'sheets');

  const qc1 = await cdp.cellXY(2, 1);
  await cdp.clickAt(qc1.x, qc1.y);
  await cdp.click('document.getElementById("tbCurrency")');
  await sleep(350);
  const c1fmt = await cdp.eval('window.workspaceApp.ritz.cells["C1"] && window.workspaceApp.ritz.cells["C1"].numFormat');
  check('Toolbar format mata uang ($) menandai sel C1', c1fmt === 'currency', 'numFormat=' + c1fmt);

  const qe1 = await cdp.cellXY(4, 1);
  await cdp.clickAt(qe1.x, qe1.y);
  await cdp.click('document.getElementById("sheetFormulaInput")');
  await cdp.selectAll();
  await cdp.insertText('=IF(C2>50,"TINGGI","RENDAH")');
  await cdp.click('document.getElementById("sheetCalcBtn")');
  await sleep(800);
  const e1v = await cdp.eval('window.workspaceApp.ritz.cells["E1"] && window.workspaceApp.ritz.cells["E1"].val');
  check('Formula =IF(C2>50,...) ter-evaluasi di grid menjadi "TINGGI"', e1v === 'TINGGI', 'E1=' + e1v);

  const csvOut = await cdp.eval('window.workspaceApp.ritz.exportCsv()');
  check('Ekspor CSV menghasilkan baris data nyata', typeof csvOut === 'string' && csvOut.includes('TINGGI') && csvOut.includes(','), (csvOut || '').split('\r\n').length + ' baris');

  // --- S7b: Slides — sisip shape, duplikat slide, ekspor SVG ---
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(300);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${slidesId}"]')`);
  await sleep(1000);
  check('Buka kembali presentasi uji lewat klik kartu Drive', (await cdp.eval('window.workspaceApp.currentApp')) === 'slides');

  const elemBefore = await cdp.eval('window.workspaceApp.punch.getActiveSlide().elements.length');
  await cdp.click('document.getElementById("tbInsertRect")');
  await sleep(450);
  const elemAfter = await cdp.eval('window.workspaceApp.punch.getActiveSlide().elements.length');
  check('Toolbar "Sisipkan Kotak" menambah elemen shape', elemAfter > elemBefore, `${elemBefore} -> ${elemAfter}`);
  check('Shape baru benar-benar ter-render di stage SVG', (await cdp.eval('document.querySelectorAll("#punchSvgStage rect[data-element-id]").length')) > 0);

  const slideCountBefore = await cdp.eval('window.workspaceApp.punch.slides.length');
  await cdp.click('document.getElementById("tbDuplicateSlide")');
  await sleep(450);
  const slideCountDup = await cdp.eval('window.workspaceApp.punch.slides.length');
  check('Toolbar "Duplikat Slide" menambah jumlah slide', slideCountDup === slideCountBefore + 1, `${slideCountBefore} -> ${slideCountDup}`);
  check('Thumbnail filmstrip ikut bertambah setelah duplikat', (await cdp.eval('document.querySelectorAll("#slidesFilmstrip .filmstrip-item").length')) === slideCountDup);

  await cdp.click('document.getElementById("tbDeleteSlide")');
  await sleep(450);
  check('Toolbar "Hapus Slide" mengembalikan jumlah slide', (await cdp.eval('window.workspaceApp.punch.slides.length')) === slideCountBefore);

  const svgOut = await cdp.eval('window.workspaceApp.punch.exportSvg()');
  check('Ekspor SVG slide menghasilkan dokumen SVG valid', typeof svgOut === 'string' && svgOut.startsWith('<svg') && svgOut.includes('</svg>'), (svgOut || '').length + ' chars');

  // --- S7c: Docs — underline/strike, halaman baru, ekspor teks ---
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(300);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${docsId}"]')`);
  await sleep(1000);
  check('Buka kembali dokumen uji lewat klik kartu Drive', (await cdp.eval('window.workspaceApp.currentApp')) === 'docs');

  await cdp.click('document.querySelector("#docsScrollBox .kix-page canvas")');
  const pagesBefore = await cdp.eval('window.workspaceApp.kix.pages.length');
  await cdp.click('document.getElementById("tbUnderline")');
  await sleep(300);
  const ulOn = await cdp.eval('window.workspaceApp.kix.pages[window.workspaceApp.kix.activePageIdx].lines[window.workspaceApp.kix.activeLineIdx].underline');
  check('Toolbar "U" mengaktifkan underline pada baris aktif', ulOn === true, 'underline=' + ulOn);

  await cdp.click('document.getElementById("tbStrike")');
  await sleep(300);
  const stOn = await cdp.eval('window.workspaceApp.kix.pages[window.workspaceApp.kix.activePageIdx].lines[window.workspaceApp.kix.activeLineIdx].strike');
  check('Toolbar "S" mengaktifkan strikethrough pada baris aktif', stOn === true, 'strike=' + stOn);

  await cdp.click('([...document.querySelectorAll(".menu-item")].find(m => m.dataset.menu === "insert"))');
  await sleep(300);
  await cdp.click('([...document.querySelectorAll("#activeMenuDropdown .menu-option")].find(d => /Tambah Halaman Baru/.test(d.textContent)))');
  await sleep(700);
  const pagesAfterInsert = await cdp.eval('window.workspaceApp.kix.pages.length');
  check('Menu Insert → Tambah Halaman Baru menambah halaman', pagesAfterInsert === pagesBefore + 1, `${pagesBefore} -> ${pagesAfterInsert}`);

  const txtOut = await cdp.eval('window.workspaceApp.kix.exportPlainText()');
  check('Ekspor teks polos memuat isi dokumen', typeof txtOut === 'string' && txtOut.length > 100, (txtOut || '').length + ' chars');

  // Undo/Redo nyata lewat toolbar
  await cdp.click('document.getElementById("tbUndo")');
  await sleep(700);
  const pagesAfterUndo = await cdp.eval('window.workspaceApp.kix.pages.length');
  check('Toolbar Undo mengembalikan keadaan sebelum tambah halaman', pagesAfterUndo === pagesBefore, `${pagesAfterInsert} -> ${pagesAfterUndo}`);
  await cdp.click('document.getElementById("tbRedo")');
  await sleep(700);
  check('Toolbar Redo mengulang aksi yang dibatalkan', (await cdp.eval('window.workspaceApp.kix.pages.length')) === pagesAfterInsert);

  // --- S7d: Drive Hub — pencarian, filter, bintang, duplikat ---
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(500);
  const allCards = await cdp.eval('document.querySelectorAll("#driveGridContainer .drive-card").length');
  await cdp.click('document.getElementById("driveSearchInput")');
  await cdp.insertText('Example');
  await sleep(500);
  const filteredCards = await cdp.eval('document.querySelectorAll("#driveGridContainer .drive-card").length');
  check('Pencarian Drive menyaring kartu berdasarkan judul', filteredCards < allCards && filteredCards >= 1, `${allCards} -> ${filteredCards}`);
  await cdp.selectAll();
  await cdp.key('Backspace');
  await sleep(500);
  check('Menghapus kata kunci memulihkan seluruh kartu', (await cdp.eval('document.querySelectorAll("#driveGridContainer .drive-card").length')) === allCards);

  await cdp.click('([...document.querySelectorAll("#driveFilterChips .filter-chip")].find(c => c.dataset.filter === "sheets"))');
  await sleep(500);
  const sheetCards = await cdp.eval('document.querySelectorAll("#driveGridContainer .drive-card").length');
  const sheetTypes = await cdp.eval('[...document.querySelectorAll("#driveGridContainer .drive-card")].map(c => c.dataset.docType).join(",")');
  check('Filter chip "Spreadsheet" hanya menampilkan dokumen sheets', sheetCards >= 1 && !sheetTypes.split(',').some(t => t && t !== 'sheets'), `kartu=${sheetCards} tipe=${sheetTypes}`);
  await cdp.click('([...document.querySelectorAll("#driveFilterChips .filter-chip")].find(c => c.dataset.filter === "all"))');
  await sleep(400);

  // Sasar kartu dokumen UJI, bukan kartu seed pertama, agar metadata seed tidak termutasi.
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${docsId}"] .star-toggle')`);
  await sleep(900);
  const starredCount = await cdp.eval('window.workspaceApp.documents.filter(d => d.starred).length');
  check('Klik ikon bintang menandai dokumen sebagai favorit', starredCount >= 1, 'favorit=' + starredCount);
  const starredIsTestDoc = await cdp.eval(`(window.workspaceApp.documents.find(d => d.id === "${docsId}") || {}).starred === true`);
  check('Bintang menempel pada dokumen uji (bukan memutasi seed)', starredIsTestDoc);

  const idsBeforeDup = (await apiList() || []).map(d => d.id);
  await cdp.click('([...document.querySelectorAll("#driveGridContainer .drive-card .card-action")].find(a => a.dataset.act === "duplicate"))');
  await sleep(1100);
  const idsAfterDup = (await apiList() || []).map(d => d.id);
  const newIds = idsAfterDup.filter(i => !idsBeforeDup.includes(i));
  newIds.forEach(i => extraIds.push(i));
  check('Aksi "Duplikat" pada kartu membuat dokumen salinan baru', newIds.length >= 1, 'baru=' + newIds.join(','));

  // --- S7f: Paritas fitur baru (Docs paragraf, Sheets ketik-langsung & desimal,
  //          Slides resize handle + catatan pembicara) ---
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(300);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${docsId}"]')`);
  await sleep(1000);
  check('S7f: dokumen uji terbuka kembali untuk uji paritas', (await cdp.eval('window.workspaceApp.currentApp')) === 'docs');

  await cdp.click('document.querySelector("#docsScrollBox .kix-page canvas")');
  const s7Idx = await cdp.eval('window.workspaceApp.kix.activeLineIdx');
  await cdp.type('BARIS-PARITAS');
  // Gaya paragraf: pilih "Judul (Title)" dari dropdown — harus mengubah ukuran baris.
  await cdp.eval('(() => { const s = document.getElementById("tbParagraphStyle"); s.value = "title"; s.dispatchEvent(new Event("change")); })()');
  await sleep(500);
  const titleStyle = await cdp.eval(`JSON.stringify((() => { const l = window.workspaceApp.kix.pages[0].lines[${s7Idx}]; return { heading: l.heading || null, size: l.size || null }; })())`);
  const ts = JSON.parse(titleStyle);
  check('S7f Docs: gaya "Title" menaikkan ukuran baris aktif', ts.heading === 'title' && (ts.size || 0) > 14, titleStyle);

  // Daftar butir: menyalakan bullet harus mengubah toolbar menjadi aktif.
  await cdp.click('document.getElementById("tbBulletList")');
  await sleep(450);
  const bulletOn = await cdp.eval('JSON.stringify((() => { const l = window.workspaceApp.kix.pages[0].lines[' + s7Idx + ']; return { listType: l.listType || null }; })())');
  check('S7f Docs: tombol Bullet List menandai baris sebagai daftar butir', JSON.parse(bulletOn).listType === 'bullet', bulletOn);
  const bulletBtnActive = await cdp.eval('document.getElementById("tbBulletList").classList.contains("active")');
  check('S7f Docs: tombol toolbar menyala (active) mengikuti baris aktif', bulletBtnActive === true);

  // Spasi baris 1,5 — harus tersimpan di model baris.
  await cdp.eval('(() => { const s = document.getElementById("tbLineSpacing"); s.value = "1.5"; s.dispatchEvent(new Event("change")); })()');
  await sleep(400);
  const spVal = await cdp.eval('window.workspaceApp.kix.pages[0].lines[' + s7Idx + '].spacing');
  check('S7f Docs: dropdown spasi baris menyetel spacing = 1.5', spVal === 1.5, 'spacing=' + spVal);

  // Sheets: ketik LANGSUNG ke sel (in-cell), tanpa formula bar.
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(300);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${sheetsId}"]')`);
  await sleep(1000);
  const directCell = await cdp.cellXY(4, 5); // E5 (kolom 0-based: 4 = E)
  await cdp.clickAt(directCell.x, directCell.y);
  await cdp.type('77');
  await cdp.key('Enter');
  await sleep(700);
  const e5v = await cdp.eval('window.workspaceApp.ritz.cells["E5"] && window.workspaceApp.ritz.cells["E5"].val');
  check('S7f Sheets: mengetik LANGSUNG ke sel (in-cell) menyimpan nilai 77', e5v === 77, 'E5=' + e5v);
  // Enter memindah seleksi ke baris berikutnya, seperti Google Sheets.
  const afterEnterCoord = await cdp.eval('window.workspaceApp.ritz.getActiveCoord()');
  check('S7f Sheets: Enter memindah seleksi ke sel bawahnya', afterEnterCoord === 'E6', 'coord=' + afterEnterCoord);

  // Tombol desimal: nilai tampilan harus bertambah digit di belakang koma.
  const qFmt = await cdp.cellXY(4, 5); // E5
  await cdp.clickAt(qFmt.x, qFmt.y);
  await cdp.click('document.getElementById("tbDecInc")');
  await sleep(300);
  const decs = await cdp.eval('window.workspaceApp.ritz.decimals');
  check('S7f Sheets: tombol .00 menambah jumlah desimal tampilan', typeof decs === 'number' && decs >= 3, 'decimals=' + decs);

  // Fungsi cepat Sigma menyisipkan rumus nyata ke sel aktif.
  const qSig = await cdp.cellXY(2, 6); // C6
  await cdp.clickAt(qSig.x, qSig.y);
  await cdp.eval('(() => { const s = document.getElementById("tbSheetSum"); s.value = "SUM"; s.dispatchEvent(new Event("change")); })()');
  await sleep(900);
  const c6raw = await cdp.eval('window.workspaceApp.ritz.cells["C6"] && window.workspaceApp.ritz.cells["C6"].raw');
  const c6val = await cdp.eval('window.workspaceApp.ritz.cells["C6"] && window.workspaceApp.ritz.cells["C6"].val');
  check('S7f Sheets: fungsi cepat Σ menyisipkan =SUM(...) dan ter-evaluasi', /^=SUM\(C\d+:C\d+\)$/.test(c6raw || '') && typeof c6val === 'number', `raw=${c6raw} val=${c6val}`);

  // Token error formula tampil apa adanya (bukan Infinity).
  const qErr = await cdp.cellXY(5, 6); // F6
  await cdp.clickAt(qErr.x, qErr.y);
  await cdp.click('document.getElementById("sheetFormulaInput")');
  await cdp.selectAll();
  await cdp.insertText('=C2/0');
  await cdp.key('Enter');
  await sleep(900);
  const f6val = await cdp.eval('window.workspaceApp.ritz.cells["F6"] && window.workspaceApp.ritz.cells["F6"].val');
  check('S7f Sheets: pembagian nol menampilkan #DIV/0! (bukan Infinity)', f6val === '#DIV/0!', 'F6=' + f6val);

  // Slides: buka presentasi uji → buka panel catatan → catatan bertahan saat pindah slide? (per-slide)
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(300);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${slidesId}"]')`);
  await sleep(1000);
  check('S7f: presentasi uji terbuka kembali', (await cdp.eval('window.workspaceApp.currentApp')) === 'slides');
  // Catatan pembicara bersifat PER-SLIDE: pilih dulu slide yang benar-benar
  // memuat catatan (jangan berasumsi slide 1), baru buka panelnya.
  const notesIdx = await cdp.eval('window.workspaceApp.punch.slides.findIndex(s => String(s.notes || "").includes("CATATAN-UJI-PEMBICARA"))');
  check('S7f Slides: catatan pembicara tersimpan pada slide tertentu (per-slide)', notesIdx >= 0, 'index=' + notesIdx);
  if (notesIdx >= 0) {
    await cdp.click(`document.querySelectorAll("#slidesFilmstrip .filmstrip-item")[${notesIdx}]`);
    await sleep(600);
  }
  await cdp.click('document.getElementById("tbSpeakerNotes")');
  await sleep(600);
  const notesRestored = await cdp.eval('document.getElementById("speakerNotesInput").value');
  check('S7f Slides: catatan pembicara terpulihkan dari dokumen tersimpan', notesRestored === 'CATATAN-UJI-PEMBICARA', 'notes=' + notesRestored);
  await cdp.click('document.getElementById("tbSpeakerNotes")');
  await sleep(300);

  await sleep(1800);
  const persistedNotes = await apiGet(slidesId);
  check('S7f Slides: catatan pembicara benar-benar tertulis ke disk (persistensi)', JSON.stringify(persistedNotes?.data || {}).includes('CATATAN-UJI-PEMBICARA'));

  // --- S7e: Menu Tools/Help (modal nyata) ---
  await cdp.click('([...document.querySelectorAll(".menu-item")].find(m => m.dataset.menu === "tools"))');
  await sleep(300);
  await cdp.click('([...document.querySelectorAll("#activeMenuDropdown .menu-option")].find(d => /Penghitung Kata/.test(d.textContent)))');
  await sleep(600);
  const wcTxt = await cdp.eval('document.getElementById("gwsModal").innerText');
  check('Menu Tools → Penghitung Kata membuka modal berisi angka', /Kata/.test(wcTxt) && /Karakter/.test(wcTxt) && /\d/.test(wcTxt));
  await cdp.click('document.querySelector("#gwsModal .modal-close")');
  await sleep(400);
  check('Modal Penghitung Kata dapat ditutup', (await cdp.eval('getComputedStyle(document.getElementById("gwsModal")).display')) === 'none');

  await cdp.click('([...document.querySelectorAll(".menu-item")].find(m => m.dataset.menu === "help"))');
  await sleep(300);
  await cdp.click('([...document.querySelectorAll("#activeMenuDropdown .menu-option")].find(d => /Pintasan/.test(d.textContent)))');
  await sleep(600);
  const scTxt = await cdp.eval('document.getElementById("gwsModal").innerText');
  check('Menu Help → Pintasan Keyboard membuka daftar shortcut', /Ctrl \+ B/.test(scTxt) && /Undo/.test(scTxt));
  await cdp.click('document.querySelector("#gwsModal .modal-close")');
  await sleep(400);
  check('Modal Pintasan Keyboard dapat ditutup', (await cdp.eval('getComputedStyle(document.getElementById("gwsModal")).display')) === 'none');

  // ================= S8: KETAHANAN =================
  console.log('\n--- S8: Ketahanan — flush saat reload, sirkular, propagasi error, riwayat, viewport sempit ---');

  // S8a: Kirim suntingan lalu RELOAD SEGERA (tanpa menunggu debounce 600ms).
  // Tanpa flush keepalive di pagehide/beforeunload, suntingan ini HILANG.
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(300);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${docsId}"]')`);
  await sleep(1200);
  await cdp.click('document.querySelector("#docsScrollBox .kix-page canvas")');
  await sleep(300);
  await cdp.type('FLUSH-RELOAD-BUKTI');
  await cdp.send('Page.reload');                       // sengaja TANPA sleep
  await cdp.waitFor('!!window.workspaceApp');
  await sleep(1400);
  const flushedDoc = await apiGet(docsId);
  check('S8: suntingan tertunda tersimpan walau reload TANPA menunggu debounce',
    JSON.stringify(flushedDoc?.data || {}).includes('FLUSH-RELOAD-BUKTI'),
    'tersimpan=' + JSON.stringify(flushedDoc?.data || {}).includes('FLUSH-RELOAD-BUKTI'));

  // S8b: Sirkular + propagasi error di grid NYATA (lewat formula bar, bukan API).
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(300);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${sheetsId}"]')`);
  await sleep(1000);
  const setCell = async (col, row, formula) => {
    const q = await cdp.cellXY(col, row);
    await cdp.clickAt(q.x, q.y);
    await cdp.click('document.getElementById("sheetFormulaInput")');
    await cdp.selectAll();
    await cdp.insertText(formula);
    await cdp.key('Enter');
    await sleep(700);
  };
  await setCell(0, 1, '=B1');    // A1 merujuk B1
  await setCell(1, 1, '=A1');    // B1 merujuk A1 -> melingkar
  await sleep(800);
  const circA1 = await cdp.eval('window.workspaceApp.ritz.cells["A1"] && window.workspaceApp.ritz.cells["A1"].val');
  check('S8 Sheets: referensi melingkar menampilkan #REF! (bukan angka bisu 0)', circA1 === '#REF!', 'A1=' + circA1);

  await setCell(6, 1, '=1/0');   // G1 -> #DIV/0!
  await setCell(7, 1, '=G1+5');  // H1 harus MEWARISI #DIV/0!, bukan 5
  await sleep(800);
  const g1 = await cdp.eval('window.workspaceApp.ritz.cells["G1"] && window.workspaceApp.ritz.cells["G1"].val');
  const h1 = await cdp.eval('window.workspaceApp.ritz.cells["H1"] && window.workspaceApp.ritz.cells["H1"].val');
  check('S8 Sheets: error ASAL tidak menyamar jadi #VALUE! (#DIV/0! utuh)', g1 === '#DIV/0!', 'G1=' + g1);
  check('S8 Sheets: error TERPROPAGASI ke formula yang merujuknya', h1 === '#DIV/0!', 'H1=' + h1);
  await setCell(8, 1, '=SUM(G1:G1)');
  await sleep(800);
  const i1 = await cdp.eval('window.workspaceApp.ritz.cells["I1"] && window.workspaceApp.ritz.cells["I1"].val');
  check('S8 Sheets: agregat SUM atas sel error -> #DIV/0! (bukan 0)', i1 === '#DIV/0!', 'I1=' + i1);

  // S8c: Riwayat undo TIDAK tumbuh tanpa batas (cegah memory leak).
  const histLen = await cdp.eval(`(() => {
    const app = window.workspaceApp;
    for (let i = 0; i < 65; i++) app.recordHistory('sheets', { i, cells: { A1: { raw: 'x' + i } } });
    return (app.undoStack.sheets || []).length;
  })()`);
  check('S8: riwayat undo dibatasi (<= 60) — tidak tumbuh tanpa batas', histLen <= 60, 'len=' + histLen);

  // S8d: Viewport SEMPIT — toolbar harus tetap SATU BARIS + dapat di-scroll
  //      horizontal (overflow-x:auto), bukan menumpuk jadi kolom vertikal.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  // PENTING: metrik "jumlah nilai top berbeda" TIDAK valid di sini — toolbar
  // memakai align-items:center, jadi anak bertinggi berbeda (mis. select zoom)
  // punya top berbeda meski berada di baris yang sama. Ukur SATU BARIS dari
  // tinggi kontainer vs anak tertinggi, dan ukur keterjangkauan dari overflow.
  const narrow = JSON.parse(await cdp.eval(`(() => {
    const tb = document.getElementById('appToolbar');
    const cs = getComputedStyle(tb);
    const r = tb.getBoundingClientRect();
    const vis = [...tb.children].filter(c => c.offsetParent !== null);
    const maxChildH = Math.max(...vis.map(c => c.getBoundingClientRect().height));
    const clipped = vis.filter(c => c.getBoundingClientRect().right > r.right + 1).length;
    const scrollable = tb.scrollWidth > tb.clientWidth;
    const singleRow = Math.round(r.height) <= Math.round(maxChildH) + 16;
    return JSON.stringify({ wrap: cs.flexWrap, ox: cs.overflowX, h: Math.round(r.height),
      maxChildH: Math.round(maxChildH), singleRow, scrollable, clipped,
      reachable: scrollable || clipped === 0 });
  })()`));
  check('S8 sempit: toolbar tetap SATU BARIS (tidak menumpuk vertikal)', narrow.wrap === 'nowrap' && narrow.singleRow === true,
    `wrap=${narrow.wrap} tinggi=${narrow.h}px anakMax=${narrow.maxChildH}px satuBaris=${narrow.singleRow}`);
  check('S8 sempit: overflow-x auto & seluruh kontrol tetap terjangkau (tidak terpotong mati)', narrow.ox === 'auto' && narrow.reachable === true,
    `overflow-x=${narrow.ox} butuhScroll=${narrow.scrollable} terpotong=${narrow.clipped} terjangkau=${narrow.reachable}`);

  // Lebar 640px: konten toolbar (1087px) PASTI melebihi layar -> buktikan jalur
  // scroll benar-benar aktif dan toolbar tetap satu baris.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 600, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  const vn = JSON.parse(await cdp.eval(`(() => {
    const tb = document.getElementById('appToolbar');
    const r = tb.getBoundingClientRect();
    const vis = [...tb.children].filter(c => c.offsetParent !== null);
    const maxChildH = Math.max(...vis.map(c => c.getBoundingClientRect().height));
    return JSON.stringify({ scrollable: tb.scrollWidth > tb.clientWidth, scrollW: tb.scrollWidth,
      clientW: tb.clientWidth, singleRow: Math.round(r.height) <= Math.round(maxChildH) + 16 });
  })()`));
  check('S8 640px: toolbar satu baris & dapat di-scroll horizontal', vn.singleRow === true && vn.scrollable === true,
    `satuBaris=${vn.singleRow} scrollW=${vn.scrollW} clientW=${vn.clientW}`);
  const szNarrow = await cdp.shot('test_user_narrow.png');
  check('S8 sempit: screenshot viewport sempit tersimpan', szNarrow > 20000, szNarrow + ' bytes');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(500);

  // ================= S9: PARITAS LANJUTAN =================
  console.log('\n--- S9: Paritas lanjutan — ceklis Docs, bagan+sort Sheets, tema/layout Slides ---');

  const pickSelect = async (id, val) => {
    await cdp.eval(`(() => { const s = document.getElementById("${id}"); if (!s) return false; s.value = "${val}"; s.dispatchEvent(new Event("change")); return true; })()`);
    await sleep(700);
  };

  // Memilih opsi <select> TANPA menyetel .value: fokuskan lalu tekan tombol
  // panah + Enter seperti user memakai keyboard. Fokus dilakukan lewat
  // el.focus() (bukan klik) supaya popup native Chrome tidak terbuka dan
  // menggigit event berikutnya — sumber kerewelan di lingkungan headless.
  const pickSelectByKeyboard = async (id, val) => {
    const pre = JSON.parse(await cdp.eval(`(() => {
      const s = document.getElementById("${id}");
      if (!s) return JSON.stringify({ ok: false, reason: "elemen tidak ada" });
      const vals = Array.from(s.options).map(o => o.value);
      return JSON.stringify({ ok: true, want: vals.indexOf("${val}"), cur: s.selectedIndex, vals });
    })()`));
    if (!pre.ok || pre.want < 0) return { ok: false, pre };
    await cdp.eval(`document.getElementById("${id}").focus()`);
    await sleep(200);
    const steps = pre.want - pre.cur;
    for (let i = 0; i < Math.abs(steps); i++) await cdp.key(steps > 0 ? 'ArrowDown' : 'ArrowUp');
    await cdp.key('Enter');
    await sleep(500);
    const after = await cdp.eval(`document.getElementById("${id}").value`);
    return { ok: after === val, value: after, from: pre.cur, steps };
  };

  // Klik tepat pada BARIS dokumen tertentu. Klik di TENGAH kanvas akan memilih
  // baris TERAKHIR (bukan baris 0), sehingga tombol Ceklis menandai baris yang
  // salah — itu bug nyata yang ditemukan E2E pada percobaan pertama. Koordinat
  // diambil dari editor sendiri (lineRectAt), bukan angka ajaib.
  const clickDocsLine = async (lIdx) => {
    const pos = JSON.parse(await cdp.eval(`(() => {
      const app = window.workspaceApp.kix;
      const c = document.querySelector('#docsScrollBox .kix-page canvas');
      if (!c || !app) return JSON.stringify({ ok: false, reason: 'kanvas/editor tidak ada' });
      const r = c.getBoundingClientRect();
      const row = app.lineRectAt(0, ${lIdx});
      const scale = r.width / (c.width || r.width);
      return JSON.stringify({
        ok: true, row,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + row.centerY * scale)
      });
    })()`));
    if (!pos.ok) throw new Error('Posisi baris dokumen #' + lIdx + ' tidak dapat dihitung: ' + pos.reason);
    await cdp.clickAt(pos.x, pos.y);
    await sleep(400);
    return pos;
  };

  // --- S9a: Docs — daftar periksa (checklist) lewat klik nyata ---
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(300);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${docsId}"]')`);
  await sleep(1300);
  const posLine0 = await clickDocsLine(0);
  const activeInfo = JSON.parse(await cdp.eval(`JSON.stringify({
    idx: window.workspaceApp.kix.activeLineIdx,
    text: (window.workspaceApp.kix.pages[0].lines[0] || {}).text
  })`));
  check('S9 Docs: klik presisi membuat baris aktif = 0 (bukan baris terakhir)',
    activeInfo.idx === 0, `activeLineIdx=${activeInfo.idx} (baris: ${JSON.stringify(String(activeInfo.text).slice(0, 20))})`);
  await cdp.click('document.getElementById("tbChecklist")');
  await sleep(800);
  const docListType = await cdp.eval('window.workspaceApp.kix.pages[0].lines[0].listType');
  check('S9 Docs: tombol Ceklis menandai baris sebagai daftar periksa', docListType === 'checklist', 'listType=' + docListType);
  const prefixEmpty = await cdp.eval('window.workspaceApp.kix.listPrefixFor(window.workspaceApp.kix.pages[0], 0)');
  check('S9 Docs: butir ceklis diawali kotak kosong ☐', prefixEmpty === '\u2610 ', 'prefix=' + JSON.stringify(prefixEmpty));

  // Klik LANGSUNG pada kotak centang di canvas (bukan via API) = perilaku user.
  // Koordinat dihitung dari editor sendiri (checklistBoxRect) — tanpa angka ajaib.
  const cbPos = JSON.parse(await cdp.eval(`(() => {
    const app = window.workspaceApp.kix;
    const c = document.querySelector('#docsScrollBox .kix-page canvas');
    if (!c) return JSON.stringify({ ok: false });
    const r = c.getBoundingClientRect();
    const b = app.checklistBoxRect(0, 0);
    if (!b) return JSON.stringify({ ok: false, reason: 'bukan baris ceklis' });
    const scale = r.width / (c.width || r.width);
    return JSON.stringify({ ok: true, x: Math.round(r.left + b.centerX * scale), y: Math.round(r.top + b.centerY * scale), box: b });
  })()`));
  check('S9 Docs: geometri kotak centang tersedia dari editor (bukan hardcode)', cbPos.ok === true, JSON.stringify(cbPos.box || cbPos));
  await cdp.clickAt(cbPos.x, cbPos.y);
  await sleep(700);
  const checkedNow = await cdp.eval('window.workspaceApp.kix.pages[0].lines[0].checked');
  const prefixChecked = await cdp.eval('window.workspaceApp.kix.listPrefixFor(window.workspaceApp.kix.pages[0], 0)');
  check('S9 Docs: klik kotak centang di halaman membalik status (☑)', checkedNow === true && prefixChecked === '\u2611 ', `checked=${checkedNow} prefix=${JSON.stringify(prefixChecked)}`);
  const szDocs9 = await cdp.shot('test_user_docs_checklist.png');
  check('S9 Docs: screenshot dokumen ber-ceklis tersimpan', szDocs9 > 20000, szDocs9 + ' bytes');

  // --- S9b: Sheets — bagan (chart) + urutkan ---
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(300);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${sheetsId}"]')`);
  await sleep(1300);
  await setCell(1, 1, 'Ani'); await setCell(2, 1, '30');
  await setCell(1, 2, 'Budi'); await setCell(2, 2, '10');
  await setCell(1, 3, 'Cici'); await setCell(2, 3, '20');
  const cQ = await cdp.cellXY(2, 1);
  await cdp.clickAt(cQ.x, cQ.y);
  await sleep(400);
  await cdp.click('document.getElementById("tbInsertChart")');
  await sleep(1200);
  const chartInfo = JSON.parse(await cdp.eval(`(() => {
    const ov = document.getElementById('ritzChartOverlay');
    if (!ov) return JSON.stringify({ present: false });
    const svg = ov.querySelector('svg');
    const r = ov.getBoundingClientRect();
    return JSON.stringify({
      present: true, display: getComputedStyle(ov).display, hasSvg: !!svg,
      rects: ov.querySelectorAll('svg rect').length, w: Math.round(r.width), h: Math.round(r.height),
      charts: (window.workspaceApp.ritz.getCharts() || []).length
    });
  })()`));
  check('S9 Sheets: kartu bagan muncul di DOM setelah tombol Sisipkan Bagan diklik',
    chartInfo.present === true && chartInfo.display !== 'none', 'display=' + chartInfo.display);
  check('S9 Sheets: bagan benar-benar tergambar sebagai SVG berukuran (>0px)',
    chartInfo.hasSvg === true && chartInfo.w > 100 && chartInfo.h > 100, `svg=${chartInfo.hasSvg} ${chartInfo.w}x${chartInfo.h}`);
  check('S9 Sheets: bagan berisi batang dari 3 nilai (Ani/Budi/Cici)',
    chartInfo.rects >= 3 && chartInfo.charts === 1, `rect=${chartInfo.rects} charts=${chartInfo.charts}`);
  // Diuji sebagai INVARIAN: satu sektor untuk SETIAP nilai pada kolom aktif.
  // Jumlah pastinya tidak tetap karena seksi sebelumnya (S7f) juga menulis ke
  // kolom yang sama — mengunci "3 sektor" menguji sisa data, bukan bagan.
  const pieValues = JSON.parse(await cdp.eval('JSON.stringify((window.workspaceApp.ritz.readChartData().values || []).length)'));
  await pickSelect('ritzChartType', 'pie');
  const pieSectors = Number(await cdp.eval('document.querySelectorAll("#ritzChartOverlay svg path").length'));
  check('S9 Sheets: bagan lingkaran memakai satu sektor per nilai kolom aktif',
    pieSectors === pieValues && pieValues >= 3, `sektor=${pieSectors} nilai=${pieValues}`);
  const szChart = await cdp.shot('test_user_sheets_chart.png');
  check('S9 Sheets: screenshot bagan tersimpan', szChart > 20000, szChart + ' bytes');

  // Urutkan kolom aktif lewat klik tombol nyata.
  await setCell(0, 1, '30'); await setCell(0, 2, '10'); await setCell(0, 3, '20');
  const aQ = await cdp.cellXY(0, 1);
  await cdp.clickAt(aQ.x, aQ.y);
  await sleep(400);
  await cdp.click('document.getElementById("tbSortAsc")');
  await sleep(1600);
  // Diperiksa sebagai INVARIAN, bukan nilai persis: seksi sebelumnya mungkin
  // meninggalkan isi lain di kolom A, jadi yang diuji adalah "seluruh nilai
  // angka di kolom A tidak menurun" + nilai yang kita tulis tetap ada.
  const sortInfo = JSON.parse(await cdp.eval(`(() => {
    const cells = window.workspaceApp.ritz.cells;
    const nums = [];
    for (let r = 1; r <= 25; r++) {
      const c = cells["A" + r];
      if (!c) continue;
      const v = (c.val !== undefined && c.val !== "") ? c.val : c.raw;
      if (typeof v === "number") nums.push(v);
    }
    const nonDec = nums.every((v, i) => i === 0 || nums[i - 1] <= v);
    return JSON.stringify({ nums, nonDec });
  })()`));
  check('S9 Sheets: tombol urutkan menaik menyusun kolom A naik (non-menurun) dan memuat 10,20,30',
    sortInfo.nonDec === true && [10, 20, 30].every(v => sortInfo.nums.includes(v)),
    'kolom A=' + JSON.stringify(sortInfo.nums));
  await cdp.click('document.getElementById("tbRemoveChart")');
  await sleep(700);
  const chartGone = await cdp.eval('getComputedStyle(document.getElementById("ritzChartOverlay")).display');
  check('S9 Sheets: tombol Hapus Diagram menutup bagan', chartGone === 'none', 'display=' + chartGone);

  // --- S9c: Slides — tema + tata letak ---
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(300);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${slidesId}"]')`);
  await sleep(1300);
  // Tema dipilih lewat KEYBOARD nyata (klik fokus + panah + Enter), bukan set .value.
  const kbTheme = await pickSelectByKeyboard('tbSlideTheme', 'dark');
  check('S9 Slides: tema dipilih lewat keyboard (fokus + panah + Enter)', kbTheme.ok === true,
    `nilai akhir=${kbTheme.value} dari index ${kbTheme.from} (${kbTheme.steps} langkah)`);
  const themeState = JSON.parse(await cdp.eval(`JSON.stringify({
    bg: window.workspaceApp.punch.slides.map(s => s.background),
    theme: window.workspaceApp.punch.getTheme()
  })`));
  check('S9 Slides: memilih tema "Gelap Elegan" mengubah latar SEMUA slide',
    themeState.theme === 'dark' && themeState.bg.every(b => b === '#202124'), `theme=${themeState.theme} bg=${themeState.bg.join(',')}`);
  await pickSelect('tbSlideLayout', 'two_column');
  const layoutState = JSON.parse(await cdp.eval(`JSON.stringify({
    layout: window.workspaceApp.punch.getLayout(),
    kinds: window.workspaceApp.punch.getActiveSlide().elements.map(e => e.type)
  })`));
  const rectCount = layoutState.kinds.filter(k => k === 'rect').length;
  const textCount = layoutState.kinds.filter(k => k === 'text').length;
  check('S9 Slides: tata letak "Dua Kolom" menghasilkan 2 kotak + 3 teks',
    layoutState.layout === 'two_column' && rectCount === 2 && textCount === 3,
    `layout=${layoutState.layout} rect=${rectCount} text=${textCount}`);
  const szSlides9 = await cdp.shot('test_user_slides_theme.png');
  check('S9 Slides: screenshot slide bertema gelap tersimpan', szSlides9 > 20000, szSlides9 + ' bytes');

  // ================= S10: FITUR BARU (klik nyata) =================
  console.log('\n--- S10: Fitur baru — pindah slide, ekspor bagan, butir bertingkat ---');

  // --- S10a: Slides — PINDAH URUTAN slide lewat tombol toolbar ---
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(300);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${slidesId}"]')`);
  await sleep(1300);
  const orderBefore = JSON.parse(await cdp.eval(`JSON.stringify({
    n: window.workspaceApp.punch.slides.length,
    titles: window.workspaceApp.punch.slides.map(s => s.title)
  })`));
  await cdp.eval('window.workspaceApp.punch.selectSlide(0)');
  await sleep(400);
  await cdp.click('document.getElementById("tbSlideDown")');
  await sleep(800);
  const orderAfter = JSON.parse(await cdp.eval(`JSON.stringify({
    idx: window.workspaceApp.punch.activeSlideIdx,
    titles: window.workspaceApp.punch.slides.map(s => s.title)
  })`));
  check('S10 Slides: tombol pindah-ke-bawah menukar urutan slide',
    orderAfter.idx === 1 && orderAfter.titles[1] === orderBefore.titles[0] && orderAfter.titles[0] === orderBefore.titles[1],
    `idx=${orderAfter.idx} urutan="${orderAfter.titles.join(' | ')}"`);
  await cdp.click('document.getElementById("tbSlideUp")');
  await sleep(800);
  const orderBack = JSON.parse(await cdp.eval(`JSON.stringify({
    idx: window.workspaceApp.punch.activeSlideIdx,
    titles: window.workspaceApp.punch.slides.map(s => s.title)
  })`));
  check('S10 Slides: tombol pindah-ke-atas mengembalikan urutan semula',
    orderBack.idx === 0 && JSON.stringify(orderBack.titles) === JSON.stringify(orderBefore.titles),
    `idx=${orderBack.idx} urutan="${orderBack.titles.join(' | ')}"`);

  // --- S10b: Sheets — tombol "Unduh SVG" pada kartu bagan ---
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(300);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${sheetsId}"]')`);
  await sleep(1300);
  await cdp.click('document.getElementById("tbInsertChart")');
  await sleep(900);
  const exportBtn = JSON.parse(await cdp.eval(`(() => {
    const b = document.getElementById('ritzChartExport');
    if (!b) return JSON.stringify({ ok: false, reason: 'tombol ekspor tidak ada' });
    const r = b.getBoundingClientRect();
    return JSON.stringify({ ok: true, w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 });
  })()`));
  check('S10 Sheets: kartu bagan menyediakan tombol "Unduh SVG" yang benar-benar terlihat',
    exportBtn.ok === true && exportBtn.visible === true, JSON.stringify(exportBtn));
  const svgLen = Number(await cdp.eval('(window.workspaceApp.ritz.chartSvgDocument() || "").length'));
  check('S10 Sheets: dokumen SVG bagan berukuran wajar (bukan string kosong)',
    svgLen > 500, svgLen + ' chars');
  // CATATAN JUJUR: unduhan berkasnya sendiri tidak diverifikasi di Chrome headless
  // (tanpa folder unduhan). Yang diuji: tombol ada, dapat diklik, dan kartu bagan
  // tetap utuh setelah diklik — bukan "berkas berhasil tersimpan ke disk".
  await cdp.click('document.getElementById("ritzChartExport")');
  await sleep(800);
  const afterExport = JSON.parse(await cdp.eval(`JSON.stringify({
    stillThere: !!document.getElementById('ritzChartExport'),
    charts: window.workspaceApp.ritz.getCharts().length
  })`));
  check('S10 Sheets: mengklik "Unduh SVG" tidak merusak kartu bagan',
    afterExport.stillThere === true && afterExport.charts === 1, JSON.stringify(afterExport));

  // --- S10c: Docs — butir bertingkat (penanda berubah per level indentasi) ---
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(300);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${docsId}"]')`);
  await sleep(1300);
  await clickDocsLine(1);
  // Baris ini mungkin sudah ber-list dari seksi sebelumnya; klik hanya bila perlu,
  // karena tombol daftar bersifat TOGGLE (klik saat sudah butir = melepas).
  const ltBefore10 = await cdp.eval('window.workspaceApp.kix.pages[0].lines[1].listType || ""');
  if (ltBefore10 !== 'bullet') { await cdp.click('document.getElementById("tbBulletList")'); await sleep(700); }
  const bulletLvl0 = await cdp.eval('window.workspaceApp.kix.listPrefixFor(window.workspaceApp.kix.pages[0], 1)');
  check('S10 Docs: butir level 0 memakai penanda "\\u2022 "', bulletLvl0 === '\u2022 ', JSON.stringify(bulletLvl0));
  await cdp.click('document.getElementById("tbIndentInc")');
  await sleep(700);
  const indentLvl10 = Number(await cdp.eval('window.workspaceApp.kix.pages[0].lines[1].indent || 0'));
  const bulletLvl1 = await cdp.eval('window.workspaceApp.kix.listPrefixFor(window.workspaceApp.kix.pages[0], 1)');
  check('S10 Docs: indentasi menaikkan level & penanda berubah jadi "\\u25cb "',
    indentLvl10 >= 1 && bulletLvl1 === '\u25cb ', `indent=${indentLvl10} prefix=${JSON.stringify(bulletLvl1)}`);
  const szDocs10 = await cdp.shot('test_user_docs_nested_bullet.png');
  check('S10 Docs: screenshot butir bertingkat tersimpan', szDocs10 > 20000, szDocs10 + ' bytes');

  // ================= S11: DOCS — PEMISAH HALAMAN MANUAL (Ctrl+Enter) =================
  // Unit test (14h) membuktikan MODEL terpotong, tetapi belum ada bukti bahwa
  // Ctrl+Enter benar-benar sampai ke editor lewat keyboard nyata dan menghasilkan
  // TILE KANVAS baru. Semua langkah di sini lewat CDP: klik kanvas asli,
  // keydown asli, lalu periksa model + DOM + piksel + disk.
  console.log('\n--- S11: Docs — pemisah halaman manual (Ctrl+Enter) ---');
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(300);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${docsId}"]')`);
  await sleep(1300);

  // Klik pada BARIS dan POSISI X tertentu. Sejak charIndexAtPoint() dipasang,
  // klik kanvas menaruh kursor di karakter yang diklik — jadi titik klik
  // menentukan posisi potong. Koordinat diambil dari editor (lineRectAt),
  // bukan angka ajaib, agar tidak meleset saat tinggi baris berubah.
  const clickDocsAt = async (lIdx, fx) => {
    const pos = JSON.parse(await cdp.eval(`(() => {
      const app = window.workspaceApp.kix;
      const c = document.querySelector('#docsScrollBox .kix-page canvas');
      if (!c || !app) return JSON.stringify({ ok: false });
      const r = c.getBoundingClientRect();
      const row = app.lineRectAt(0, ${lIdx});
      const scale = r.width / (c.width || r.width);
      return JSON.stringify({
        ok: true,
        x: Math.round(r.left + r.width * ${fx}),
        y: Math.round(r.top + row.centerY * scale)
      });
    })()`));
    if (!pos.ok) throw new Error('Kanvas Docs tidak ditemukan untuk klik baris #' + lIdx);
    await cdp.clickAt(pos.x, pos.y);
    await sleep(350);
  };

  const pbBefore = JSON.parse(await cdp.eval(`JSON.stringify({
    pages: window.workspaceApp.kix.pages.length,
    tiles: document.querySelectorAll('#docsScrollBox .kix-page').length,
    pageIdx: window.workspaceApp.kix.activePageIdx,
    text: window.workspaceApp.kix.pages[0].lines[0].text
  })`));
  // Cari titik klik yang benar-benar mendarat di TENGAH teks (bukan ujung baris),
  // supaya pemotongan halaman punya dua sisi yang bisa diperiksa. Kalau kursor
  // selalu jatuh di akhir baris, itu sendiri pertanda charIndexAtPoint mati.
  let cut11 = 0;
  for (const fx of [0.32, 0.24, 0.16, 0.10, 0.40]) {
    await clickDocsAt(0, fx);
    cut11 = Number(await cdp.eval('window.workspaceApp.kix.cursorCharIdx'));
    if (cut11 > 0 && cut11 < pbBefore.text.length) break;
  }
  check('S11 Docs: klik kanvas menaruh kursor di TENGAH teks (bukan ujung baris)',
    cut11 > 0 && cut11 < pbBefore.text.length, `cut=${cut11} len=${pbBefore.text.length}`);
  const focus11 = await cdp.eval('document.activeElement ? document.activeElement.id : ""');
  check('S11 Docs: fokus ada di interceptor Kix sebelum Ctrl+Enter',
    focus11 === 'kixHiddenInput', String(focus11));

  await cdp.key('Enter', 2);   // modifiers 2 = Ctrl
  await sleep(900);

  const pbAfter = JSON.parse(await cdp.eval(`JSON.stringify({
    pages: window.workspaceApp.kix.pages.length,
    tiles: document.querySelectorAll('#docsScrollBox .kix-page').length,
    left: window.workspaceApp.kix.pages[${pbBefore.pageIdx}].lines[0].text,
    right: window.workspaceApp.kix.pages[${pbBefore.pageIdx + 1}].lines[0].text,
    activePageIdx: window.workspaceApp.kix.activePageIdx,
    activeLineIdx: window.workspaceApp.kix.activeLineIdx,
    cursorCharIdx: window.workspaceApp.kix.cursorCharIdx
  })`));
  check('S11 Docs: Ctrl+Enter menambah HALAMAN di model',
    pbAfter.pages === pbBefore.pages + 1, `${pbBefore.pages} -> ${pbAfter.pages}`);
  check('S11 Docs: tile kanvas baru benar-benar dibuat di DOM',
    pbAfter.tiles === pbBefore.tiles + 1, `${pbBefore.tiles} -> ${pbAfter.tiles}`);
  check('S11 Docs: teks terpotong tepat di posisi kursor',
    pbAfter.left === pbBefore.text.slice(0, cut11) && pbAfter.right === pbBefore.text.slice(cut11),
    JSON.stringify([pbAfter.left, pbAfter.right]));
  check('S11 Docs: kursor pindah ke awal halaman baru',
    pbAfter.activePageIdx === pbBefore.pageIdx + 1 && pbAfter.activeLineIdx === 0 && pbAfter.cursorCharIdx === 0,
    `p=${pbAfter.activePageIdx} l=${pbAfter.activeLineIdx} c=${pbAfter.cursorCharIdx}`);

  // INDIKATOR HALAMAN SADAR-VIEWPORT (kuirk Math.floor(scrollTop/850)+1).
  //
  // Dulu status bar menghitung halaman dari scrollTop dibagi PAGE_CANVAS_HEIGHT
  // (850 = tinggi koordinat INTERNAL kanvas), sedangkan pitch tile nyata di DOM
  // = min-height 1056 + margin-bottom 24. Akibatnya tepat setelah pemisah
  // halaman indikator TERTINGGAL satu halaman: kursor sudah di halaman baru,
  // angka di status bar masih halaman lama.
  //
  // Diperiksa SEBELUM scroll manual di bawah, supaya yang terbukti adalah
  // editor sendiri yang memindahkan viewport (scrollPageIntoView), bukan tes.
  const indicator11 = JSON.parse(await cdp.eval(`JSON.stringify({
    curText: (document.getElementById('docsCurPage') || {}).textContent || '',
    statusText: (document.getElementById('docsStatusText') || {}).textContent || '',
    scrollTop: Math.round(document.getElementById('docsScrollBox').scrollTop),
    activePageIdx: window.workspaceApp.kix.activePageIdx,
    totalPages: window.workspaceApp.kix.pages.length
  })`));
  check('S11 Docs: status bar menunjukkan HALAMAN KURSOR (bukan tertinggal di halaman lama)',
    Number(indicator11.curText) === indicator11.activePageIdx + 1,
    `bar=${indicator11.curText} kursor=${indicator11.activePageIdx + 1} | ${indicator11.statusText}`);
  check('S11 Docs: status bar menyebut total halaman yang benar',
    indicator11.statusText.includes(`dari ${indicator11.totalPages}`),
    indicator11.statusText);
  // Kursor di halaman ke-2 dst. berarti tile halaman itu berada di atas:
  // viewport WAJIB sudah bergeser tanpa perlu scroll manual dari tes.
  check('S11 Docs: viewport otomatis bergeser ke halaman baru (tanpa scroll manual)',
    indicator11.activePageIdx === 0 || indicator11.scrollTop > 0,
    `scrollTop=${indicator11.scrollTop} aktif=${indicator11.activePageIdx}`);

  // Model bisa benar sementara layar kosong; periksa piksel kanvas halaman baru.
  const paint11 = JSON.parse(await cdp.eval(`(() => {
    const c = document.getElementById('kixCanvas' + window.workspaceApp.kix.pages.length);
    if (!c) return JSON.stringify({ ok: false, reason: 'kanvas halaman baru tidak ada' });
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) n++;
    return JSON.stringify({ ok: true, pixels: n });
  })()`));
  check('S11 Docs: kanvas halaman baru benar-benar ter-paint',
    paint11.ok === true && paint11.pixels > 500, JSON.stringify(paint11));

  // Screenshot harus BENAR-BENAR memperlihatkan sambungan dua halaman. Tanpa
  // menggulir, viewport hanya menampilkan halaman 1 dan bukti visualnya jadi
  // menyesatkan (nama berkas menjanjikan "dua halaman", gambar menunjukkan satu).
  // Gulir sampai puncak halaman baru berada ~260px di bawah tepi atas scrollBox,
  // sehingga ekor halaman lama dan kepala halaman baru terlihat bersamaan.
  const seam11 = JSON.parse(await cdp.eval(`(() => {
    const sb = document.getElementById('docsScrollBox');
    const pg = document.getElementById('kixPage${pbBefore.pageIdx + 2}');
    if (!sb || !pg) return JSON.stringify({ ok: false });
    const delta = pg.getBoundingClientRect().top - sb.getBoundingClientRect().top - 260;
    sb.scrollTop = Math.max(0, sb.scrollTop + delta);
    return JSON.stringify({ ok: true, scrollTop: Math.round(sb.scrollTop) });
  })()`));
  await sleep(500);
  check('S11 Docs: viewport digulir ke sambungan dua halaman', seam11.ok === true,
    JSON.stringify(seam11));
  const szPb = await cdp.shot('test_user_docs_pagebreak.png');
  check('S11 Docs: screenshot sambungan dua halaman tersimpan', szPb > 20000, szPb + ' bytes');

  // Persistensi: pemisah halaman harus ikut autosave, bukan hanya di memori.
  await sleep(1400);
  const pbDisk = await apiGet(docsId);
  const pbDiskPages = pbDisk && pbDisk.data && Array.isArray(pbDisk.data.pages) ? pbDisk.data.pages.length : -1;
  check('S11 Docs: jumlah halaman ikut tersimpan ke disk',
    pbDiskPages === pbAfter.pages, `disk=${pbDiskPages} memori=${pbAfter.pages}`);

  // Enter BIASA sesudahnya harus tetap menambah BARIS, bukan halaman —
  // membuktikan cabang Ctrl+Enter tidak "bocor" ke perilaku normal.
  // Asersi RELATIF: halaman baru bisa mewarisi baris lain dari halaman sumber
  // (seksi S9/S10 sudah menambah baris), jadi patokannya "bertambah satu",
  // bukan angka mutlak 2.
  const linesBefore11 = Number(await cdp.eval(
    `window.workspaceApp.kix.pages[${pbBefore.pageIdx + 1}].lines.length`));
  await cdp.key('Enter', 0);
  await sleep(700);
  const enter11 = JSON.parse(await cdp.eval(`JSON.stringify({
    pages: window.workspaceApp.kix.pages.length,
    lines: window.workspaceApp.kix.pages[${pbBefore.pageIdx + 1}].lines.length
  })`));
  check('S11 Docs: Enter biasa setelah pemisah menambah BARIS (bukan halaman)',
    enter11.pages === pbAfter.pages && enter11.lines === linesBefore11 + 1,
    `${linesBefore11} -> ${enter11.lines} baris, pages=${enter11.pages}`);

  // ================= S12: SHEETS — KOMENTAR SEL (DOM NYATA) =================
  // m4 tidak bisa dibuktikan lewat unit suite: WorkspaceAppShell TIDAK pernah
  // diinstansiasi di sana (butuh DOM penuh), jadi Suite 9b hanya memindai teks
  // sumber. Di sini seluruh rantai diuji dengan klik & ketik NYATA.
  //
  // Sel target TIDAK di-hardcode. Overlay bagan (ritzChartOverlay) adalah elemen
  // DOM DI ATAS kanvas, jadi sel di bawahnya tidak bisa diklik user sama sekali.
  // Kandidat dicari dinamis dan diverifikasi dengan elementFromPoint, sehingga
  // bila gagal, detailnya menunjukkan PENYEBAB (tertutup overlay / di luar
  // viewport), bukan sekadar "sel salah".
  console.log('\n--- S12: Sheets — komentar sel lewat klik nyata ---');
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(500);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${sheetsId}"]')`);
  await sleep(1400);
  check('S12: kembali ke spreadsheet uji', (await cdp.eval('window.workspaceApp.currentApp')) === 'sheets');

  const target12 = JSON.parse(await cdp.eval(`(() => {
    const r = window.workspaceApp.ritz;
    const c = document.getElementById('sheetsGridCanvas');
    const b = c.getBoundingClientRect();
    const sx = b.width ? c.width / b.width : 1;
    const sy = b.height ? c.height / b.height : 1;
    const ov = document.getElementById('ritzChartOverlay');
    const o = (ov && getComputedStyle(ov).display !== 'none') ? ov.getBoundingClientRect() : null;
    for (let row = 1; row <= 40; row++) {
      for (let col = 0; col <= 10; col++) {
        const cx = r.cellX(col) + r.getColWidth(col) / 2;
        const cy = r.cellY(row) + r.getRowHeight(row) / 2;
        const px = b.left + cx / sx, py = b.top + cy / sy;
        if (px < 4 || py < 4 || px > window.innerWidth - 4 || py > window.innerHeight - 4) continue;
        if (o && px >= o.left && px <= o.right && py >= o.top && py <= o.bottom) continue;
        if (document.elementFromPoint(px, py) !== c) continue;
        return JSON.stringify({ ok: true, col: col, row: row, x: Math.round(px), y: Math.round(py), coord: r.colLabel(col) + row, chart: !!o });
      }
    }
    return JSON.stringify({ ok: false, chart: !!o });
  })()`));
  check('S12: ada sel yang benar-benar bisa diklik user (tidak tertutup overlay bagan)',
    target12.ok === true, JSON.stringify(target12));

  await cdp.clickAt(target12.x, target12.y);
  await sleep(300);
  const active12 = await cdp.eval('window.workspaceApp.ritz.getActiveCoord()');
  check('S12: klik nyata memilih sel target', active12 === target12.coord,
    `klik=${target12.coord} aktif=${active12}`);

  // Tombol komentar WAJIB hidup di Sheets. Sebelum m4 handler-nya hanya
  // menangani docs, sehingga tombol ini mati total di Sheets.
  await cdp.click('document.getElementById("tbComment")');
  await sleep(450);
  const modal12 = await cdp.eval('(() => { const m = document.getElementById("gwsModal"); if (!m) return "no-modal"; if (m.style.display !== "flex") return "hidden"; return /Komentar Sel/.test(m.innerText || m.textContent || "") ? "ok" : "wrong-modal"; })()');
  check('S12: klik tbComment di Sheets membuka modal komentar SEL (bukan Docs)', modal12 === 'ok', String(modal12));

  await cdp.click('document.getElementById("gwsSheetCommentText")');
  await cdp.insertText('Tolong cek angka ini');
  await cdp.click('document.getElementById("gwsSheetCommentAdd")');
  await sleep(600);
  const cc12 = await cdp.eval(`window.workspaceApp.ritz.getCellComments("${target12.coord}").length`);
  check('S12: komentar tersimpan di model sel target', cc12 === 1,
    `sel=${target12.coord} jumlah=${cc12}`);
  const ccAuthor = await cdp.eval(`window.workspaceApp.ritz.getCellComments("${target12.coord}")[0].author`);
  check('S12: author default "Saya" (dialek sama dengan Docs)', ccAuthor === 'Saya', String(ccAuthor));

  // Indikator harus BENAR-BENAR ter-paint di kanvas, bukan hanya ada di model.
  // Ambang dilonggarkan: indikator digambar SEBELUM overlay seleksi biru 12%,
  // jadi warnanya sedikit tercampur.
  const ind12 = JSON.parse(await cdp.eval(`(() => {
    const r = window.workspaceApp.ritz;
    const t = r.cellCommentRect(${target12.col}, ${target12.row});
    const c = document.getElementById('sheetsGridCanvas');
    const d = c.getContext('2d').getImageData(Math.round(t.x), Math.round(t.y), t.w, t.h).data;
    let amber = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] > 130 && d[i + 1] < 210 && d[i + 2] < 100 && d[i + 3] > 100) amber++;
    }
    return JSON.stringify({ amber: amber, x: Math.round(t.x), y: Math.round(t.y) });
  })()`));
  check('S12: indikator komentar benar-benar ter-paint di kanvas', ind12.amber >= 20,
    JSON.stringify(ind12));

  // Balas.
  await cdp.click('document.querySelector("#gwsModal .sc-reply-input")');
  await cdp.insertText('Sudah saya periksa');
  await cdp.click('document.querySelector("#gwsModal .sc-reply-btn")');
  await sleep(600);
  const rp12 = await cdp.eval(`window.workspaceApp.ritz.getCellComments("${target12.coord}")[0].replies.length`);
  check('S12: balasan tersimpan di thread', rp12 === 1, 'balasan=' + rp12);

  // Selesaikan (toggle).
  await cdp.click('document.querySelector("#gwsModal .sc-resolve")');
  await sleep(600);
  const rs12 = await cdp.eval(`window.workspaceApp.ritz.getCellComments("${target12.coord}")[0].resolved`);
  check('S12: tombol Selesai menandai komentar resolved', rs12 === true, String(rs12));

  // Persistensi ke DISK: komentar harus ikut tersimpan, bukan hanya di memori.
  await sleep(1900);
  const disk12 = await apiGet(sheetsId);
  const sheetsDisk = disk12 && disk12.data && Array.isArray(disk12.data.sheets) ? disk12.data.sheets : [];
  const hit12 = sheetsDisk.map(s => (s && s.cellComments) || {}).filter(m => m[target12.coord]);
  check('S12: cellComments ikut tersimpan ke disk',
    hit12.length === 1 && Array.isArray(hit12[0][target12.coord]) && hit12[0][target12.coord].length === 1,
    `sel=${target12.coord} sheet=${sheetsDisk.length}`);

  // BUKTI round-trip lewat disk: reload halaman, buka dokumen lagi, komentar
  // harus masih ada. Inilah yang membuktikan whitelist setSheets tidak bocor.
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(2400);
  await cdp.waitFor('!!(window.workspaceApp && window.workspaceApp.ritz)', 12000);
  await cdp.click('document.getElementById("tab-drive")');
  await sleep(700);
  await cdp.click(`document.querySelector('#driveGridContainer .drive-card[data-doc-id="${sheetsId}"]')`);
  await sleep(1600);
  const afterReload12 = await cdp.eval(`window.workspaceApp.ritz.getCellComments("${target12.coord}").length`);
  check('S12: komentar SELAMAT melewati reload (bukti round-trip disk -> model)',
    afterReload12 === 1, `sel=${target12.coord} jumlah=${afterReload12}`);
  const afterReply12 = await cdp.eval(`window.workspaceApp.ritz.getCellComments("${target12.coord}")[0].replies.length`);
  check('S12: balasan juga selamat melewati reload', afterReply12 === 1, 'balasan=' + afterReply12);

  // Hapus komentar terakhir: kunci harus dibuang & modal menutup sendiri.
  await cdp.clickAt(target12.x, target12.y);
  await sleep(400);
  await cdp.click('document.getElementById("tbComment")');
  await sleep(500);
  await cdp.click('document.querySelector("#gwsModal .sc-delete")');
  await sleep(700);
  const delObj = JSON.parse(await cdp.eval(`(() => {
    const r = window.workspaceApp.ritz;
    const m = document.getElementById('gwsModal');
    return JSON.stringify({
      has: r.hasCellComment("${target12.coord}"),
      key: Object.prototype.hasOwnProperty.call(r.getAllCellComments(), "${target12.coord}"),
      hidden: !m || m.style.display !== 'flex'
    });
  })()`));
  check('S12: hapus komentar membersihkan model & kuncinya',
    delObj.has === false && delObj.key === false, JSON.stringify(delObj));
  check('S12: modal menutup sendiri saat komentar terakhir dihapus', delObj.hidden === true,
    JSON.stringify(delObj));

  // Ctrl+Alt+M harus berlaku di Sheets juga (paritas Google Sheets).
  // modifiers CDP bersifat BITMASK: Alt=1, Ctrl=2, Meta=4, Shift=8.
  // Ctrl+Alt = 3. Memakai 1 (Alt saja) TIDAK akan pernah sampai ke cabang
  // 'm', karena initKeyboardShortcuts() sudah keluar lebih awal pada guard
  // `if (!e.ctrlKey && !e.metaKey) return;` — tes akan gagal secara palsu.
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77, nativeVirtualKeyCode: 77, modifiers: 3 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77, nativeVirtualKeyCode: 77, modifiers: 3 });
  await sleep(600);
  const hot12 = await cdp.eval('(() => { const m = document.getElementById("gwsModal"); return !!(m && m.style.display === "flex" && /Komentar Sel/.test(m.innerText || m.textContent || "")); })()');
  check('S12: Ctrl+Alt+M membuka komentar sel di Sheets', hot12 === true, String(hot12));
  await cdp.eval('window.workspaceApp.closeModal()');
  await sleep(300);

  // ================= ERROR FRONTEND =================
  console.log('\n--- Error frontend yang tertangkap selama seluruh alur user ---');
  check('Tidak ada exception JS selama seluruh alur', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('Tidak ada console.error aplikasi selama seluruh alur', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  // ================= CLEANUP (dokumen uji saja) =================
  console.log('\n--- Cleanup: hapus HANYA dokumen uji; seed asli tidak disentuh ---');
  for (const id of [docsId, sheetsId, slidesId, ...extraIds].filter(Boolean)) {
    await fetch(`${API}/api/documents/${id}`, { method: 'DELETE' });
  }
  const finalList = await apiList();
  const finalIds = (finalList || []).map(d => d.id).sort();
  check('Dokumen uji terhapus & seed asli utuh (tidak termutasi)', JSON.stringify(finalIds) === JSON.stringify(seedBefore), `sisa=${finalIds.length} seed=${seedBefore.length}`);

  console.log('\n================================================================');
  console.log(` HASIL UJI E2E USER: ${PASS} PASSED, ${FAIL} FAILED`);
  console.log('================================================================');
  results.forEach(r => console.log(r));
})().catch((err) => {
  console.error('E2E ERROR:', err.message);
  FAIL++;
}).finally(async () => {
  try { if (ws) ws.close(); } catch {}
  if (chrome) await new Promise((res) => execFile('taskkill', ['/F', '/T', '/PID', String(chrome.pid)], () => res()));
  await sleep(700);
  await cleanProfile();
  await stopIsolatedServer();
  process.exit(FAIL > 0 ? 1 : 0);
});
