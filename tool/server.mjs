// D:\program\google\tool\server.mjs
// Local HTTP Server untuk Web Dashboard Google Workspace Terpadu & Fungsional

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { classifyPayload, classifyArtifact } from './gws_classifier.mjs';
import { decodeBootstrapPayload, inspectWasmBinary } from './wasm_verifier.mjs';
import { KixTileEngine, PunchSvgEngine, RitzGridEngine } from './engine_prototypes.mjs';
import { initSeedData, listDocuments, getDocument, saveDocument, deleteDocument, getDocumentType, setDocumentStar } from './store.mjs';
import { evaluateFormula, evaluateAllSheetCells } from './formula.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8765;
const HOST = '127.0.0.1'; // Keamanan: bind ke loopback saja

const rawCdp2Dir = path.resolve(__dirname, '../public/raw-cdp2');
const wasmBinaryPath = path.resolve(__dirname, '../public/sheets/calcworker_wasm_cd.wasm');
const dashboardPath = path.resolve(__dirname, 'dashboard.html');
const staticDir = path.resolve(__dirname, 'static');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

// Inisialisasi seed data dokumen Drive saat server mulai
initSeedData();

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendFile(res, filePath, contentType) {
  try {
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': buf.length
    });
    res.end(buf);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Gagal membaca file');
  }
}

// Validasi bentuk payload terhadap tipe dokumen.
// Mencegah korupsi data: tanpa ini, autosave tertunda dari editor lain bisa
// menulis struktur `pages` (Docs) ke dalam dokumen bertipe `sheets`.
const TYPE_KEYS = { docs: 'pages', sheets: 'cells', slides: 'slides' };

function validatePayload(type, json) {
  if (!json || typeof json !== 'object') return 'Payload harus berupa objek JSON';
  if (json.data === undefined) return null; // hanya update metadata (title/starred)

  const expectedKey = TYPE_KEYS[type];
  if (!expectedKey) return null;

  const keys = Object.keys(json.data || {});
  const hasExpected = expectedKey in (json.data || {});

  // Payload berisi kunci struktur (pages/cells/slides) tetapi bukan milik tipe ini.
  if (!hasExpected) {
    const foreign = keys.find(k => Object.values(TYPE_KEYS).includes(k));
    if (foreign) {
      return `Payload tidak cocok untuk dokumen bertipe '${type}': menerima '${foreign}', seharusnya '${expectedKey}'`;
    }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const pathname = url.pathname;

  // Header CORS untuk client browser lokal
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Dashboard UI Utama
  if (pathname === '/' || pathname === '/index.html') {
    if (fs.existsSync(dashboardPath)) {
      sendFile(res, dashboardPath, 'text/html; charset=utf-8');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('dashboard.html belum dibuat');
    }
    return;
  }

  // 2. Static File Serving: Modular Scripts (/static/:file)
  if (pathname.startsWith('/static/')) {
    const filename = path.basename(pathname);
    const filePath = path.join(staticDir, filename);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      sendFile(res, filePath, MIME_TYPES[ext] || 'application/javascript; charset=utf-8');
      return;
    }
  }

  // 3. Static File Serving: Screenshots (/shots/:file)
  if (pathname.startsWith('/shots/')) {
    const filename = path.basename(pathname);
    const filePath = path.join(rawCdp2Dir, filename);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      sendFile(res, filePath, MIME_TYPES[ext] || 'image/png');
      return;
    }
  }

  // 4. REST API: /api/documents (Drive Hub - List & Create)
  if (pathname === '/api/documents') {
    if (req.method === 'GET') {
      const docs = listDocuments();
      sendJson(res, 200, docs);
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const json = JSON.parse(body || '{}');
          const type = json.type || 'docs';
          const title = json.title || (type === 'sheets' ? 'Spreadsheet Tanpa Judul' : (type === 'slides' ? 'Presentasi Tanpa Judul' : 'Dokumen Tanpa Judul'));
          const id = `${type}-${crypto.randomBytes(4).toString('hex')}`;

          let defaultData = {};
          if (type === 'docs') {
            defaultData = {
              pages: [
                {
                  pageNumber: 1,
                  lines: [
                    { text: title, bold: true, size: 20, color: '#1a73e8' },
                    { text: 'Mulai mengetik isi dokumen Anda di sini...', bold: false, size: 13, color: '#5f6368' }
                  ]
                }
              ]
            };
          } else if (type === 'sheets') {
            defaultData = {
              cells: {
                'A1': { val: 'Kolom 1', raw: 'Kolom 1' },
                'B1': { val: 'Kolom 2', raw: 'Kolom 2' },
                'C1': { val: 0, raw: '=SUM(C2:C4)' }
              }
            };
          } else if (type === 'slides') {
            defaultData = {
              slides: [
                {
                  id: 1,
                  title: 'Slide 1: Cover',
                  elements: [
                    { id: 'el-1', type: 'rect', x: 0, y: 0, width: 960, height: 12, fill: '#f29900' },
                    { id: 'el-2', type: 'text', x: 80, y: 120, text: title, font: 'Google Sans, Arial', size: 36, weight: 'bold', fill: '#1a73e8' },
                    { id: 'el-3', type: 'text', x: 80, y: 180, text: 'Klik ganda pada teks untuk menyunting slide', font: 'Arial', size: 16, weight: 'normal', fill: '#5f6368' }
                  ]
                }
              ]
            };
          }

          const created = saveDocument(id, { title, data: defaultData });
          sendJson(res, 201, created);
        } catch (err) {
          sendJson(res, 400, { error: 'Payload tidak valid: ' + err.message });
        }
      });
      return;
    }
  }

  // 5. REST API: /api/documents/:id (Get, Update/Autosave, Delete)
  if (pathname.startsWith('/api/documents/')) {
    const docId = path.basename(pathname);

    if (req.method === 'GET') {
      const doc = getDocument(docId);
      if (doc) {
        sendJson(res, 200, doc);
      } else {
        sendJson(res, 404, { error: 'Dokumen tidak ditemukan' });
      }
      return;
    }

    if (req.method === 'PUT') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const json = JSON.parse(body || '{}');
          const existingType = getDocumentType(docId);
          if (!existingType) {
            sendJson(res, 404, { error: 'Dokumen tidak ditemukan' });
            return;
          }
          const invalid = validatePayload(existingType, json);
          if (invalid) {
            sendJson(res, 422, { error: invalid, expectedType: existingType });
            return;
          }
          const updated = saveDocument(docId, json);
          sendJson(res, 200, updated);
        } catch (err) {
          sendJson(res, 400, { error: 'Gagal menyimpan dokumen: ' + err.message });
        }
      });
      return;
    }

    if (req.method === 'DELETE') {
      deleteDocument(docId);
      sendJson(res, 200, { success: true, deletedId: docId });
      return;
    }
  }

  // 5b. REST API: /api/documents/:id/duplicate (Make a copy ala Drive)
  if (pathname.startsWith('/api/documents/') && pathname.endsWith('/duplicate') && req.method === 'POST') {
    const srcId = path.basename(pathname.replace(/\/duplicate$/, ''));
    const src = getDocument(srcId);
    if (!src) {
      sendJson(res, 404, { error: 'Dokumen sumber tidak ditemukan' });
      return;
    }
    const newId = `${src.type}-${crypto.randomBytes(4).toString('hex')}`;
    const copyTitle = `Salinan dari ${src.title}`;
    const created = saveDocument(newId, {
      title: copyTitle,
      type: src.type,
      data: src.data !== undefined ? JSON.parse(JSON.stringify(src.data)) : undefined
    });
    sendJson(res, 201, created);
    return;
  }

  // 5c. REST API: /api/documents/:id/star (Tandai favorit)
  if (pathname.startsWith('/api/documents/') && pathname.endsWith('/star') && req.method === 'POST') {
    const starId = path.basename(pathname.replace(/\/star$/, ''));
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const json = JSON.parse(body || '{}');
        const meta = setDocumentStar(starId, !!json.starred);
        if (!meta) {
          sendJson(res, 404, { error: 'Dokumen tidak ditemukan' });
          return;
        }
        sendJson(res, 200, meta);
      } catch (err) {
        sendJson(res, 400, { error: 'Gagal memperbarui bintang: ' + err.message });
      }
    });
    return;
  }

  // 6. REST API: /api/sheets/eval (Formula Evaluator Mesin Ritz)
  if (pathname === '/api/sheets/eval' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const json = JSON.parse(body || '{}');
        const cells = json.cells || {};
        const targetCoord = json.targetCoord;
        const formula = json.formula;

        if (targetCoord && formula !== undefined) {
          cells[targetCoord] = { raw: formula };
        }

        const evaluatedCells = evaluateAllSheetCells(cells);
        sendJson(res, 200, {
          success: true,
          cells: evaluatedCells,
          targetVal: targetCoord ? evaluatedCells[targetCoord]?.val : null
        });
      } catch (err) {
        sendJson(res, 400, { error: 'Evaluasi rumus gagal: ' + err.message });
      }
    });
    return;
  }

  // 7. REST API: /api/artifacts
  if (pathname === '/api/artifacts' && req.method === 'GET') {
    const apps = ['docs', 'slides', 'sheets'];
    const results = {};
    for (const app of apps) {
      const p = path.join(rawCdp2Dir, `${app}.json`);
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        results[app] = classifyArtifact(raw);
      }
    }
    sendJson(res, 200, results);
    return;
  }

  // 8. REST API: /api/wasm
  if (pathname === '/api/wasm' && req.method === 'GET') {
    const wb = "W251bGwsbnVsbCxudWxsLCJodHRwczovL2RvY3MuZ29vZ2xlLmNvbS9zdGF0aWMvc3ByZWFkc2hlZXRzMi9jbGllbnQvd2FzbS8yNDczMjA5MDY4LWNhbGN3b3JrZXJfd2FzbV9jZC53YXNtIl0=";
    const dec = decodeBootstrapPayload(wb);
    const wasmInfo = inspectWasmBinary(wasmBinaryPath);
    sendJson(res, 200, { bootstrap: dec, binary: wasmInfo });
    return;
  }

  // 9. REST API: /api/prototypes (Interactive Run)
  if (pathname === '/api/prototypes' && req.method === 'GET') {
    const scrollY = parseInt(url.searchParams.get('scrollY') || '2500', 10);
    const slideIdx = parseInt(url.searchParams.get('slide') || '1', 10);
    const formula = url.searchParams.get('formula') || '=SUM(10, 25, 65)';

    const kix = new KixTileEngine(10);
    const kixResult = kix.scrollTo(scrollY);

    const punch = new PunchSvgEngine(3);
    punch.selectSlide(slideIdx);
    const punchSvg = punch.renderActiveSlideSvg();

    const ritz = new RitzGridEngine(10000, 26);
    const ritzScroll = ritz.handleVirtualScroll(100, 300);
    const calcResult = await ritz.dispatchCalculation('C1', formula);

    sendJson(res, 200, {
      kix: {
        scrollY,
        mountedTiles: kixResult.mountedCanvasCount,
        visiblePages: kixResult.visiblePages,
        totalDomNodes: kixResult.totalDomNodes,
        cullingDemonstrated: !kixResult.visiblePages.includes(0)
      },
      punch: {
        activeSlide: slideIdx,
        canvasCount: punch.canvasCount,
        svgPreview: punchSvg
      },
      ritz: {
        canvasCount: ritzScroll.canvasCount,
        visibleWindow: ritzScroll.visibleWindow,
        workerCalculation: calcResult
      }
    });
    return;
  }

  // 10. REST API: /api/classify (Uji Payload)
  if (pathname === '/api/classify' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const json = JSON.parse(body || '{}');
        const result = classifyPayload(json.content || '');
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, { error: 'Invalid JSON payload' });
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`[GWS-SERVER] Dashboard aktif di http://${HOST}:${PORT}`);
  console.log(`[GWS-SERVER] Melayani REST API & purwarupa interaktif Google Workspace`);
});
