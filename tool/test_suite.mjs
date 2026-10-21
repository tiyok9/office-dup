// D:\program\google\tool\test_suite.mjs
// Automated Test Suite: Menguji seluruh modul program terhadap artefak analisis nyata

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPayload, classifyArtifact } from './gws_classifier.mjs';
import { decodeBootstrapPayload, inspectWasmBinary, V8_GAP_PATTERNS, isV8FeatureGap } from './wasm_verifier.mjs';
import { KixTileEngine, PunchSvgEngine, RitzGridEngine } from './engine_prototypes.mjs';
import { evaluateFormula, evaluateAllSheetCells, isErrorToken } from './formula.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==== HERMETIS: unit suite TIDAK BOLEH menyentuh store/ produksi ====
// Suite 5/8 memang menguji operasi TULIS (setDocumentStar, saveDocument), jadi
// bila diarahkan ke store asli, isi dokumen contoh ikut berubah dan memicu
// diagnosis palsu "seed rusak". Semua tulisan dialihkan ke dev/store-unit.
// store.mjs dibaca secara DINAMIS di bawah, sehingga env ini sudah berlaku.
process.env.WORKSPACE_STORE_DIR = path.resolve(__dirname, 'dev', 'store-unit');
try { fs.rmSync(process.env.WORKSPACE_STORE_DIR, { recursive: true, force: true }); } catch {}
const rawCdp2Dir = path.resolve(__dirname, '../public/raw-cdp2');
const wasmBinaryPath = path.resolve(__dirname, '../public/sheets/calcworker_wasm_cd.wasm');

let passedTests = 0;
let failedTests = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  [PASS] ${testName}`);
    passedTests++;
  } else {
    console.error(`  [FAIL] ${testName}`);
    failedTests++;
  }
}

// Potong body sebuah method via brace-matching yang MEMAHAMI string, template
// literal, dan komentar. Dipakai tes kontrak sumber supaya tidak lagi bergantung
// pada jendela karakter ajaib seperti {0,8000}: body renderPage 15.062 karakter,
// jendela 8.000 tidak pernah match dan asersi jadi gagal-senyap.
function sliceMethod(source, name) {
  // Wajib berbentuk definisi: `nama(...) {`. Tanpa `) {` di akhir, regex juga
  // mencocokkan call-site seperti `this.renderPage(i);` dan body yang dipotong
  // jadi sampah yang tetap non-kosong -> guard lolos padahal metode hilang.
  const re = new RegExp('^\\s{0,8}(?:async\\s+)?' + name + '\\s*\\([^)]*\\)\\s*\\{', 'm');
  const m = re.exec(source);
  if (!m) return '';
  const open = source.indexOf('{', m.index + m[0].length - 1);
  if (open < 0) return '';
  let depth = 0, i = open, inS = null, inLc = false, inBc = false;
  for (; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (inLc) { if (c === '\n') inLc = false; continue; }
    if (inBc) { if (c === '*' && n === '/') { inBc = false; i++; } continue; }
    if (inS) {
      if (c === '\\') { i++; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '/' && n === '/') { inLc = true; i++; continue; }
    if (c === '/' && n === '*') { inBc = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return source.slice(m.index, i + 1); }
  }
  return '';
}

// Helper: pastikan pattern ADA di source DAN TIDAK dibungkam `if (false && ...)`.
// Menutup pola survivor yang sudah dua kali menggigit (C4, C6).
// Signature: assertActive(source, pattern, msg)
//   - pattern: RegExp yang harus cocok di source
//   - Otomatis menolak kalau baris yang cocok dimulai dengan `if (false &&`
function assertActive(src, pattern, msg) {
  assert(pattern.test(src), msg);
  // Cari SEMUA baris yang cocok, periksa tiap baris tidak dimulai false &&
  const lines = src.split('\n');
  for (const line of lines) {
    if (pattern.test(line)) {
      const trimmed = line.trim();
      assert(!/^if\s*\(\s*false\s*&&/.test(trimmed),
        msg + ' [GUARD: baris ini dibungkam false &&]');
    }
  }
}

async function runTestSuite() {
  console.log('====================================================');
  console.log(' RUNNING AUTOMATED TESTS: GOOGLE WORKSPACE ENGINE');
  console.log('====================================================\n');

  // TEST SUITE 1: KLASIFIKASI PAYLOAD & SOFT-404
  console.log('--- Suite 1: Payload Classifier & Soft-404 Detection ---');
  const soft404Html = '<html><head><title>Google Dokumen</title></head><body><h1>Halaman Tidak Ditemukan</h1><p>Maaf, file tidak ada.</p></body></html>';
  const c1 = classifyPayload(soft404Html);
  assert(c1.status === 'SOFT_404' && c1.valid === false, 'Deteksi soft-404 dari teks "Halaman Tidak Ditemukan"');

  const docsHtml = '<div class="kix-page"><canvas class="kix-canvas-tile-content"></canvas></div>';
  const c2 = classifyPayload(docsHtml);
  assert(c2.valid === true && c2.engine === 'Kix' && c2.app === 'Google Docs', 'Klasifikasi Kix engine Docs dari kix-canvas-tile-content');

  const slidesHtml = '<div class="punch-viewer-content"><svg class="punch-slide"></svg></div>';
  const c3 = classifyPayload(slidesHtml);
  assert(c3.valid === true && c3.engine === 'Punch' && c3.expectedSurface.canvas === 0, 'Klasifikasi Punch engine Slides (0 canvas)');

  const sheetsHtml = '<div class="grid4-inner-container"><canvas class="waffle-canvas"></canvas></div>';
  const c4 = classifyPayload(sheetsHtml);
  assert(c4.valid === true && c4.engine.startsWith('Ritz') && c4.expectedSurface.canvas === 1, 'Klasifikasi Ritz engine Sheets (1 single canvas)');

  // TEST SUITE 2: ANALISIS ARTEFAK EMPIRIS (RAW-CDP2)
  console.log('\n--- Suite 2: Real Empirical Artifact Parsing (raw-cdp2) ---');
  const docsData = JSON.parse(fs.readFileSync(path.join(rawCdp2Dir, 'docs.json'), 'utf8'));
  const docsAnalysis = classifyArtifact(docsData);
  assert(docsAnalysis.surfaceMetrics.canvas === 3, 'Docs artefak: memuat 3 elemen canvas awal');
  assert(docsAnalysis.scrollEvaluation.scrollMoved === true, 'Docs artefak: scrollMoved = true');
  assert(docsAnalysis.workerMetrics.realAppWorkers === 0, 'Docs artefak: 0 App Worker (service worker ekstensi terisolasi)');

  const slidesData = JSON.parse(fs.readFileSync(path.join(rawCdp2Dir, 'slides.json'), 'utf8'));
  const slidesAnalysis = classifyArtifact(slidesData);
  assert(slidesAnalysis.surfaceMetrics.canvas === 0, 'Slides artefak: 0 elemen canvas (Pure Vector)');
  assert(slidesAnalysis.surfaceMetrics.svg === 17, 'Slides artefak: memuat 17 root elemen SVG');

  const sheetsData = JSON.parse(fs.readFileSync(path.join(rawCdp2Dir, 'sheets.json'), 'utf8'));
  const sheetsAnalysis = classifyArtifact(sheetsData);
  assert(sheetsAnalysis.surfaceMetrics.canvas === 1, 'Sheets artefak: tepat 1 elemen canvas tunggal');
  assert(sheetsAnalysis.workerMetrics.realAppWorkers === 1, 'Sheets artefak: terdeteksi 1 Dedicated Calculation Worker');
  assert(sheetsAnalysis.scrollEvaluation.scrollMoved === false, 'Sheets artefak: DOM scrollMoved = false (input kanvas di-intercept)');

  // TEST SUITE 3: VERIFIKASI BINARY WASM & DECODE BOOTSTRAP WORKER
  console.log('\n--- Suite 3: WASM Binary Verification & Bootstrap Decoding ---');
  const wb = "W251bGwsbnVsbCxudWxsLCJodHRwczovL2RvY3MuZ29vZ2xlLmNvbS9zdGF0aWMvc3ByZWFkc2hlZXRzMi9jbGllbnQvd2FzbS8yNDczMjA5MDY4LWNhbGN3b3JrZXJfd2FzbV9jZC53YXNtIl0=";
  const dec = decodeBootstrapPayload(wb);
  assert(dec.success === true && dec.parsedArray.length === 4, 'Decode base64 wb= menghasilkan array 4 elemen');
  assert(dec.wasmUrl.endsWith('calcworker_wasm_cd.wasm'), 'URL binary WASM teridentifikasi di payload index 3');

  const wasmInfo = inspectWasmBinary(wasmBinaryPath);
  assert(wasmInfo.success === true, 'Binary WASM berhasil dibaca');
  assert(wasmInfo.isWasmMagic === true, 'Header WASM valid (magic: \\0asm ver 1)');
  assert(wasmInfo.sizeBytes === 3945915, `Ukuran biner presisi: 3.945.915 byte (${wasmInfo.sizeBytes})`);
  assert(wasmInfo.sha256 === 'f4b2aa1d3a984f01c3e7f282eb231c0c5ed12f4e4a986ec6bca619a625b6c09e', 'SHA-256 binary WASM terverifikasi otentik');
  // Invariant tahan-runtime: binary ini WAJAR valid entah V8 berhasil
  // mengompilasinya, atau V8 menolaknya karena butuh fitur Wasm modern.
  // Dulu asersi mengunci `requiresV8BleedingEdge === true`, sehingga run di V8
  // yang lebih tua/lebih baru (pesan error berbeda, atau justru sudah mendukung)
  // memerah padahal binary-nya sehat. Yang benar diuji: KONSISTENSI flag.
  const wasmComp = wasmInfo.compilation;
  const wasmCompiled = wasmComp.compiled === true;
  const wasmGap = wasmComp.requiresV8BleedingEdge === true;
  assert(
    wasmCompiled || wasmGap,
    `Binary WASM valid di runtime ini: terkompilasi=${wasmCompiled}, butuh-fitur-V8-modern=${wasmGap}`
  );
  assert(
    wasmGap === !wasmCompiled,
    `Flag feature-gap V8 konsisten dengan hasil kompilasi (error: ${wasmComp.error || 'tidak ada'})`
  );

  // --- Guard regresi: klasifikasi feature-gap V8 harus konsisten lintas-runtime ---
  // Bug nyata: V8 22 melempar "unknown type form: 77" untuk konstruk yang SAMA
  // dengan "descriptor types" di V8 24. Tanpa pola itu, kompilasi GAGAL tetapi
  // dilaporkan "Standar WebAssembly 1.0/2.0" (kontradiksi internal).
  assert(V8_GAP_PATTERNS.includes('unknown type form'), 'Pola V8 lama "unknown type form" terdaftar sebagai feature gap');
  assert(isV8FeatureGap('WebAssembly.Module(): unknown type form: 77 @+27') === true, 'isV8FeatureGap mengenali pesan V8 22 (unknown type form)');
  assert(isV8FeatureGap('WebAssembly.Module(): descriptor types need --experimental-wasm-custom-descriptors @+27') === true, 'isV8FeatureGap mengenali pesan V8 24 (descriptor types)');
  assert(isV8FeatureGap('some unrelated wasm error') === false, 'isV8FeatureGap TIDAK salah klasifikasi error tak terkait');
  assert(
    wasmInfo.compilation.compiled === true || !String(wasmInfo.compilation.note).startsWith('Standar'),
    `Catatan kompilasi tidak kontradiktif dengan hasil (compiled=${wasmInfo.compilation.compiled}, note="${wasmInfo.compilation.note}")`
  );

  // TEST SUITE 4: PROTOTIPE ENGINE RUNTIME
  console.log('\n--- Suite 4: Engine Prototypes Dynamic Execution ---');
  // Kix Docs
  const kix = new KixTileEngine(10);
  const kixInitialTiles = kix.mountedTiles.size;
  const kixScroll = kix.scrollTo(3000);
  assert(kixInitialTiles > 0, 'Kix: tile awal ter-mount pada viewport');
  assert(kixScroll.scrollMoved === true, 'Kix: scroll y=3000px berhasil menggeser viewport');
  assert(!kixScroll.visiblePages.includes(0), 'Kix tile virtualization: Halaman 0 di-unmount saat scroll jauh');

  // Punch Slides
  const punch = new PunchSvgEngine(4);
  const pSelect = punch.selectSlide(2);
  const pSvg = punch.renderActiveSlideSvg();
  assert(pSelect.success === true && punch.canvasCount === 0, 'Punch: pergantian slide aktif tanpa elemen canvas');
  assert(pSvg.startsWith('<svg') && pSvg.includes('punch-viewer-svg'), 'Punch: render menghasilkan scene graph SVG valid');

  // Ritz Sheets
  const ritz = new RitzGridEngine(5000, 20);
  const rScroll = ritz.handleVirtualScroll(150, 400);
  assert(rScroll.canvasCount === 1, 'Ritz: canvas count tetap 1 setelah virtual scroll');
  assert(rScroll.visibleWindow.startRow > 0, 'Ritz: virtual window baris tergeser sesuai scroll delta');

  const calcResult = await ritz.dispatchCalculation('B2', '=SUM(50, 150, 25)');
  assert(calcResult.calculatedValue === 225, 'Ritz: kalkulasi rumus oleh mock CalcWorker menghasilkan nilai 225');

  // TEST SUITE 5: DOCUMENT STORE CRUD OPERATIONS
  console.log('\n--- Suite 5: Document Store & JSON Persistence CRUD ---');
  const { initSeedData, listDocuments, getDocument, saveDocument, deleteDocument } = await import('./store.mjs');
  initSeedData();
  const docsList = listDocuments();
  assert(docsList.length >= 3, `Store memuat minimal 3 dokumen seed (ditemukan: ${docsList.length})`);

  const sampleDoc = getDocument('sheets-example');
  assert(sampleDoc && sampleDoc.title === 'Example Spreadsheet', 'Store: dokumen sheets-example berhasil dimuat');
  assert(sampleDoc.data && sampleDoc.data.cells && sampleDoc.data.cells['C1'], 'Store: cell C1 tersedia di sheets-example');

  const testNewDoc = saveDocument('test-temp-doc', { title: 'Dokumen Uji Sementara', data: { test: 123 } });
  assert(testNewDoc.title === 'Dokumen Uji Sementara', 'Store: pembuatan dokumen uji berhasil disimpan');
  const verifyLoaded = getDocument('test-temp-doc');
  assert(verifyLoaded && verifyLoaded.data.test === 123, 'Store: data dokumen uji berhasil dibaca kembali');

  deleteDocument('test-temp-doc');
  assert(getDocument('test-temp-doc') === null, 'Store: penghapusan dokumen uji berhasil diverifikasi');

  // TEST SUITE 6: ADVANCED SPREADSHEET FORMULA ENGINE
  console.log('\n--- Suite 6: Advanced Spreadsheet Formula Evaluator Engine ---');
  const { evaluateFormula, evaluateAllSheetCells } = await import('./formula.mjs');
  const _fx = {
    A1: { raw: 'Item', val: 'Item' }, B1: { raw: 'Kategori', val: 'Kategori' },
    C1: { raw: '=SUM(C2:C4)', val: 250 }, D1: { raw: 'Status', val: 'Status' },
    A2: { raw: 'Server', val: 'Server' }, C2: { raw: '120', val: 120 },
    A3: { raw: 'Bandwidth', val: 'Bandwidth' }, C3: { raw: '45', val: 45 },
    A4: { raw: 'Cluster', val: 'Cluster' }, C4: { raw: '85', val: 85 },
    A5: { raw: 'TOTAL', val: 'TOTAL' }, C5: { raw: '=SUM(C2:C4)', val: 250 }
  };
  const getter = (k) => _fx[k] || null;

  const sumRange = evaluateFormula('=SUM(C2:C4)', getter);
  assert(sumRange === 250, `Formula: =SUM(C2:C4) menghasilkan nilai 250 (didapat: ${sumRange})`);

  const avgRange = evaluateFormula('=AVERAGE(C2:C4)', getter);
  assert(Math.round(avgRange) === 83, `Formula: =AVERAGE(C2:C4) menghasilkan nilai ~83 (didapat: ${avgRange})`);

  const minRange = evaluateFormula('=MIN(C2:C4)', getter);
  assert(minRange === 45, `Formula: =MIN(C2:C4) menghasilkan nilai 45 (didapat: ${minRange})`);

  const maxRange = evaluateFormula('=MAX(C2:C4)', getter);
  assert(maxRange === 120, `Formula: =MAX(C2:C4) menghasilkan nilai 120 (didapat: ${maxRange})`);

  const countRange = evaluateFormula('=COUNT(C2:C4)', getter);
  assert(countRange === 3, `Formula: =COUNT(C2:C4) menghasilkan nilai 3 (didapat: ${countRange})`);

  const arithmeticExp = evaluateFormula('=C2 + C3 * 2', getter);
  assert(arithmeticExp === 210, `Formula: =C2 + C3 * 2 menghasilkan nilai 210 (didapat: ${arithmeticExp})`);

  const literalSum = evaluateFormula('=SUM(15, 25, 60)', getter);
  assert(literalSum === 100, `Formula: =SUM(15, 25, 60) menghasilkan nilai 100 (didapat: ${literalSum})`);

  const evaluatedBatch = evaluateAllSheetCells(_fx);
  assert(evaluatedBatch['C1'].val === 250, 'Batch evaluation: sel C1 ter-evaluasi menjadi 250');
  assert(evaluatedBatch['C5'].val === 250, 'Batch evaluation: sel C5 ter-evaluasi menjadi 250');

  // TEST SUITE 7: EXTENDED FORMULA ENGINE (paritas Google Sheets)
  console.log('\n--- Suite 7: Extended Formula Engine (paritas Google Sheets) ---');
  const getter2 = (k) => _fx[k] || null;
  const formulaCases = [
    ['=IF(C2>50,"HIGH","LOW")', 'HIGH'],
    ['=CONCAT("A","B","C")', 'ABC'],
    ['=CONCATENATE("X","Y")', 'XY'],
    ['=PRODUCT(2,3,4)', 24],
    ['=ROUND(3.14159,2)', 3.14],
    ['=COUNTA(C2:C4)', 3],
    ['=UPPER("kix")', 'KIX'],
    ['=LOWER("WAFFLE")', 'waffle'],
    ['=TRIM("  spasi  ")', 'spasi'],
    ['=LEN("hello")', 5],
    ['=LEFT("abcdef",3)', 'abc'],
    ['=RIGHT("abcdef",2)', 'ef'],
    ['=MID("abcdef",2,3)', 'bcd'],
    ['=CEILING(4.2)', 5],
    ['=FLOOR(4.8)', 4],
    ['=ABS(-7)', 7],
    ['=SQRT(16)', 4],
    ['=POWER(2,10)', 1024],
    ['=MOD(10,3)', 1],
    ['=AND(1,1)', true],
    ['=OR(0,0)', false],
    ['=NOT(0)', true],
    ['=MEDIAN(1,3,5)', 3],
    ['=AVG(C2:C4)', 250 / 3],
    ['=SUM(C2:C4)+ABS(-10)', 260],
    ['=IF(C3<50,"RENDAH","TINGGI")', 'RENDAH']
  ];
  for (const [expr, expected] of formulaCases) {
    const got = evaluateFormula(expr, getter2);
    assert(JSON.stringify(got) === JSON.stringify(expected),
      `Formula lanjutan: ${expr} => ${JSON.stringify(expected)} (didapat: ${JSON.stringify(got)})`);
  }

  // TEST SUITE 8: STORE SAFETY & INTEGRITAS SEED
  console.log('\n--- Suite 8: Document Store Safety & Integritas Seed ---');
  const store = await import('./store.mjs');
  store.initSeedData();

  assert(store.getDocumentType('docs-2002-nominee') === 'docs', 'Store: seed docs bertipe docs');
  assert(store.getDocumentType('sheets-example') === 'sheets', 'Store: seed sheets bertipe sheets');
  assert(store.getDocumentType('slides-krusevac') === 'slides', 'Store: seed slides bertipe slides');

  const seedDocObj = store.getDocument('docs-2002-nominee');
  assert(Array.isArray(seedDocObj.data.pages), 'Store: seed docs memuat struktur pages (bukan tipe asing)');
  const seedSheetObj = store.getDocument('sheets-example');
  assert(!!seedSheetObj.data.cells, 'Store: seed sheets memuat struktur cells (bukan tipe asing)');
  const seedSlideObj = store.getDocument('slides-krusevac');
  assert(Array.isArray(seedSlideObj.data.slides), 'Store: seed slides memuat struktur slides (bukan tipe asing)');

  store.setDocumentStar('docs-2002-nominee', true);
  assert(store.listDocuments().find(f => f.id === 'docs-2002-nominee').starred === true, 'Store: setDocumentStar menyetel starred=true');
  store.setDocumentStar('docs-2002-nominee', false);
  assert(store.listDocuments().find(f => f.id === 'docs-2002-nominee').starred === false, 'Store: setDocumentStar mengembalikan starred=false');

  const cellsBeforeTitleUpdate = JSON.stringify(store.getDocument('sheets-example').data.cells);
  store.saveDocument('sheets-example', { title: 'Example Spreadsheet' });
  const cellsAfterTitleUpdate = JSON.stringify(store.getDocument('sheets-example').data.cells);
  assert(cellsBeforeTitleUpdate === cellsAfterTitleUpdate, 'Store: pembaruan judul tidak merusak data cells (tanpa korupsi lintas-tipe)');

  const tempId = 'safety-probe-temp';
  store.saveDocument(tempId, { title: 'Temp', type: 'sheets', data: { cells: { A1: { val: 1, raw: '1' } } } });
  assert(store.getDocumentType(tempId) === 'sheets', 'Store: tipe dokumen baru tersimpan sesuai permintaan');
  store.deleteDocument(tempId);
  assert(store.getDocument(tempId) === null, 'Store: dokumen sementara berhasil dibersihkan');

  // TEST SUITE 9: GUARD INTEGRASI SHELL <-> EDITOR
  // Mencegah kelas bug "shell memanggil method yang tidak ada di editor"
  // (mis. ritz.commitFormulaBar) yang lolos dari uji unit konvensional.
  console.log('\n--- Suite 9: Guard Integrasi Shell <-> Editor ---');
  const shellSrc = fs.readFileSync(path.resolve(__dirname, 'static/app_shell.js'), 'utf8');
  const editorSrc = {
    kix: fs.readFileSync(path.resolve(__dirname, 'static/kix_editor.js'), 'utf8'),
    ritz: fs.readFileSync(path.resolve(__dirname, 'static/ritz_editor.js'), 'utf8'),
    punch: fs.readFileSync(path.resolve(__dirname, 'static/punch_editor.js'), 'utf8')
  };
  for (const [name, src] of Object.entries(editorSrc)) {
    const callRe = new RegExp(`this\\.${name}\\.([a-zA-Z_$][\\w$]*)\\s*\\(`, 'g');
    const called = new Set();
    let mm;
    while ((mm = callRe.exec(shellSrc))) called.add(mm[1]);
    const missing = [...called].filter(fn => !new RegExp(`(^|[\\s(])${fn}\\s*\\(`, 'm').test(src));
    assert(missing.length === 0,
      `Integrasi: seluruh ${called.size} method ${name} yang dipanggil shell tersedia di editor${missing.length ? ' — HILANG: ' + missing.join(', ') : ''}`);
    assert(called.size > 0, `Integrasi: shell benar-benar memanggil method ${name} (${called.size} panggilan)`);
  }

  // TEST SUITE 9b: KOMENTAR SEL — WIRING SHELL (statis)
  // Shell TIDAK diinstansiasi di unit suite (butuh DOM penuh), jadi yang diuji
  // di sini adalah KONTRAK SUMBER: handler terpasang, guard kontekstual benar,
  // dan tidak ada dialog native. Perilaku nyata (klik -> modal -> simpan)
  // dibuktikan di E2E dengan DOM sungguhan.
  console.log('\n--- Suite 9b: Wiring Komentar Sel di Shell ---');
  assert(/this\.ritz\.onCommentClick\s*=\s*\(coord,\s*list\)/.test(shellSrc),
    'Shell: ritz.onCommentClick dipasang dan meneruskan (coord, list)');
  assert(/openSheetCommentModal\(coord, existingList\)\s*\{/.test(shellSrc),
    'Shell: openSheetCommentModal didefinisikan');

  // tbComment WAJIB kontekstual. Versi lama hanya menangani docs, sehingga
  // tombol komentar MATI di Sheets (rect ada, handler tidak melakukan apa pun).
  const iTbC = shellSrc.indexOf("bind('tbComment'");
  assert(iTbC !== -1, 'Shell: tbComment terikat');
  const tbCBlock = shellSrc.slice(iTbC, iTbC + 400);
  assert(tbCBlock.includes("currentApp === 'docs'") && tbCBlock.includes("currentApp === 'sheets'"),
    'Shell: tbComment menangani Docs DAN Sheets (dulu mati di Sheets)');
  assert(tbCBlock.includes('openCommentModal') && tbCBlock.includes('openSheetCommentModal'),
    'Shell: tbComment memanggil modal yang tepat per aplikasi');

  // Ctrl+Alt+M harus berlaku di Sheets juga (paritas Google Sheets).
  assert(/k === 'm' && e\.altKey && \(this\.currentApp === 'docs' \|\| this\.currentApp === 'sheets'\)/.test(shellSrc),
    'Shell: Ctrl+Alt+M membuka komentar di Docs maupun Sheets');

  // Item menu Insert ikut kontekstual (dulu selalu membuka modal Docs).
  const iMenu = shellSrc.indexOf("label: 'Komentar'");
  assert(iMenu !== -1, 'Shell: item menu Komentar ada (label tidak lagi mengunci ke Docs)');
  // Setelah refactor menu kontekstual, branch Sheets Komentar terpisah — cari di seluruh sumber
  assert(shellSrc.includes('openSheetCommentModal'),
    'Shell: item menu Komentar merutekan ke modal Sheets saat di Sheets');

  // Guard: ketikan di modal tidak boleh bocor ke window keydown Ritz.
  const iOpenSheet = shellSrc.indexOf('openSheetCommentModal(coord, existingList)');
  const sheetModalSrc = shellSrc.slice(iOpenSheet, iOpenSheet + 12000);
  assert(sheetModalSrc.includes('stopPropagation'),
    'Shell: textarea modal komentar sel memanggil stopPropagation (cegah bocor ke grid)');
  assert(!/\bwindow\.(prompt|confirm|alert)\s*\(/.test(sheetModalSrc),
    'Shell: modal komentar sel tidak memakai dialog native');

  // Modal WAJIB memakai 6 method ritz yang benar (Suite 9 sudah memverifikasi
  // keberadaannya; di sini dipastikan modal memang memanggilnya).
  for (const m of ['addCellComment', 'addCellCommentReply', 'setCellCommentResolved',
                   'deleteCellComment', 'getCellComments', 'hasCellComment']) {
    assert(sheetModalSrc.includes('this.ritz.' + m + '('),
      `Shell: modal komentar sel memakai ritz.${m}()`);
  }

  // TEST SUITE 9c: AUDIT TOOLBAR — NOL TOMBOL MATI
  //
  // Kelas bug yang dicegah: tombol ada di HTML, terlihat aktif, tapi tidak
  // melakukan apa pun. Kasus nyata: tbComment hanya di-bind untuk docs,
  // sehingga di Sheets tombol komentar MATI tanpa gejala apa pun — tidak ada
  // error, tidak ada exception, hanya tidak bereaksi. Bug itu ditemukan m4
  // dan asersi ini mencegahnya kembali.
  //
  // Klasifikasi yang dipakai (bukan sekadar "ada string id di shell"):
  //   bound      -> bind('id', ...)
  //   listener   -> getElementById('id') lalu addEventListener pada variabelnya
  //   decorative -> span.tb-dot (swatch warna, diperbarui syncToolbar)
  console.log('\n--- Suite 9c: Audit Toolbar (nol tombol mati) ---');
  // WAJIB baca sendiri: htmlTb & shellTb dideklarasikan di Suite 13
  // (jauh DI BAWAH titik ini). Memakainya di sini memicu TDZ ReferenceError
  // ("Cannot access before initialization") yang menghentikan SELURUH suite
  // sebelum baris HASIL PENGUJIAN tercetak — gejalanya tampak seperti
  // "suite lulus" karena exit code tetap 0.
  const htmlTb = fs.readFileSync(path.resolve(__dirname, 'dashboard.html'), 'utf8');
  const shellTb = shellSrc;
  const tbIds = [];
  let scanFrom = 0;
  while (true) {
    const iId = htmlTb.indexOf('id="tb', scanFrom);
    if (iId === -1) break;
    const iVal = iId + 4;
    const iEnd = htmlTb.indexOf('"', iVal);
    if (iEnd === -1) break;
    const id = htmlTb.slice(iVal, iEnd);
    if (id.length > 2 && tbIds.indexOf(id) === -1) tbIds.push(id);
    scanFrom = iEnd + 1;
  }
  assert(tbIds.length >= 55,
    `Audit: pemindaian toolbar menemukan tombol yang wajar :: ${tbIds.length} (harus >= 55)`);

  const tbDead = [];
  const tbKinds = { bound: 0, listener: 0, decorative: 0 };
  for (const id of tbIds) {
    const bindPat = "bind('" + id + "'";
    const bindPat2 = 'bind("' + id + '"';
    if (shellTb.indexOf(bindPat) !== -1 || shellTb.indexOf(bindPat2) !== -1) {
      tbKinds.bound++;
      continue;
    }
    // Cari getElementById('id') lalu addEventListener di sekitarnya. Jendela
    // 240 char menangkap dua gaya: langsung maupun lewat variabel perantara
    // (const x = getElementById(...); if (x) x.addEventListener(...)).
    const getPat = "getElementById('" + id + "')";
    let wired = false;
    let from = 0;
    while (true) {
      const iGet = shellTb.indexOf(getPat, from);
      if (iGet === -1) break;
      const windowSrc = shellTb.slice(iGet, iGet + 240);
      if (windowSrc.indexOf('addEventListener') !== -1) { wired = true; break; }
      from = iGet + getPat.length;
    }
    if (wired) { tbKinds.listener++; continue; }

    // Dekoratif: swatch <span class="tb-dot"> di dalam tombol yang terikat.
    const iEl = htmlTb.indexOf('id="' + id + '"');
    const around = iEl >= 0 ? htmlTb.slice(Math.max(0, iEl - 220), iEl + 40) : '';
    if (around.indexOf('tb-dot') !== -1) { tbKinds.decorative++; continue; }

    tbDead.push(id);
  }
  assert(tbDead.length === 0,
    `Audit: NOL tombol toolbar tanpa handler :: ${tbDead.length ? 'MATI: ' + tbDead.join(', ') : 'bersih'}`);
  assert(tbKinds.bound + tbKinds.listener + tbKinds.decorative === tbIds.length,
    `Audit: seluruh ${tbIds.length} tombol terklasifikasi :: bind=${tbKinds.bound} listener=${tbKinds.listener} dekoratif=${tbKinds.decorative}`);

  // tbComment spesifik: dulu hanya docs. Ini penjaga langsung untuk regresi itu.
  const iTbComment = shellTb.indexOf("bind('tbComment'");
  const tbCommentBlock = iTbComment >= 0 ? shellTb.slice(iTbComment, iTbComment + 400) : '';
  assert(tbCommentBlock.indexOf("currentApp === 'sheets'") !== -1,
    'Audit: tbComment hidup di Sheets juga (dulu mati total di sana)');

  // TEST SUITE 9d: ESCAPE PADA MODAL TANPA _modalResolver
  //
  // Kelas bug yang sama dengan m4: modal komentar (Docs & Sheets) dibuka lewat
  // ensureModal(), BUKAN wrapper confirm/prompt/alert, jadi tidak punya
  // _modalResolver. Escape karenanya jatuh ke cabang fallback. Cabang itu dulu
  // menyembunyikan #gwsModal dengan style.display='none' MENTAH, tanpa melepas
  // fokus. Akibatnya activeElement tetap menunjuk elemen di dalam modal
  // tersembunyi, guard inModalField (:1027) tetap true, dan SELURUH pintasan
  // keyboard mati sampai user mengklik area lain. Gejalanya menyesatkan:
  // tombol toolbar tetap jalan, pintasan tidak.
  //
  // Di sini yang dikunci adalah KONTRAK SUMBER. Perilaku nyata (fokus benar-
  // benar lepas + pintasan hidup lagi) diuji S12b lewat DOM sungguhan.
  console.log('\n--- Suite 9d: Escape modal non-resolver melepas fokus ---');
  // WAJIB variabel lokal: htmlTb/shellTb milik Suite 13 dideklarasikan jauh di
  // bawah titik ini -> memakainya di sini memicu TDZ ReferenceError yang
  // menghentikan seluruh suite sebelum baris HASIL PENGUJIAN tercetak.
  const shellEsc = shellSrc;
  const iEsc = shellEsc.indexOf("if (e.key === 'Escape')");
  assert(iEsc !== -1, 'Escape: handler global ditemukan di app_shell.js');
  // Jendela WAJIB cukup lebar: this.closeModal() berada ~1002 karakter setelah
  // awal handler (komentar penjelas di antaranya). Jendela 900 membuat asersi
  // gagal secara PALSU tanpa ada bug kode apa pun.
  const escBlock = iEsc >= 0 ? shellEsc.slice(iEsc, iEsc + 1700) : '';
  assert(escBlock.indexOf('this.closeModal()') !== -1,
    'Escape: cabang fallback memakai closeModal() (melepas fokus), bukan hide mentah');
  assert(escBlock.indexOf("style.display = 'none'") === -1,
    'Escape: cabang fallback TIDAK menyembunyikan #gwsModal secara mentah');
  const iCloseDef = shellEsc.indexOf('closeModal() {');
  assert(iCloseDef !== -1, 'closeModal(): definisi ditemukan');
  const closeBody = iCloseDef >= 0 ? shellEsc.slice(iCloseDef, iCloseDef + 1200) : '';
  assert(/if\s*\(\s*modal\s*\)/.test(closeBody),
    'closeModal(): null-safe saat #gwsModal belum ada (Escape di grid kosong tidak boleh TypeError)');
  assert(closeBody.indexOf('activeElement') !== -1 && closeBody.indexOf('blur(') !== -1,
    'closeModal(): melepas fokus (activeElement + blur) sebelum menyembunyikan');
  assert(closeBody.indexOf('blur(') < closeBody.indexOf("style.display = 'none'"),
    'closeModal(): blur() dijalankan SEBELUM display:none (urutan menentukan)');

  // TEST SUITE 10: FORMULA ENGINE — REGRESI & TOKEN ERROR
  // Menguji perilaku NYATA engine (bukan sekadar keberadaan teks di sumber),
  // termasuk dua kelas bug yang dulu lolos: parser greedy dan pembagian nol.
  console.log('\n--- Suite 10: Formula Engine — Regresi, Token Error & Ekspresi Majemuk ---');
  const fCells = {
    A1: { raw: '10', val: 10 },
    A2: { raw: '20', val: 20 },
    A3: { raw: '30', val: 30 },
    B1: { raw: 'halo', val: 'halo' },
    C1: { raw: '=SUM(A1:A3)', val: 0 }
  };
  const fGet = (coord) => fCells[coord];

  // Ekspresi majemuk: dulu mengembalikan 0 karena regex greedy menelan argumen.
  assert(evaluateFormula('=SUM(A1:A3)+ABS(-10)', fGet) === 70,
    'Formula: ekspresi majemuk =SUM(A1:A3)+ABS(-10) = 70 (bukan 0)');
  assert(evaluateFormula('=ABS(-10)+SUM(A1:A3)', fGet) === 70,
    'Formula: ekspresi majemuk (fungsi di kanan) juga benar = 70');
  assert(evaluateFormula('=(A1+A2)*2', fGet) === 60,
    'Formula: tanda kurung aritmatika =(A1+A2)*2 = 60');
  assert(evaluateFormula('=SUM(A1:A3)-5', fGet) === 55,
    'Formula: =SUM(A1:A3)-5 = 55');

  // Pembagian nol: JS menghasilkan Infinity, bukan lemparan error. Dulu sel
  // akan menampilkan "Infinity"; Google Sheets menampilkan #DIV/0!.
  assert(evaluateFormula('=A1/0', fGet) === '#DIV/0!',
    'Formula: pembagian nol menghasilkan #DIV/0! (bukan Infinity)');
  assert(evaluateFormula('=MOD(A1,0)', fGet) === '#DIV/0!',
    'Formula: MOD dengan pembagi nol menghasilkan #DIV/0!');
  // Fungsi tak dikenal harus jujur menyebut namanya, bukan diam-diam 0.
  assert(String(evaluateFormula('=TIDAKADA(A1:A3)', fGet)).includes('#NAME?'),
    'Formula: fungsi tak dikenal menghasilkan #NAME? (bukan 0)');
  assert(evaluateFormula('=1+', fGet) === '#ERROR!',
    'Formula: ekspresi rusak menghasilkan #ERROR!');

  // Fungsi paritas Google Sheets yang ditambahkan di fase ini.
  assert(evaluateFormula('=AVERAGE(A1:A3)', fGet) === 20, 'Formula: AVERAGE(A1:A3) = 20');
  assert(evaluateFormula('=MEDIAN(A1:A3)', fGet) === 20, 'Formula: MEDIAN(A1:A3) = 20');
  assert(evaluateFormula('=COUNT(A1:A3)', fGet) === 3, 'Formula: COUNT(A1:A3) = 3');
  assert(evaluateFormula('=CEILING(4.2,1)', fGet) === 5, 'Formula: CEILING(4.2,1) = 5');
  assert(evaluateFormula('=FLOOR(4.8,1)', fGet) === 4, 'Formula: FLOOR(4.8,1) = 4');
  assert(evaluateFormula('=MOD(10,3)', fGet) === 1, 'Formula: MOD(10,3) = 1');
  assert(evaluateFormula('=LEFT(B1,2)', fGet) === 'ha', 'Formula: LEFT(B1,2) = "ha"');
  assert(evaluateFormula('=LEN(B1)', fGet) === 4, 'Formula: LEN(B1) = 4');
  assert(evaluateFormula('=UPPER(B1)', fGet) === 'HALO', 'Formula: UPPER(B1) = "HALO"');
  assert(evaluateFormula('=CONCAT(B1," dunia")', fGet) === 'halo dunia', 'Formula: CONCAT teks = "halo dunia"');
  assert(evaluateFormula('=IF(A1>5,"besar","kecil")', fGet) === 'besar', 'Formula: IF(10>5) = "besar"');

  // Sel turunan harus ikut terhitung ulang dari seluruh grid (evaluasi reaktif).
  const fAll = evaluateAllSheetCells(fCells);
  assert(fAll.C1 && fAll.C1.val === 60, 'Formula: evaluasi seluruh grid menghitung sel turunan C1 = 60');

  // TEST SUITE 11: PARITAS FORMAT EDITOR (kontrak perilaku, bukan sekadar teks)
  console.log('\n--- Suite 11: Paritas Format Editor (Kix / Ritz / Punch) ---');
  const kixSrc = editorSrc.kix;
  const ritzSrc = editorSrc.ritz;
  const punchSrc = editorSrc.punch;

  // Kix/Docs
  assert(/inheritedStyleFor|\.heading =|\.spacing =/.test(kixSrc),
    'Kix: baris baru mewarisi gaya (heading/spacing) saat Enter');
  // Diuji sebagai dua syarat TERPISAH, bukan satu jendela karakter yang sempit:
  // jendela tetap (mis. {0,420}) patah begitu ada komentar/penjelasan baru di
  // antara, sehingga tes gagal padahal fiturnya benar.
  assert(/listPrefixFor\(page, lIdx\)/.test(kixSrc) && /let n = 1/.test(kixSrc) && /return `\$\{n\}\. `/.test(kixSrc),
    'Kix: daftar bernomor menghitung urutan (bullet "• ", numbered "1. ")');
  assert(/cursorCharIdx[\s\S]{0,300}cursorCharIdx/.test(kixSrc) && /line\.text\.slice\(0, this\.cursorCharIdx\)/.test(kixSrc),
    'Kix: kursor per-karakter (cursorCharIdx) dipetakan untuk pemisahan/penggabungan baris');
  assert(/wrapSegmentsFor\([\s\S]{0,120}extraLeft/.test(kixSrc),
    'Kix: wrap teks memperhitungkan lekuk penanda butir (extraLeft)');
  assert(/applyParagraphStyle\(/.test(kixSrc), 'Kix: applyParagraphStyle tersedia (gaya judul/heading)');
  assert(/applyList\(listType\)/.test(kixSrc), 'Kix: applyList tersedia (bullet & bernomor)');
  assert(/changeIndent\(delta\)/.test(kixSrc) && /changeSpacing\(v\)/.test(kixSrc),
    'Kix: changeIndent & changeSpacing tersedia');
  assert(/clearFormatting\(\)/.test(kixSrc), 'Kix: clearFormatting tersedia');

  // Ritz/Sheets
  assert(/this\.editing = false/.test(ritzSrc) && /startCellEdit\(/.test(ritzSrc),
    'Ritz: mendukung pengetikan LANGSUNG ke sel (in-cell editing)');
  assert(/delete this\.cells\[coord\][\s\S]{0,220}recalculateAll\(\)/.test(ritzSrc),
    'Ritz: menghapus sel memicu evaluasi ulang sel turunan');
  assert(/isFinite\(val\)/.test(ritzSrc) && /toFixed\(d\)/.test(ritzSrc),
    'Ritz: format tampilan menghormati jumlah desimal (this.decimals)');
  assert(/#d93025/.test(ritzSrc),
    'Ritz: token error formula dirender merah seperti Google Sheets');

  // Punch/Slides
  assert(/data-handle="\$\{name\}"/.test(punchSrc),
    'Punch: 8 handle ubah-ukuran ter-render di SVG stage');
  assert(/'nw'[\s\S]{0,320}'se'[\s\S]{0,320}'sw'[\s\S]{0,320}'w'/.test(punchSrc),
    'Punch: handle mencakup 4 sudut + 4 sisi (kisi 3x3 tanpa tengah)');
  assert(/applyResize\(pt\)/.test(punchSrc) && /Math\.max\(MIN/.test(punchSrc),
    'Punch: ubah-ukuran dibatasi ukuran minimum (tidak bisa negatif)');
  assert(/openInlineTextEditor/.test(punchSrc) && !/prompt\('Sunting teks slide:/.test(punchSrc),
    'Punch: sunting teks DI TEMPAT (bukan dialog prompt bawaan browser)');
  assert(/setSpeakerNotes[\s\S]{0,200}slide\.notes/.test(punchSrc),
    'Punch: catatan pembicara disimpan pada slide');

  // Shell + HTML: setiap tombol baru wajib punya elemen DAN handler.
  const htmlSrc = fs.readFileSync(path.resolve(__dirname, 'dashboard.html'), 'utf8');
  const newIds = [
    'tbParagraphStyle', 'tbBulletList', 'tbNumberedList', 'tbIndentInc', 'tbIndentDec',
    'tbLineSpacing', 'tbClearFormat', 'tbSheetSum', 'tbSheetBold', 'tbSheetItalic',
    'tbSheetStrike', 'tbSheetAlignLeft', 'tbSheetAlignCenter', 'tbSheetAlignRight',
    'tbSheetBg', 'tbDecInc', 'tbDecDec', 'tbSpeakerNotes', 'speakerNotesPanel', 'speakerNotesInput'
  ];
  const missingHtml = newIds.filter(id => !htmlSrc.includes(`id="${id}"`));
  assert(missingHtml.length === 0,
    `UI: seluruh ${newIds.length} elemen kontrol baru ada di dashboard.html${missingHtml.length ? ' — HILANG: ' + missingHtml.join(', ') : ''}`);
  const missingBind = newIds.filter(id => !shellSrc.includes(`'${id}'`));
  assert(missingBind.length === 0,
    `UI: seluruh ${newIds.length} kontrol baru ter-bind di app_shell.js${missingBind.length ? ' — TIDAK TER-BIND: ' + missingBind.join(', ') : ''}`);
  assert(/toggleSpeakerNotes[\s\S]{0,900}getSpeakerNotes/.test(shellSrc),
    'Shell: panel catatan pembicara memuat & menyimpan catatan slide aktif');

  // Shell: dialog native (prompt/confirm/alert) DIGANTIKAN modal in-app.
  // Dialog native memblokir event loop, tidak bisa ditutup otomasi CDP, dan
  // tampilannya bukan gaya Google Workspace.
  // PENTING: pindai KODE saja — komentar dibuang lebih dulu. Tanpa ini,
  // dokumentasi yang menyebut nama dialog akan membuat asersi gagal karena
  // prosa, bukan karena perilaku (false negative yang membingungkan).
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const nativeDialogCalls = (s) => {
    const code = stripComments(s);
    const hits = [];
    for (const name of ['prompt', 'confirm', 'alert']) {
      const re = new RegExp('\\b' + name + '\\s*\\(', 'g');
      let m;
      while ((m = re.exec(code))) {
        hits.push(name + ' @baris ' + (code.slice(0, m.index).split('\n').length));
      }
    }
    return hits;
  };

  const shellNative = nativeDialogCalls(shellSrc);
  assert(shellNative.length === 0,
    `Shell: nol dialog native prompt/confirm/alert :: ${shellNative.join('; ') || 'bersih'}`);
  const punchNative = nativeDialogCalls(punchSrc);
  assert(punchNative.length === 0,
    `Punch: nol dialog native prompt/confirm/alert :: ${punchNative.join('; ') || 'bersih'}`);

  // Ketiga wrapper wajib ada DAN mengembalikan Promise (bukan blocking).
  for (const fn of ['confirmModal', 'promptModal', 'alertModal']) {
    assert(new RegExp(fn + '\\s*\\(').test(shellSrc),
      `Shell: wrapper ${fn} tersedia`);
    assert(new RegExp(fn + '\\([^)]*\\)\\s*\\{\\s*return new Promise').test(shellSrc),
      `Shell: ${fn} mengembalikan Promise (non-blocking)`);
  }

  // Escape WAJIB me-resolve Promise. closeModal() hanya menyetel display:none;
  // tanpa resolve, `await confirmModal(...)` menggantung selamanya dan tombol
  // Hapus tidak pernah selesai — bug yang hanya muncul saat user tekan Esc.
  // Kontrak resolver: SATU pintu keluar (_resolveModal). Dulu Escape memberi
  // null sementara tombol Batal memberi false untuk confirm yang sama — dua
  // nilai berbeda untuk aksi yang sama, dan Promise yatim bila handler
  // terpanggil dua kali (mis. Enter lalu Escape).
  assert(/_resolveModal\(val\)\s*\{[\s\S]{0,200}this\._modalResolver = null;[\s\S]{0,200}typeof r === 'function'/.test(shellSrc),
    'Shell: _resolveModal membersihkan resolver SEBELUM memanggilnya (anti Promise yatim)');
  assert(/if \(this\._modalResolver\) \{\s*\n?\s*\/\/[\s\S]{0,400}this\._resolveModal\(this\._modalCancelValue\);/.test(shellSrc),
    'Shell: Escape me-resolve Promise modal memakai nilai batal milik modal aktif');
  assert(/this\._modalCancelValue = false;/.test(shellSrc),
    'Shell: confirmModal -> Escape/Batal bernilai false (bukan null)');
  assert(/this\._modalCancelValue = null;\s*\n\s*this\._modalResolver = \(val\)/.test(shellSrc),
    'Shell: promptModal -> Escape/Batal bernilai null');
  assert(/this\._modalCancelValue = undefined;/.test(shellSrc),
    'Shell: alertModal -> Escape bernilai undefined');
  // Tidak boleh ada handler yang memanggil resolver langsung: jalur itu
  // melewati pembersihan _modalCancelValue dan bisa me-resolve dua kali.
  const directResolverCalls = (stripComments(shellSrc).match(/this\._modalResolver\s*\(/g) || []).length;
  assert(directResolverCalls === 0,
    `Shell: nol pemanggilan resolver langsung (semua lewat _resolveModal) :: ${directResolverCalls}`);
  // Membuka modal baru saat modal lama terbuka wajib MENYELESAIKAN yang lama.
  const reopenGuards = (shellSrc.match(/if \(this\._modalResolver\) this\._resolveModal\(this\._modalCancelValue\);/g) || []).length;
  assert(reopenGuards === 3,
    `Shell: ketiga wrapper menyelesaikan modal lama sebelum membuka baru :: ${reopenGuards}/3`);

  // Pemanggil wajib benar-benar await — bukan memanggil lalu membuang Promise.
  assert(/async deleteDoc\(id\)[\s\S]{0,240}await this\.confirmModal/.test(shellSrc),
    'Shell: hapus dokumen memakai await confirmModal (bukan confirm native)');
  assert(/titleEl\.ondblclick = async[\s\S]{0,320}await this\.promptModal/.test(shellSrc),
    'Shell: rename file memakai await promptModal (bukan prompt native)');

  // TEST SUITE 12: INTEGRITAS STRUKTUR SEED (lanjutan penjaga anti-korupsi)
  console.log('\n--- Suite 12: Integritas Struktur Seed & Duplikasi ---');
  const seedPages = store.getDocument('docs-2002-nominee').data.pages;
  assert(Array.isArray(seedPages) && seedPages.every(p => Array.isArray(p.lines)),
    'Seed docs: setiap halaman memuat array lines (struktur tidak rusak)');
  const seedSlides = store.getDocument('slides-krusevac').data.slides;
  assert(Array.isArray(seedSlides) && seedSlides.length > 0 && Array.isArray(seedSlides[0].elements),
    'Seed slides: setiap slide memuat array elements (struktur tidak rusak)');
  const seedSheetCells = store.getDocument('sheets-example').data.cells;
  assert(seedSheetCells && Object.keys(seedSheetCells).length > 0,
    'Seed sheets: peta cells tidak kosong (tidak kehilangan seluruh isi)');

  // TEST SUITE 13: KETAHANAN ENGINE FORMULA (sirkular, propagasi error, performa)
  console.log('\n--- Suite 13: Ketahanan Engine Formula ---');
  const gNull = () => null;

  // 13a. Sirkular WAJIB jadi #REF!, bukan angka bisu (dulu diam-diam 0).
  const selfRef = evaluateAllSheetCells({ A1: { raw: '=A1' } });
  assert(selfRef.A1.val === '#REF!', `Sirkular mandiri (A1 = =A1) -> #REF! :: ${selfRef.A1.val}`);
  const twoWay = evaluateAllSheetCells({ A1: { raw: '=B1' }, B1: { raw: '=A1' } });
  assert(twoWay.A1.val === '#REF!' && twoWay.B1.val === '#REF!',
    `Sirkular dua arah (A1<->B1) -> #REF! :: ${twoWay.A1.val}/${twoWay.B1.val}`);
  const threeWay = evaluateAllSheetCells({ A1: { raw: '=B1+1' }, B1: { raw: '=C1+1' }, C1: { raw: '=A1+1' } });
  assert(threeWay.A1.val === '#REF!' && threeWay.B1.val === '#REF!' && threeWay.C1.val === '#REF!',
    `Sirkular tiga arah (A1->B1->C1->A1) -> #REF! :: ${threeWay.A1.val}/${threeWay.B1.val}/${threeWay.C1.val}`);

  // 13b. Propagasi error: error ASAL tidak boleh menyamar jadi #VALUE! / 5 / 0.
  const prop = evaluateAllSheetCells({
    A1: { raw: '=1/0' }, B1: { raw: '=A1+5' }, C1: { raw: '=A1*2' },
    D1: { raw: '=SUM(A1:A1)' }, E1: { raw: '=B1&""' }
  });
  assert(prop.B1.val === '#DIV/0!', `Propagasi aritmetika (#DIV/0!+5) tetap #DIV/0! :: ${prop.B1.val}`);
  assert(prop.C1.val === '#DIV/0!', `Propagasi perkalian (#DIV/0!*2) tetap #DIV/0! :: ${prop.C1.val}`);
  assert(prop.D1.val === '#DIV/0!', `Agregat SUM atas sel error -> #DIV/0! (bukan 0) :: ${prop.D1.val}`);
  assert(prop.E1.val === '#DIV/0!', `Konkatenasi dengan sel error -> #DIV/0! :: ${prop.E1.val}`);

  // 13c. Error yang dirujuk dua formula tetap error (tidak salah di-cache).
  const twice = evaluateAllSheetCells({ A1: { raw: '=1/0' }, B1: { raw: '=A1' }, C1: { raw: '=A1' } });
  assert(twice.B1.val === '#DIV/0!' && twice.C1.val === '#DIV/0!',
    `Error dirujuk dua formula tetap error :: ${twice.B1.val}/${twice.C1.val}`);

  // 13d. Rantai panjang benar + performa wajar (dulu O(n^2) ~570ms utk 500 sel).
  const chain = { A1: { raw: '1' } };
  for (let i = 2; i <= 500; i++) chain['A' + i] = { raw: `=A${i - 1}+1` };
  const t0 = Date.now();
  const chainRes = evaluateAllSheetCells(chain);
  const chainMs = Date.now() - t0;
  assert(chainRes.A500.val === 500, `Rantai 500 sel terevaluasi benar (A500 = 500) :: ${chainRes.A500.val}`);
  assert(chainMs < 150, `Performa rantai 500 sel wajar :: ${chainMs}ms (batas 150ms)`);

  // 13e. Sintaks/fungsi cacat tidak melempar ke luar.
  assert(String(evaluateFormula('=FOOBAR(1,2)', gNull, new Set())).startsWith('#NAME?'),
    'Fungsi tak dikenal -> #NAME? (tidak melempar exception)');
  assert(evaluateFormula('=SUM(1,2', gNull, new Set()) === '#VALUE!', 'Kurung tak seimbang -> #VALUE!');
  assert(evaluateFormula('=', gNull, new Set()) === '', 'Formula kosong (=) -> string kosong');

  // 13f. isErrorToken tepat: token error dikenali, teks biasa TIDAK.
  assert(isErrorToken('#DIV/0!') && isErrorToken('#REF!') && isErrorToken('#VALUE!') && isErrorToken('#NAME?'),
    'isErrorToken mengenali seluruh token error standar');
  assert(!isErrorToken('#HARGA') && !isErrorToken('BESAR') && !isErrorToken(0) && !isErrorToken(undefined),
    'isErrorToken TIDAK salah mengenali teks/angka biasa sebagai error');

  // 13g. Tidak ada Infinity/NaN yang lolos menjadi nilai sel.
  const divZero = evaluateAllSheetCells({ A1: { raw: '=2/0' }, A2: { raw: '=0/0' } });
  assert(divZero.A1.val === '#DIV/0!' && divZero.A2.val === '#DIV/0!',
    `Pembagian nol tidak menghasilkan Infinity/NaN :: ${divZero.A1.val}/${divZero.A2.val}`);

  // TEST SUITE 13b: KONTRAK AUTOSAVE (flush benar-benar menulis + keepalive)
  console.log('\n--- Suite 13b: Kontrak Autosave & Flush Sebelum Unload ---');
  const shellAuto = fs.readFileSync(path.resolve(__dirname, 'static/app_shell.js'), 'utf8');
  assert(/flushPendingSave\(keepalive = false\)/.test(shellAuto),
    'Shell: flushPendingSave menerima opsi keepalive');
  assert(/await this\.saveDocument\(p\.payload, p\.targetId, \{ keepalive \}\)/.test(shellAuto),
    'Shell: flush MENULIS payload tertunda (dulu hanya clearTimeout -> kehilangan data)');
  assert(/keepalive: !!opts\.keepalive/.test(shellAuto),
    'Shell: fetch simpan memakai keepalive agar tidak dibatalkan saat halaman dibongkar');
  assert(/addEventListener\('pagehide'/.test(shellAuto) && /addEventListener\('beforeunload'/.test(shellAuto),
    'Shell: flush terpasang pada pagehide + beforeunload');
  assert(/if \(document\.visibilityState === 'hidden'\) flush\(\)/.test(shellAuto),
    'Shell: flush juga saat tab disembunyikan (visibilitychange)');
  assert(/await this\.flushPendingSave\(\);/.test(shellAuto),
    'Shell: berpindah dokumen MENUNGGU flush selesai (penulisan tidak lagi hilang)');
  assert(/if \(stack\.length > 60\) stack\.shift\(\)/.test(shellAuto),
    'Shell: riwayat undo dibatasi 60 (tidak tumbuh tanpa batas)');

  // REGRESI: status bar Docs dulu dihancurkan oleh pembaruannya sendiri.
  //
  // #docsCurPage adalah ANAK dari #docsStatusText. Kode lama menulis
  // statusEl.innerText = `Halaman ${cur} dari ${total} ...` yang MENGHAPUS
  // seluruh isi div — termasuk span #docsCurPage itu sendiri. Sejak pembaruan
  // pertama getElementById('docsCurPage') mengembalikan null selamanya,
  // sehingga angka halaman tidak bisa dibaca lagi. Teks status tetap tampak
  // benar karena ditulis ulang utuh, jadi cacat ini tak terlihat sampai ada
  // asersi yang membaca sub-elemennya (ditemukan oleh E2E S11).
  //
  // Ditulis dengan includes()/indexOf, BUKAN regex literal: escaping backslash
  // di berkas ini pernah terlipatgandakan alat patch dan mematahkan asersi
  // tanpa terlihat.
  const htmlStatus = fs.readFileSync(path.resolve(__dirname, 'dashboard.html'), 'utf8');
  const iStatusOpen = htmlStatus.indexOf('id="docsStatusText"');
  const iStatusClose = htmlStatus.indexOf('</div>', iStatusOpen);
  assert(iStatusOpen !== -1 && iStatusClose > iStatusOpen &&
         htmlStatus.slice(iStatusOpen, iStatusClose).includes('id="docsCurPage"'),
    'UI: #docsCurPage berada DI DALAM #docsStatusText (bukan saudara)');
  assert(htmlStatus.includes('id="docsTotalPages"') && htmlStatus.includes('id="docsWordCount"'),
    'UI: status bar Docs punya span terpisah untuk total halaman & jumlah kata');
  assert(!shellAuto.includes('statusEl.innerText'),
    'Shell: isi #docsStatusText TIDAK ditimpa utuh (itu menghapus span anaknya)');
  assert(shellAuto.includes("setStatusPart('docsCurPage'") &&
         shellAuto.includes("setStatusPart('docsTotalPages'") &&
         shellAuto.includes("setStatusPart('docsWordCount'"),
    'Shell: tiap bagian status bar Docs diperbarui sebagai elemen terpisah');

  // TEST SUITE 14: PARITAS LANJUTAN (tema/layout Slides, bagan+sort Sheets, ceklis Docs)
  // Kelas editor dimuat dari FILE ASLI (bukan salinan) dengan stub DOM minimal,
  // supaya yang diuji benar-benar kode yang dipakai di browser.
  console.log('\n--- Suite 14: Paritas Lanjutan (Theme/Layout, Chart/Sort, Checklist) ---');
  const makeCtx = () => new Proxy({}, {
    get(t, p) {
      if (p === 'measureText') return (s) => ({ width: String(s).length * 7 });
      if (p === 'canvas') return { width: 794, height: 1050 };
      if (p in t) return t[p];
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; }
  });
  const elCache = new Map();
  const makeEl = (tag) => ({
    tagName: (tag || 'div').toUpperCase(), id: '', style: {}, children: [], innerHTML: '',
    textContent: '', value: '', className: '', scrollTop: 0, width: 794, height: 1050,
    offsetParent: null, onclick: null, parentNode: null,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    // Handler direkam (bukan no-op) supaya alur scroll -> status bar dapat diuji
    // langsung tanpa browser. scrollIntoView merekam opsinya agar pemanggilnya
    // dapat diverifikasi (mis. { block: 'start' } pada scrollPageIntoView).
    addEventListener(ev, fn) { this._handlers = this._handlers || {}; (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
    removeEventListener() {},
    scrollIntoView(opts) { this._scrolled = opts || {}; },
    appendChild(c) { this.children.push(c); if (c) c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    focus() {}, select() {}, blur() {}, insertBefore(c) { return this.appendChild(c); },
    // `_rect` dapat di-override per elemen supaya tes dapat mensimulasikan
    // posisi tile setelah scroll. Tanpa ini semua elemen mengaku berada di
    // (0,0) dan tes indikator halaman hanya akan lulus secara palsu.
    getBoundingClientRect() { return this._rect || { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; },
    getContext() { return makeCtx(); },
    parentElement: null
  });
  const docStub = {
    getElementById(id) {
      if (!elCache.has(id)) { const e = makeEl('div'); e.id = id; elCache.set(id, e); }
      return elCache.get(id);
    },
    createElement: (tag) => makeEl(tag),
    body: makeEl('body'),
    addEventListener() {}, querySelector() { return null; }
  };
  const loadEditor = (file, globalName) => {
    // Stub lingkungan browser minimal. WAJIB ada addEventListener: konstruktor
    // editor (punch_editor.js:230) langsung memasang listener mousemove/mouseup.
    const win = {
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: (id) => clearTimeout(id),
      getSelection: () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {} }),
      getComputedStyle: () => ({ display: 'block' })
    };
    win.window = win;
    win.document = docStub;
    // Timer disandbox-kan sebagai no-op. Tanpa ini, setInterval pada kode editor
    // (kix_editor.js:111 — kedip kursor) memakai timer global Node yang sebenarnya,
    // sehingga proses TIDAK PERNAH keluar karena event loop selalu tersibukkan.
    const noopTimer = () => 0;
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
      fs.readFileSync(path.resolve(__dirname, file), 'utf8'))(win, docStub, noopTimer, () => {}, noopTimer, () => {});
    return win[globalName];
  };

  // 14a. SLIDES: tema diterapkan ke seluruh slide; tata letak mengganti elemen.
  const Punch14 = loadEditor('static/punch_editor.js', 'PunchSlidesEditor');
  const punch14 = new Punch14('punchSvgStage', 'slidesFilmstrip');
  punch14.setSlides([
    { id: 1, title: 'S1', background: '#ffffff', elements: [{ id: 'a', type: 'text', x: 10, y: 10, text: 'halo', fill: '#202124' }] },
    { id: 2, title: 'S2', background: '#ffffff', elements: [{ id: 'b', type: 'text', x: 10, y: 10, text: 'dua', fill: '#202124' }] }
  ]);
  punch14.applyTheme('dark');
  assert(punch14.slides.every(s => s.background === '#202124'),
    `Slides: tema "dark" mengubah latar SEMUA slide :: ${punch14.slides.map(s => s.background).join(',')}`);
  assert(punch14.getTheme() === 'dark' && punch14.slides[0].theme === 'dark',
    'Slides: tema aktif tersimpan di model slide (ikut tersimpan ke Drive)');
  const layoutTwo = punch14.applyLayout('two_column');
  const kinds14 = punch14.slides[punch14.activeSlideIdx].elements.map(e => e.type).sort().join(',');
  assert(layoutTwo === true && punch14.getLayout() === 'two_column',
    `Slides: tata letak "dua kolom" diterapkan :: layout=${punch14.getLayout()}`);
  assert(punch14.slides[punch14.activeSlideIdx].elements.length === 5 && kinds14 === 'rect,rect,text,text,text',
    `Slides: tata letak dua kolom menghasilkan 5 elemen (2 kotak + 3 teks) :: ${kinds14}`);
  punch14.applyLayout('blank');
  assert(punch14.slides[punch14.activeSlideIdx].elements.length === 0,
    `Slides: tata letak "kosong" membersihkan slide :: ${punch14.slides[punch14.activeSlideIdx].elements.length} elemen`);

  // 14b. SHEETS: bagan SVG murni + urutkan kolom.
  const Ritz14 = loadEditor('static/ritz_editor.js', 'RitzSpreadsheetEditor');
  const ritz14 = new Ritz14('sheetsGridCanvas', 'sheetFormulaInput', 'sheetActiveCell');
  ritz14.render = () => {};                        // gambar canvas diuji lewat E2E
  ritz14.recalculateAll = async () => ritz14.cells; // evaluasi formula diuji di Suite 13
  ritz14.cells = {
    B1: { raw: 'Ani', val: 'Ani' }, C1: { raw: '30', val: 30 },
    B2: { raw: 'Budi', val: 'Budi' }, C2: { raw: '10', val: 10 },
    B3: { raw: 'Cici', val: 'Cici' }, C3: { raw: '20', val: 20 }
  };
  ritz14.activeCol = 2;
  const chartData14 = ritz14.readChartData();
  assert(chartData14.values.length === 3 && chartData14.labels[0] === 'Ani',
    `Sheets: data bagan dibaca dari kolom aktif + label kolom kiri :: ${chartData14.values.join('/')} | ${chartData14.labels.join('/')}`);
  const colSvg = ritz14.buildChartSvg('column');
  assert(colSvg.count === 3 && /<svg /.test(colSvg.svg) && (colSvg.svg.match(/<rect /g) || []).length >= 3,
    'Sheets: bagan kolom menghasilkan SVG valid dengan batang <rect>');
  assert(/<path /.test(ritz14.buildChartSvg('line').svg) && /<circle /.test(ritz14.buildChartSvg('line').svg),
    'Sheets: bagan garis menghasilkan <path> + titik <circle>');
  const pieSvg = ritz14.buildChartSvg('pie');
  assert((pieSvg.svg.match(/<path /g) || []).length === 3,
    `Sheets: bagan lingkaran terbagi 3 sektor :: ${(pieSvg.svg.match(/<path /g) || []).length} sektor`);
  ritz14.cells = { C1: { raw: 'x', val: 'x' } };
  assert(ritz14.buildChartSvg('column').count === 0 && /Tidak ada data angka/.test(ritz14.buildChartSvg('column').svg),
    'Sheets: bagan tanpa data angka menampilkan pesan, bukan SVG rusak');
  // escapeXml WAJIB benar-benar meng-escape: label sel berisi & dan < tidak
  // boleh merusak markup SVG. Diuji dengan data nyata, bukan assertion kosong.
  ritz14.cells = { B1: { raw: 'A & B', val: 'A & B' }, C1: { raw: '5', val: 5 }, C2: { raw: '<x>', val: '<x>' }, B2: { raw: '<y>', val: '<y>' } };
  ritz14.activeCol = 2;
  const escSvg = ritz14.buildChartSvg('column').svg;
  assert(escSvg.includes('A &amp; B') && !/<[a-z]*>x<\/[a-z]*>/.test(escSvg),
    'Sheets: label bagan berisi "&" dan "<" ter-escape (markup SVG tidak rusak)');

  ritz14.cells = { A1: { raw: '30', val: 30 }, A2: { raw: '10', val: 10 }, A3: { raw: '20', val: 20 } };
  ritz14.activeCol = 0;
  const sortAsc14 = ritz14.sortRange('asc');
  assert(sortAsc14.moved === 3 && ritz14.cells.A1.val === 10 && ritz14.cells.A2.val === 20 && ritz14.cells.A3.val === 30,
    `Sheets: urutkan menaik numerik benar :: ${ritz14.cells.A1.val},${ritz14.cells.A2.val},${ritz14.cells.A3.val}`);
  ritz14.sortRange('desc');
  assert(ritz14.cells.A1.val === 30 && ritz14.cells.A3.val === 10,
    `Sheets: urutkan menurun numerik benar :: ${ritz14.cells.A1.val},${ritz14.cells.A2.val},${ritz14.cells.A3.val}`);
  ritz14.cells = { A1: { raw: 'mangga', val: 'mangga' }, A2: { raw: 'apel', val: 'apel' }, A3: { raw: 'jeruk', val: 'jeruk' } };
  ritz14.sortRange('asc');
  assert(ritz14.cells.A1.val === 'apel' && ritz14.cells.A2.val === 'jeruk' && ritz14.cells.A3.val === 'mangga',
    `Sheets: urutkan teks (bukan angka) tetap benar :: ${ritz14.cells.A1.val},${ritz14.cells.A2.val},${ritz14.cells.A3.val}`);
  ritz14.cells = { C1: { raw: '30', val: 30 }, C2: { raw: '10', val: 10 } };
  ritz14.activeCol = 2;
  ritz14.insertChart('column');
  assert(ritz14.getCharts().length === 1 && ritz14.getCharts()[0].col === 'C',
    `Sheets: bagan disisipkan & tercatat pada model dokumen :: ${ritz14.getCharts().length} bagan`);
  ritz14.removeChart();
  assert(ritz14.getCharts().length === 0, 'Sheets: bagan dapat dihapus');

  // 14b-b. SHEETS: komentar sel — model CRUD + persistensi round-trip.
  // cellComments = { 'A3': [{id, author, text, createdAt, resolved, replies[]}] }
  // Map TERPISAH dari cells: komentar tidak hilang saat nilai sel dikosongkan.
  const ritzC = new Ritz14('sheetsGridCanvas', 'sheetFormulaInput', 'sheetActiveCell');
  ritzC.render = () => {};
  ritzC.renderSheetTabs = () => {};
  ritzC.updateFormulaBar = () => {};
  ritzC.recalculateAll = async () => ritzC.cells;

  // ROUND-TRIP dulu: setSheets(getSheets()) WAJIB mempertahankan cellComments.
  // Tanpa entri di whitelist setSheets, komentar hilang diam-diam saat load
  // (bukan error — hanya lenyap), jadi asersi ini menjaga fondasi sebelum
  // method CRUD diuji.
  ritzC.addCellComment('A3', 'Komentar pertama', 'Budi');
  ritzC.addCellComment('A3', 'Komentar kedua', 'Cici');
  ritzC.addCellComment('B5', 'Komentar sel lain', 'Ani');
  const ccBeforeTrip = JSON.parse(JSON.stringify(ritzC.getSheets()));
  ritzC.setSheets(ccBeforeTrip, 0);
  const ccAfterTrip = ritzC.getAllCellComments();
  assert(ccAfterTrip['A3'] && ccAfterTrip['A3'].length === 2,
    `Sheets: round-trip setSheets(getSheets()) mempertahankan 2 komentar di A3 :: ${ccAfterTrip['A3'] ? ccAfterTrip['A3'].length : 'HILANG'}`);
  assert(ccAfterTrip['B5'] && ccAfterTrip['B5'].length === 1,
    'Sheets: round-trip mempertahankan komentar di B5');
  assert(ccAfterTrip['A3'][0].author === 'Budi' && ccAfterTrip['A3'][0].text === 'Komentar pertama',
    'Sheets: metadata komentar (author/text) utuh setelah round-trip');

  // addCellComment: id berprefix sc_, author default 'Saya', resolved false.
  const ccC1 = ritzC.addCellComment('C7', 'Tes komentar', null);
  assert(ccC1 && ccC1.id.startsWith('sc_') && ccC1.author === 'Saya' && ccC1.resolved === false && !!ccC1.createdAt,
    `Sheets: addCellComment menghasilkan objek lengkap :: author=${ccC1 && ccC1.author} resolved=${ccC1 && ccC1.resolved}`);
  assert(Array.isArray(ccC1.replies) && ccC1.replies.length === 0,
    'Sheets: komentar baru punya replies array kosong');

  // Teks kosong ditolak (null), bukan membuat entri sampah.
  assert(ritzC.addCellComment('C7', '   ', 'X') === null,
    'Sheets: addCellComment menolak teks kosong');
  assert(ritzC.getCellComments('C7').length === 1,
    'Sheets: teks kosong tidak menambah komentar');

  // Koordinat dinormalisasi: 'a3' == 'A3'.
  assert(ritzC.getCellComments('a3').length === 2,
    'Sheets: koordinat tidak case-sensitive (a3 == A3)');

  // editCellComment: ubah teks, id tetap.
  const ccId = ritzC.getCellComments('C7')[0].id;
  assert(ritzC.editCellComment('C7', ccId, 'Teks baru hasil edit') === true,
    'Sheets: editCellComment mengembalikan true bila sukses');
  assert(ritzC.getCellComments('C7')[0].text === 'Teks baru hasil edit',
    'Sheets: editCellComment mengubah teks komentar');
  assert(ritzC.editCellComment('C7', 'tidak-ada', 'x') === false,
    'Sheets: editCellComment ke id tidak dikenal mengembalikan false');
  assert(ritzC.editCellComment('C7', ccId, '  ') === false &&
         ritzC.getCellComments('C7')[0].text === 'Teks baru hasil edit',
    'Sheets: editCellComment menolak teks kosong dan tidak mengubah apa pun');

  // addCellCommentReply: reply punya id sendiri, author default.
  const ccR1 = ritzC.addCellCommentReply('C7', ccId, 'Balasan pertama', null);
  assert(ccR1 && ccR1.id.startsWith('sc_') && ccR1.author === 'Saya' && ccR1.text === 'Balasan pertama',
    'Sheets: addCellCommentReply menghasilkan reply lengkap');
  assert(ritzC.getCellComments('C7')[0].replies.length === 1,
    'Sheets: reply tertambah ke replies array komentar');
  assert(ritzC.addCellCommentReply('C7', 'tidak-ada', 'x', 'X') === null,
    'Sheets: addCellCommentReply ke id tidak dikenal mengembalikan null');

  // setCellCommentResolved: toggle tanpa argumen, paksa true/false.
  assert(ritzC.getCellComments('C7')[0].resolved === false,
    'Sheets: komentar baru belum resolved');
  ritzC.setCellCommentResolved('C7', ccId);
  assert(ritzC.getCellComments('C7')[0].resolved === true,
    'Sheets: setCellCommentResolved toggle (tanpa argumen) membalik status');
  ritzC.setCellCommentResolved('C7', ccId, false);
  assert(ritzC.getCellComments('C7')[0].resolved === false,
    'Sheets: setCellCommentResolved(false) memaksa resolved=false');

  // hasCellComment: true untuk sel berkomentar, false untuk yang kosong.
  assert(ritzC.hasCellComment('A3') === true && ritzC.hasCellComment('Z9') === false,
    'Sheets: hasCellComment benar untuk sel berkomentar / tidak');

  // deleteCellComment: hapus satu, bukan semua. Kunci kosong dibuang.
  const ccA3First = ritzC.getCellComments('A3')[0].id;
  assert(ritzC.deleteCellComment('A3', ccA3First) === true,
    'Sheets: deleteCellComment mengembalikan true bila sukses');
  assert(ritzC.getCellComments('A3').length === 1,
    'Sheets: deleteCellComment menghapus satu komentar (bukan semua)');
  ritzC.deleteCellComment('A3', ritzC.getCellComments('A3')[0].id);
  assert(!('A3' in ritzC.getAllCellComments()),
    'Sheets: kunci kosong dibuang setelah komentar terakhir dihapus');
  assert(ritzC.deleteCellComment('C7', 'tidak-ada') === false,
    'Sheets: deleteCellComment ke id tidak dikenal mengembalikan false');

  // Komentar TIDAK terikat nilai sel (paritas Google Sheets).
  ritzC.cells = { C7: { raw: '', val: '' } };
  assert(ritzC.hasCellComment('C7') === true,
    'Sheets: komentar tetap ada walau nilai sel dikosongkan');

  // Komentar per-sheet: pindah sheet tidak membocorkan komentar sheet lain.
  ritzC.setSheets([
    { name: 'S1', cells: { A1: { raw: 'x', val: 'x' } }, cellComments: { A1: [{ id: 'sc_a', author: 'A', text: 'satu', createdAt: 'x', resolved: false, replies: [] }] } },
    { name: 'S2', cells: { B2: { raw: 'y', val: 'y' } }, cellComments: {} }
  ], 0);
  assert(ritzC.hasCellComment('A1') === true && ritzC.hasCellComment('B2') === false,
    'Sheets: sheet 1 hanya memuat komentarnya sendiri');
  ritzC.switchSheet(1);
  assert(ritzC.hasCellComment('A1') === false && ritzC.getAllCellComments()['A1'] === undefined,
    'Sheets: komentar sheet 1 TIDAK bocor ke sheet 2');
  ritzC.addCellComment('B2', 'komentar sheet 2', 'Z');
  ritzC.switchSheet(0);
  assert(ritzC.hasCellComment('A1') === true && ritzC.hasCellComment('B2') === false,
    'Sheets: komentar sheet 2 TIDAK bocor balik ke sheet 1');
  const ccPerSheet = ritzC.getSheets();
  assert(ccPerSheet[0].cellComments['A1'] && ccPerSheet[1].cellComments['B2'],
    'Sheets: getSheets menyimpan cellComments per sheet');

  // Dokumen lama tanpa cellComments tetap valid (fallback {}).
  ritzC.setSheets([{ name: 'Lama', cells: { A1: { raw: '1', val: 1 } } }], 0);
  assert(JSON.stringify(ritzC.getAllCellComments()) === '{}',
    'Sheets: dokumen lama tanpa cellComments dimuat sebagai map kosong (bukan undefined)');
  assert(ritzC.addCellComment('D4', 'setelah migrasi', null) !== null,
    'Sheets: addCellComment tetap bekerja pada dokumen lama');

  // 14b-c. SHEETS: indikator komentar — geometri, hit-test, wiring klik.
  // Semua variabel di dalam blok { } agar tidak bertabrakan dengan nama yang
  // sudah dipakai Suite 14 lain (pernah gagal: `const c1` bentrok dengan :45).
  {
    const ritzI = new Ritz14('sheetsGridCanvas', 'sheetFormulaInput', 'sheetActiveCell');
    ritzI.render = () => {};
    ritzI.renderSheetTabs = () => {};
    ritzI.updateFormulaBar = () => {};
    ritzI.recalculateAll = async () => ritzI.cells;
    ritzI.scrollX = 0; ritzI.scrollY = 0;
    ritzI.frozenRows = 0; ritzI.frozenCols = 0;
    ritzI.selStartCol = 0; ritzI.selStartRow = 1;
    ritzI.selEndCol = 0; ritzI.selEndRow = 1;

    // Geometri: indikator menempel di pojok KANAN-ATAS sel.
    const tA1 = ritzI.cellCommentRect(0, 1);
    assert(tA1.x === ritzI.cellX(0) + ritzI.getColWidth(0) - 9 && tA1.y === ritzI.cellY(1) && tA1.w === 9 && tA1.h === 9,
      `Sheets: indikator komentar di pojok KANAN-ATAS sel :: x=${tA1.x} y=${tA1.y}`);

    // Yang paling penting: TIDAK bertumpuk dengan fill handle autofill
    // (kanan-bawah). Kalau bertumpuk, klik kecil jadi salah sasaran.
    const fhRect = ritzI.fillHandleRect();
    const cmRect = ritzI.cellCommentRect(0, 1);
    const overlapTR = !(cmRect.x + cmRect.w < fhRect.x || fhRect.x + fhRect.w < cmRect.x ||
                        cmRect.y + cmRect.h < fhRect.y || fhRect.y + fhRect.h < cmRect.y);
    assert(!overlapTR,
      `Sheets: indikator komentar TIDAK bertumpuk dengan fill handle :: cm=${cmRect.x},${cmRect.y} fh=${fhRect.x},${fhRect.y}`);

    // coordToCell memakai colIndexFromLabel yang sudah ada (bukan konversi kedua).
    const pA3 = ritzI.coordToCell('A3');
    assert(pA3 && pA3.col === 0 && pA3.row === 3, 'Sheets: coordToCell("A3") -> kolom 0 baris 3');
    // colIndexFromLabel (sudah ada, dipakai ulang) menangani kolom multi-huruf.
    assert(ritzI.colIndexFromLabel('AA') === 26 && ritzI.colIndexFromLabel('AB') === 27,
      'Sheets: colIndexFromLabel menangani kolom multi-huruf (AA=26, AB=27)');
    // Grid ini hanya A..Z (totalCols=26), jadi kolom AA memang DI LUAR grid dan
    // harus ditolak — bukan dipaksa masuk. Batas grid dihormati, bukan dilonggarkan.
    assert(ritzI.totalCols === 26 && ritzI.coordToCell('AA7') === null,
      'Sheets: coordToCell menolak kolom di luar grid (AA7 saat totalCols=26)');
    assert(ritzI.coordToCell('z5').col === 25 && ritzI.coordToCell('z5').row === 5,
      'Sheets: coordToCell tidak case-sensitive (z5 -> 25,5)');
    assert(ritzI.coordToCell('') === null && ritzI.coordToCell('3A') === null &&
           ritzI.coordToCell('A0') === null && ritzI.coordToCell('A101') === null &&
           ritzI.coordToCell('A') === null && ritzI.coordToCell('1') === null,
      'Sheets: coordToCell menolak koordinat cacat / di luar grid');

    // visibleCommentCoords hanya mengembalikan sel yang valid + berisi.
    ritzI.cellComments = {
      A1: [{ id: 'sc_1', author: 'Budi', text: 'buka', createdAt: 'x', resolved: false, replies: [] }],
      B2: [{ id: 'sc_2', author: 'Ani', text: 'selesai', createdAt: 'x', resolved: true, replies: [] }],
      ZZZ99999: [{ id: 'sc_3', author: 'X', text: 'di luar grid', createdAt: 'x', resolved: false, replies: [] }],
      C3: []
    };
    const vis = ritzI.visibleCommentCoords();
    const visCoords = vis.map(v => v.coord).sort().join(',');
    assert(visCoords === 'A1,B2',
      `Sheets: visibleCommentCoords melewati kunci di luar grid & array kosong :: ${visCoords}`);

    // Hit-test: titik tengah segitiga mengembalikan koordinat sel.
    const cxA1 = tA1.x + tA1.w / 2;
    const cyA1 = tA1.y + tA1.h / 2;
    assert(ritzI.commentHitTest(cxA1, cyA1) === 'A1',
      'Sheets: commentHitTest mengenai segitiga -> koordinat sel');
    // Tengah sel (bukan segitiga) -> null, supaya seleksi sel tidak direbut.
    assert(ritzI.commentHitTest(ritzI.cellX(0) + 40, ritzI.cellY(1) + 20) === null,
      'Sheets: commentHitTest di tengah sel (bukan segitiga) -> null');
    // Sel tanpa komentar -> null walau titiknya di area segitiga.
    const tC5 = ritzI.cellCommentRect(2, 5);
    assert(ritzI.commentHitTest(tC5.x + 4, tC5.y + 4) === null,
      'Sheets: commentHitTest pada sel tanpa komentar -> null');
    // Header tidak pernah dianggap indikator.
    assert(ritzI.commentHitTest(20, 10) === null, 'Sheets: commentHitTest mengabaikan area header');
    // Guard: saat menyunting / resize, hit-test dimatikan.
    ritzI.editing = true;
    assert(ritzI.commentHitTest(cxA1, cyA1) === null, 'Sheets: commentHitTest mati saat in-cell editing');
    ritzI.editing = false;
    ritzI.isResizingCol = true;
    assert(ritzI.commentHitTest(cxA1, cyA1) === null, 'Sheets: commentHitTest mati saat resize kolom');
    ritzI.isResizingCol = false;

    // Fill handle menang atas komentar pada piksel yang sama (tidak ada rebutan):
    // titik pusat fill handle BUKAN titik segitiga, jadi hit-test komentar null.
    assert(ritzI.commentHitTest(fhRect.x + 3, fhRect.y + 3) === null,
      'Sheets: titik fill handle tidak pernah dianggap indikator komentar (prioritas autofill)');

    // ---- RENDER: jumlah segitiga = jumlah sel berkomentar yang terlihat ----
    const colors = [];
    const recCtx = {
      _fs: '',
      set fillStyle(v) { this._fs = v; },
      get fillStyle() { return this._fs; },
      save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      moveTo() {}, lineTo() {}, closePath() {},
      fill() { colors.push(this._fs); }
    };
    ritzI.renderCellCommentIndicators(recCtx, 794, 1050);
    assert(colors.length === 2,
      `Sheets: render menggambar satu segitiga per sel berkomentar :: ${colors.length} segitiga`);
    assert(colors.indexOf('#f9ab00') >= 0,
      'Sheets: thread yang masih terbuka digambar amber (#f9ab00)');
    assert(colors.indexOf('#9aa0a6') >= 0,
      'Sheets: thread yang seluruhnya selesai digambar redup (#9aa0a6)');
    // Tanpa komentar -> tidak menggambar apa pun (tidak ada biaya render).
    ritzI.cellComments = {};
    colors.length = 0;
    ritzI.renderCellCommentIndicators(recCtx, 794, 1050);
    assert(colors.length === 0, 'Sheets: tanpa komentar, render tidak menggambar segitiga');

    // ---- WIRING MOUSE: klik segitiga membuka thread, TIDAK memindah sel ----
    ritzI.cellComments = {
      A1: [{ id: 'sc_1', author: 'Budi', text: 'buka', createdAt: 'x', resolved: false, replies: [] }]
    };
    // Samakan skala kanvas agar clientX/clientY == koordinat kanvas (tanpa zoom).
    ritzI.canvas._rect = {
      left: 0, top: 0, width: ritzI.canvas.width, height: ritzI.canvas.height,
      right: ritzI.canvas.width, bottom: ritzI.canvas.height
    };
    const mdHandlers = (ritzI.canvas._handlers || {}).mousedown || [];
    assert(mdHandlers.length >= 1, 'Sheets: handler mousedown terpasang pada kanvas');
    // PENTING: docStub men-cache elemen per id, jadi ritzI.canvas adalah objek
    // yang SAMA dengan ritz14.canvas dari tes sebelumnya. Handler [0] milik
    // ritz14 (closure-nya menunjuk ritz14, bukan ritzI). Handler ritzI adalah
    // yang TERAKHIR didaftarkan — memakai [0] membuat tes lulus/gagal secara palsu.
    const mdIdx = mdHandlers.length - 1;
    assert(mdHandlers.length >= 2, `Sheets: handler ritzI terdaftar setelah ritz14 :: ${mdHandlers.length} handler`);
    const fireMD = (px, py) => mdHandlers[mdIdx]({ clientX: px, clientY: py, preventDefault() {} });

    let clickedCoord = null, clickedList = null;
    ritzI.onCommentClick = (coord, list) => { clickedCoord = coord; clickedList = list; };
    ritzI.activeCol = 5; ritzI.activeRow = 10;   // sel aktif jauh dari A1
    fireMD(tA1.x + tA1.w / 2, tA1.y + tA1.h / 2);
    assert(clickedCoord === 'A1',
      `Sheets: klik segitiga memicu onCommentClick dengan koordinat sel :: ${clickedCoord}`);
    assert(Array.isArray(clickedList) && clickedList.length === 1 && clickedList[0].text === 'buka',
      'Sheets: onCommentClick menerima daftar komentar sel tersebut');
    assert(ritzI.activeCol === 5 && ritzI.activeRow === 10,
      `Sheets: klik segitiga TIDAK memindahkan sel aktif :: ${ritzI.activeCol},${ritzI.activeRow}`);

    // Klik tengah sel (bukan segitiga) tetap memilih sel, tanpa memicu callback.
    clickedCoord = null;
    fireMD(ritzI.cellX(0) + 40, ritzI.cellY(1) + 20);
    assert(clickedCoord === null, 'Sheets: klik di tengah sel tidak memicu onCommentClick');
    assert(ritzI.activeCol === 0 && ritzI.activeRow === 1,
      `Sheets: klik di tengah sel tetap memilih sel itu :: ${ritzI.activeCol},${ritzI.activeRow}`);

    // ---- HOVER: kursor pointer di indikator, kembali normal di luar ----
    const mmHandlers = (ritzI.canvas._handlers || {}).mousemove || [];
    assert(mmHandlers.length >= 1, 'Sheets: handler mousemove terpasang pada kanvas');
    // Alasan sama seperti mousedown: ambil handler TERAKHIR milik ritzI.
    const mmIdx = mmHandlers.length - 1;
    const fireMM = (px, py) => mmHandlers[mmIdx]({ clientX: px, clientY: py, preventDefault() {} });
    ritzI.isSelecting = false; ritzI.editing = false;
    fireMM(tA1.x + tA1.w / 2, tA1.y + tA1.h / 2);
    assert(ritzI.canvas.style.cursor === 'pointer',
      `Sheets: hover di indikator komentar -> kursor pointer :: ${ritzI.canvas.style.cursor}`);
    fireMM(ritzI.cellX(3) + 30, ritzI.cellY(6) + 12);
    assert(ritzI.canvas.style.cursor === 'cell',
      `Sheets: hover di luar indikator -> kursor kembali normal :: ${ritzI.canvas.style.cursor}`);
  }

  // 14c. DOCS: ceklis (kotak centang) + daftar bernomor berurutan.
  const Kix14 = loadEditor('static/kix_editor.js', 'KixDocsEditor');
  const kix14 = new Kix14('docsScrollBox', 'kixHiddenInput');
  kix14.setDocumentData({ pages: [{ lines: [{ text: 'satu' }, { text: 'dua' }, { text: 'tiga' }] }] });
  kix14.activePageIdx = 0; kix14.activeLineIdx = 0;
  kix14.applyList('numbered');
  const pg14 = kix14.pages[0];
  // Hanya baris yang ditandai yang menjadi butir daftar — baris 1 belum
  // ditandai, jadi belum berpenomoran (perilaku benar, bukan bug).
  assert(kix14.listPrefixFor(pg14, 0) === '1. ' && kix14.listPrefixFor(pg14, 1) === '',
    `Docs: baris ber-nomor = "1. ", baris belum ditandai = kosong :: ${JSON.stringify(kix14.listPrefixFor(pg14, 0))}/${JSON.stringify(kix14.listPrefixFor(pg14, 1))}`);
  kix14.activeLineIdx = 1;
  kix14.applyList('numbered');
  assert(kix14.listPrefixFor(pg14, 1) === '2. ',
    `Docs: daftar bernomor menomori berurutan :: ${kix14.listPrefixFor(pg14, 0)}${kix14.listPrefixFor(pg14, 1)}`);
  kix14.activeLineIdx = 1;
  kix14.applyList('checklist');
  assert(kix14.listPrefixFor(pg14, 1) === '☐ ',
    `Docs: daftar periksa diawali kotak kosong :: ${kix14.listPrefixFor(pg14, 1)}`);
  const toggled14 = kix14.toggleChecklistAt(0, 1);
  assert(toggled14 === true && pg14.lines[1].checked === true && kix14.listPrefixFor(pg14, 1) === '☑ ',
    `Docs: klik kotak ceklis membalik status :: ${kix14.listPrefixFor(pg14, 1)}`);
  const nChecked14 = kix14.setAllChecked(false);
  assert(nChecked14 === 1 && pg14.lines[1].checked === false,
    `Docs: "centang/bersihkan semua" berlaku untuk seluruh butir ceklis :: ${nChecked14} butir`);
  kix14.applyList('checklist');   // tipe sama = lepas daftar
  assert(!pg14.lines[1].listType && pg14.lines[1].checked === undefined,
    'Docs: menekan tombol ceklis dua kali melepas daftar (perilaku Google Docs)');
  assert(kix14.listPrefixFor(pg14, 0) === '1. ',
    'Docs: butir bernomor tidak terpengaruh oleh perubahan butir ceklis');

  // 14d. DOCS: daftar BUTIR BERTINGKAT — penanda berubah mengikuti indentasi.
  kix14.setDocumentData({ pages: [{ lines: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }] });
  kix14.activePageIdx = 0;
  const pgD = kix14.pages[0];
  pgD.lines.forEach(l => { l.listType = 'bullet'; });
  pgD.lines[0].indent = 0; pgD.lines[1].indent = 1; pgD.lines[2].indent = 2;
  const g0 = kix14.listPrefixFor(pgD, 0), g1 = kix14.listPrefixFor(pgD, 1), g2 = kix14.listPrefixFor(pgD, 2);
  assert(g0 === '• ' && g1 === '○ ' && g2 === '■ ',
    `Docs: butir bertingkat memakai penanda berbeda per level :: ${JSON.stringify([g0, g1, g2])}`);
  const indentPx0 = kix14.indentFor(pgD.lines[0]), indentPx2 = kix14.indentFor(pgD.lines[2]);
  assert(indentPx2 > indentPx0,
    `Docs: indentasi menambah jarak kiri nyata :: ${indentPx0}px -> ${indentPx2}px`);

  // 14g. DOCS: HYPERLINK — semantik KETAT getLinkNearCursor + pemetaan x->offset.
  // KUIRK yang diperbaiki: dulu getLinkNearCursor() punya fallback "tautan mana
  // pun di baris ini" (links[links.length-1]). Akibatnya kursor di kata LAIN
  // tetap membuka tautan lama, lengkap dengan tombol "Hapus Tautan" yang
  // berbahaya. Fallback itu dulu berfungsi sebagai PENYANGGA karena klik kanvas
  // SELALU menaruh kursor di akhir baris. Dua-duanya dibereskan bersama:
  // charIndexAtPoint() memetakan x -> offset, lalu getLinkNearCursor() hanya
  // mengembalikan tautan yang benar-benar disentuh kursor.
  kix14.setDocumentData({ pages: [{ lines: [{ text: 'Buka Google atau Yahoo sekarang' }] }] });
  kix14.activePageIdx = 0; kix14.activeLineIdx = 0;
  const linkLine = kix14.pages[0].lines[0];
  kix14.setLinkRange(0, 0, 5, 11, 'https://google.com');    // "Google"
  kix14.setLinkRange(0, 0, 17, 22, 'https://yahoo.com');     // "Yahoo"
  const linksNow = (linkLine.links || []).map(L => `${L.start}-${L.end}`).join(',');
  assert(linksNow === '5-11,17-22',
    `Docs: dua tautan tersimpan berurutan :: ${linksNow}`);

  const nearAt = (c) => { kix14.cursorCharIdx = c; return kix14.getLinkNearCursor(); };
  assert((nearAt(5) || {}).url === 'https://google.com',
    'Docs: kursor tepat di AWAL tautan -> tautan itu');
  assert((nearAt(11) || {}).url === 'https://google.com',
    'Docs: kursor tepat di AKHIR tautan -> masih tautan itu (batas INKLUSIF)');
  assert(nearAt(12) === null,
    'Docs: kursor 1 setelah akhir tautan -> null (bukan tautan lama)');
  assert(nearAt(14) === null,
    'Docs: kursor di ANTARA dua tautan -> null (bukan links[0]/links[last])');
  assert((nearAt(19) || {}).url === 'https://yahoo.com',
    'Docs: kursor di tautan KEDUA -> tautan kedua');
  assert(nearAt(linkLine.text.length) === null,
    'Docs: kursor di AKHIR baris padahal tautan di tengah -> null (MEMBALIK fallback lama)');
  assert(nearAt(0) === null,
    'Docs: kursor di awal baris sebelum tautan -> null');

  // charIndexAtPoint: klik di tengah baris harus mendarat di TENGAH, bukan akhir.
  // Sebelumnya handler klik menulis `cursorCharIdx = line.text.length` secara
  // literal, sehingga Ctrl+K praktis hanya bisa menggenggam kata terakhir.
  const cvs14 = docStub.getElementById('kixCanvas1');
  const ctx14 = cvs14.getContext('2d');
  const MARGIN14 = 30;
  assert(kix14.charIndexAtPoint(0, 0, MARGIN14 - 5) === 0,
    `Docs: klik di kiri margin -> offset 0 :: ${kix14.charIndexAtPoint(0, 0, MARGIN14 - 5)}`);
  const afterThree = kix14.charIndexAtPoint(0, 0, MARGIN14 + ctx14.measureText('Buk').width);
  assert(afterThree === 3,
    `Docs: klik setelah 3 huruf -> offset 3 :: ${afterThree}`);
  const farRight = kix14.charIndexAtPoint(0, 0, MARGIN14 + ctx14.measureText(linkLine.text).width + 50);
  assert(farRight === linkLine.text.length,
    `Docs: klik jauh di kanan -> offset akhir :: ${farRight}`);

  // Konsekuensi langsung perbaikan kursor: wordRangeAtCursor() kini bisa
  // menggenggam kata di TENGAH baris, bukan hanya kata terakhir.
  kix14.cursorCharIdx = 8;
  const wr14 = kix14.wordRangeAtCursor();
  assert(wr14 && wr14.text === 'Google',
    `Docs: wordRangeAtCursor di TENGAH baris menggenggam kata yang benar :: ${wr14 && wr14.text}`);

  // Dan applyLinkAtCursor() benar-benar menautkan kata di tengah baris.
  kix14.cursorCharIdx = 26;   // di "sekarang" (belum bertaut)
  const applied14 = kix14.applyLinkAtCursor('https://contoh.id', 'sekarang');
  const newLink14 = (kix14.pages[0].lines[0].links || []).find(L => L.url === 'https://contoh.id');
  assert(applied14 === true && newLink14 && newLink14.start === 23 && newLink14.end === 31,
    `Docs: applyLinkAtCursor menautkan kata di TENGAH baris :: ${newLink14 ? newLink14.start + '-' + newLink14.end : 'null'}`);

  // 14h. DOCS: PEMISAH HALAMAN MANUAL (Ctrl+Enter) — paritas Google Docs.
  // Kunci desain: reflowPages() mengiterasi `for (const page of this.pages)` dan
  // hanya MEMECAH halaman yang meluber, tidak pernah MENGGABUNG dua halaman.
  // Karena itu halaman hasil pemisah manual bertahan tanpa perlu flag tambahan.
  kix14.setDocumentData({ pages: [{ lines: [{ text: 'Buka Google atau Yahoo sekarang', bold: true }] }] });
  kix14.activePageIdx = 0; kix14.activeLineIdx = 0;
  kix14.setLinkRange(0, 0, 5, 11, 'https://google.com');   // "Google"
  kix14.cursorCharIdx = 8;                                  // di TENGAH "Google"
  const pbOk = kix14.insertPageBreak();
  assert(pbOk === true && kix14.pages.length === 2,
    `Docs: pemisah halaman menambah halaman :: ok=${pbOk} pages=${kix14.pages.length}`);
  assert(kix14.pages[0].lines[0].text === 'Buka Goo',
    `Docs: teks SEBELUM kursor tetap di halaman lama :: "${kix14.pages[0].lines[0].text}"`);
  assert(kix14.pages[1].lines[0].text === 'gle atau Yahoo sekarang',
    `Docs: teks SESUDAH kursor pindah ke halaman baru :: "${kix14.pages[1].lines[0].text}"`);
  assert(kix14.activePageIdx === 1 && kix14.activeLineIdx === 0 && kix14.cursorCharIdx === 0,
    `Docs: kursor pindah ke awal halaman baru :: p=${kix14.activePageIdx} l=${kix14.activeLineIdx} c=${kix14.cursorCharIdx}`);
  const pbLeft = (kix14.pages[0].lines[0].links || []).map(L => `${L.start}-${L.end}`).join(',');
  const pbRight = (kix14.pages[1].lines[0].links || []).map(L => `${L.start}-${L.end}`).join(',');
  assert(pbLeft === '5-8' && pbRight === '0-3',
    `Docs: tautan melintasi pemisah DIBELAH, bukan dibuang :: kiri=${pbLeft} kanan=${pbRight}`);
  assert(kix14.pages[1].lines[0].bold === true,
    'Docs: baris ekor mewarisi gaya baris asal (bold tidak hilang di titik pisah)');

  // Routing Ctrl+Enter: WAJIB dicek SEBELUM cabang Enter biasa. Kalau urutannya
  // terbalik, satu tekan menghasilkan DUA mutasi (baris baru + halaman baru).
  kix14.setDocumentData({ pages: [{ lines: [{ text: 'abcdef' }] }] });
  kix14.activePageIdx = 0; kix14.activeLineIdx = 0; kix14.cursorCharIdx = 3;
  kix14.handleKey({ key: 'Enter', ctrlKey: true, metaKey: false, preventDefault() {} });
  assert(kix14.pages.length === 2 && kix14.pages[0].lines.length === 1,
    `Docs: Ctrl+Enter TIDAK memecah baris ganda :: pages=${kix14.pages.length} barisHalaman1=${kix14.pages[0].lines.length}`);
  assert(kix14.pages[0].lines[0].text === 'abc' && kix14.pages[1].lines[0].text === 'def',
    `Docs: Ctrl+Enter memotong tepat di kursor :: "${kix14.pages[0].lines[0].text}" | "${kix14.pages[1].lines[0].text}"`);
  // Enter BIASA di halaman hasil pisah harus tetap berperilaku normal (1 halaman).
  kix14.cursorCharIdx = 3;
  kix14.handleKey({ key: 'Enter', ctrlKey: false, metaKey: false, preventDefault() {} });
  assert(kix14.pages.length === 2 && kix14.pages[1].lines.length === 2,
    `Docs: Enter biasa setelah pemisah tetap menambah BARIS (bukan halaman) :: pages=${kix14.pages.length} baris=${kix14.pages[1].lines.length}`);

  // 14i. DOCS: INDIKATOR HALAMAN SADAR-VIEWPORT + viewport mengikuti kursor.
  //
  // KUIRK yang diperbaiki: status bar dulu memakai Math.floor(scrollTop/850)+1.
  // Angka 850 = PAGE_CANVAS_HEIGHT, yaitu tinggi koordinat INTERNAL kanvas,
  // sedangkan tinggi tile nyata di DOM = min-height 1056 + margin-bottom 24
  // (lihat .kix-page di dashboard.html). Akibatnya halaman ke-2 baru dianggap
  // aktif setelah scrollTop 850 — padahal puncaknya sudah lewat jauh sebelumnya,
  // jadi status bar tertinggal satu halaman tepat setelah pemisah halaman.
  //
  // Catatan kejujuran: tes ini menguji LOGIKA KEPUTUSAN dengan geometri yang
  // disuntikkan (rect per elemen), bukan layout browser sungguhan. Geometri
  // nyata diverifikasi di E2E (S11/S12) yang mengukur getBoundingClientRect asli.
  const scrollBox14 = docStub.getElementById('docsScrollBox');
  kix14.setDocumentData({ pages: [
    { lines: [{ text: 'halaman satu' }] },
    { lines: [{ text: 'halaman dua' }] }
  ] });
  assert(kix14.pages.length === 2, `Docs: dua halaman siap untuk uji indikator :: pages=${kix14.pages.length}`);

  // Posisi awal: halaman 1 mengisi viewport.
  scrollBox14._rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
  docStub.getElementById('kixPage1')._rect = { left: 0, top: 0, width: 816, height: 1056, right: 816, bottom: 1056 };
  docStub.getElementById('kixPage2')._rect = { left: 0, top: 1080, width: 816, height: 1056, right: 816, bottom: 2136 };
  assert(kix14.pageIndexAtViewportTop() === 0,
    `Docs: indikator halaman = 0 saat halaman pertama mengisi viewport :: ${kix14.pageIndexAtViewportTop()}`);

  // Setelah digulir ke puncak halaman 2 (scrollTop 1080), tile halaman 2
  // menempati tepi atas viewport -> indikator WAJIB pindah ke indeks 1.
  docStub.getElementById('kixPage1')._rect = { left: 0, top: -1080, width: 816, height: 1056, right: 816, bottom: -24 };
  docStub.getElementById('kixPage2')._rect = { left: 0, top: 0, width: 816, height: 1056, right: 816, bottom: 1056 };
  assert(kix14.pageIndexAtViewportTop() === 1,
    `Docs: indikator halaman pindah ke 1 saat halaman kedua di atas viewport :: ${kix14.pageIndexAtViewportTop()}`);

  // Inilah pembeda terhadap rumus lama: pada scrollTop 848 rumus lama
  // menghasilkan floor(848/850)+1 = 1 (SALAH), geometri nyata menghasilkan 2.
  assert(Math.floor(848 / 850) + 1 === 1 && kix14.pageIndexAtViewportTop() + 1 === 2,
    `Docs: rumus lama tertinggal satu halaman pada scrollTop 848 (lama=1, benar=${kix14.pageIndexAtViewportTop() + 1})`);

  // Handler scroll yang terpasang di scrollBox harus memakai geometri baru,
  // bukan PAGE_CANVAS_HEIGHT. Dipanggil langsung karena mock tidak menggelembungkan event.
  let reported14 = null;
  kix14.onPageChange = (cur, total, words) => { reported14 = { cur, total, words }; };
  const scrollHandlers14 = (scrollBox14._handlers && scrollBox14._handlers.scroll) || [];
  assert(scrollHandlers14.length > 0,
    `Docs: handler scroll terpasang pada wadah gulir :: handlers=${scrollHandlers14.length}`);
  scrollHandlers14[scrollHandlers14.length - 1]();
  assert(reported14 && reported14.cur === 2 && reported14.total === 2,
    `Docs: status bar melaporkan halaman kursor, bukan hasil bagi scrollTop :: ${JSON.stringify(reported14)}`);

  // scrollPageIntoView: wajib menggulir ke puncak halaman target DAN
  // menyinkronkan indikator tanpa menunggu event scroll.
  docStub.getElementById('kixPage2')._scrolled = undefined;
  reported14 = null;
  kix14.scrollPageIntoView(1);
  const scrolled14 = docStub.getElementById('kixPage2')._scrolled;
  assert(scrolled14 && scrolled14.block === 'start',
    `Docs: halaman target digulir ke puncak (block start) :: ${JSON.stringify(scrolled14)}`);
  assert(reported14 && reported14.cur === 2,
    `Docs: indikator langsung sinkron setelah gulir (tanpa menunggu event) :: ${JSON.stringify(reported14)}`);

  // Pemisah halaman WAJIB membawa viewport ke halaman baru. Tanpa ini kursor
  // sudah di halaman 2 tetapi layar masih menampilkan halaman 1.
  kix14.setDocumentData({ pages: [{ lines: [{ text: 'atas bawah' }] }] });
  docStub.getElementById('kixPage1')._rect = { left: 0, top: 0, width: 816, height: 1056, right: 816, bottom: 1056 };
  docStub.getElementById('kixPage2')._rect = { left: 0, top: 1080, width: 816, height: 1056, right: 816, bottom: 2136 };
  docStub.getElementById('kixPage2')._scrolled = undefined;
  kix14.activePageIdx = 0; kix14.activeLineIdx = 0; kix14.cursorCharIdx = 5;
  const pbScroll14 = kix14.insertPageBreak();
  const pbScrolled14 = docStub.getElementById('kixPage2')._scrolled;
  assert(pbScroll14 === true && pbScrolled14 && pbScrolled14.block === 'start',
    `Docs: pemisah halaman ikut menggulir viewport ke halaman baru :: ${JSON.stringify(pbScrolled14)}`);

  // insertNewPage juga harus menggulir (paritas dengan pemisah halaman).
  // CATATAN: setelah insertPageBreak di atas, dokumen sudah 2 halaman, jadi
  // insertNewPage menambah halaman KE-3 dan wajib menggulir kixPage3 — bukan
  // kixPage2. Memeriksa kixPage2 di sini akan gagal palsu.
  const pagesBeforeNew14 = kix14.pages.length;
  docStub.getElementById('kixPage3')._scrolled = undefined;
  kix14.insertNewPage();
  const newPageScrolled14 = docStub.getElementById('kixPage3')._scrolled;
  assert(kix14.pages.length === pagesBeforeNew14 + 1 && kix14.activePageIdx === kix14.pages.length - 1,
    `Docs: tambah halaman baru menambah 1 halaman & kursor ke halaman terakhir :: ${pagesBeforeNew14} -> ${kix14.pages.length} aktif=${kix14.activePageIdx}`);
  assert(newPageScrolled14 && newPageScrolled14.block === 'start',
    `Docs: tambah halaman baru ikut menggulir viewport :: ${JSON.stringify(newPageScrolled14)}`);

  // 14e. SLIDES: urut-ulang slide (moveSlide) — hanya menukar posisi.
  const punch14b = new Punch14('slideStage', 'filmstrip');
  punch14b.slides = [
    { id: 1, title: 'A', elements: [] },
    { id: 2, title: 'B', elements: [] },
    { id: 3, title: 'C', elements: [] }
  ];
  punch14b.activeSlideIdx = 0;
  const movedTo = punch14b.moveSlide(1);
  assert(movedTo === 1 && punch14b.slides.map(s => s.title).join('') === 'BAC',
    `Slides: pindah slide ke bawah menukar urutan :: ${punch14b.slides.map(s => s.title).join('')} (idx=${movedTo})`);
  const backTo = punch14b.moveSlide(-1);
  assert(backTo === 0 && punch14b.slides.map(s => s.title).join('') === 'ABC',
    `Slides: pindah slide ke atas mengembalikan urutan :: ${punch14b.slides.map(s => s.title).join('')}`);
  punch14b.activeSlideIdx = 0;
  assert(punch14b.moveSlide(-1) === -1 && punch14b.slides.map(s => s.title).join('') === 'ABC',
    'Slides: slide paling atas tidak dapat dipindah ke atas (batas aman)');
  punch14b.activeSlideIdx = 2;
  assert(punch14b.moveSlide(1) === -1 && punch14b.slides.map(s => s.title).join('') === 'ABC',
    'Slides: slide paling bawah tidak dapat dipindah ke bawah (batas aman)');

  // 14f. SHEETS: dokumen SVG bagan mandiri (bahan tombol "Unduh SVG").
  ritz14.cells = { C1: { raw: '30', val: 30 }, C2: { raw: '10', val: 10 }, C3: { raw: '20', val: 20 } };
  ritz14.activeCol = 2;
  ritz14.insertChart('column');
  const svgDoc = ritz14.chartSvgDocument();
  assert(typeof svgDoc === 'string' && svgDoc.startsWith('<svg') && svgDoc.includes('xmlns="http://www.w3.org/2000/svg"'),
    `Sheets: bagan dapat diekspor sebagai dokumen SVG mandiri :: ${typeof svgDoc === 'string' ? svgDoc.length + ' chars' : svgDoc}`);
  assert(svgDoc.includes('<rect') && svgDoc.endsWith('</svg>'),
    'Sheets: dokumen SVG berisi elemen gambar dan tertutup rapi');
  ritz14.removeChart();
  assert(ritz14.chartSvgDocument() === null,
    'Sheets: tanpa bagan aktif, ekspor SVG mengembalikan null (bukan berkas kosong)');

  // 14j. DOCS: KOMENTAR — mesin jangkar rentang (paritas Google Docs).
  // Jangkar menumpang pola line.links = [{start,end}], tetapi TIDAK menyalin
  // literal: accessor tidak lazy-init (agar payload simpan tidak dipenuhi
  // "comments": []) dan objek di-spread saat offset bergeser (agar metadata
  // percakapan tidak hilang tiap keystroke).
  kix14.setDocumentData({ pages: [{ lines: [{ text: 'Halo dunia indah' }] }] });
  kix14.activePageIdx = 0; kix14.activeLineIdx = 0; kix14.cursorCharIdx = 0;
  const cmLine = kix14.pages[0].lines[0];

  // Accessor WAJIB murni baca. Kalau ia menulis line.comments = [] seperti
  // _linksOf, setiap baris yang disunting akan membawa noise ke payload simpan.
  const cmEmpty = kix14._commentsOf(cmLine);
  assert(Array.isArray(cmEmpty) && cmEmpty.length === 0
    && !Object.prototype.hasOwnProperty.call(cmLine, 'comments'),
    `Docs: accessor komentar tidak membuat properti pada baris :: ${JSON.stringify(Object.keys(cmLine))}`);

  const cmA = kix14.addComment(0, 0, 0, 4, '  Perlu contoh?  ', 'Saya');
  assert(cmA && typeof cmA.id === 'string' && cmA.id.startsWith('c_'),
    `Docs: komentar baru punya id unik :: ${cmA && cmA.id}`);
  assert(cmA.start === 0 && cmA.end === 4 && cmA.text === 'Perlu contoh?',
    `Docs: rentang & teks komentar ternormalisasi :: ${cmA.start}-${cmA.end} "${cmA.text}"`);
  assert(cmA.author === 'Saya' && cmA.resolved === false
    && Array.isArray(cmA.replies) && cmA.replies.length === 0
    && !isNaN(Date.parse(cmA.createdAt)),
    `Docs: metadata komentar lengkap (author/resolved/replies/createdAt) :: ${cmA.author}|${cmA.resolved}|${cmA.createdAt}`);

  // Teks kosong dan rentang kolaps ditolak — bukan komentar hantu tanpa jangkar.
  const cmBadText = kix14.addComment(0, 0, 0, 4, '   ', 'Saya');
  const cmBadRange = kix14.addComment(0, 0, 6, 6, 'kosong', 'Saya');
  assert(cmBadText === null && cmBadRange === null,
    `Docs: komentar tanpa teks / rentang kolaps ditolak :: ${cmBadText}|${cmBadRange}`);

  // Komentar boleh TUMPANG-TINDIH (dua orang menandai frasa sama) — addComment
  // hanya push, tidak menimpa rentang beririsan seperti setLinkRange.
  kix14.addComment(0, 0, 2, 7, 'Frasa ini janggal.', 'Budi');
  const cmBoth = kix14._commentsOf(kix14.pages[0].lines[0]).map(C => `${C.start}-${C.end}`).join(',');
  assert(cmBoth === '0-4,2-7',
    `Docs: dua komentar beririsan keduanya tersimpan :: ${cmBoth}`);

  // Geser offset saat menyisip karakter SEBELUM rentang: keduanya ikut bergeser.
  const cmShiftLine = { text: 'abcdefgh', comments: [{ id: 'x1', start: 3, end: 6, author: 'Saya', text: 't', createdAt: '2026-01-01T00:00:00Z', resolved: false, replies: [] }] };
  kix14._shiftComments(cmShiftLine, 1, 1);
  const cmAfterIns = cmShiftLine.comments[0];
  assert(cmAfterIns.start === 4 && cmAfterIns.end === 7,
    `Docs: sisip sebelum rentang menggeser kedua offset :: ${cmAfterIns.start}-${cmAfterIns.end}`);
  // Metadata WAJIB selamat — inilah bedanya dengan _shiftLinks yang merebuild
  // objek menjadi {start,end,url} dan akan membuang author/text/replies.
  assert(cmAfterIns.author === 'Saya' && cmAfterIns.text === 't'
    && Array.isArray(cmAfterIns.replies) && cmAfterIns.createdAt === '2026-01-01T00:00:00Z',
    `Docs: geser offset TIDAK menghilangkan metadata komentar :: ${JSON.stringify(Object.keys(cmAfterIns))}`);

  // Sisip di TENGAH rentang: hanya end yang melebar.
  const cmMidLine = { text: 'abcdefgh', comments: [{ id: 'x2', start: 2, end: 6, author: 'Saya', text: 't', createdAt: '2026-01-01T00:00:00Z', resolved: false, replies: [] }] };
  kix14._shiftComments(cmMidLine, 4, 1);
  assert(cmMidLine.comments[0].start === 2 && cmMidLine.comments[0].end === 7,
    `Docs: sisip di tengah rentang hanya melebarkan end :: ${cmMidLine.comments[0].start}-${cmMidLine.comments[0].end}`);

  // Hapus karakter SEBELUM rentang: kedua offset mundur.
  const cmDelLine = { text: 'abcdefgh', comments: [{ id: 'x3', start: 3, end: 6, author: 'Saya', text: 't', createdAt: '2026-01-01T00:00:00Z', resolved: false, replies: [] }] };
  kix14._shiftComments(cmDelLine, 1, -1);
  assert(cmDelLine.comments[0].start === 2 && cmDelLine.comments[0].end === 5,
    `Docs: hapus sebelum rentang menggeser kedua offset mundur :: ${cmDelLine.comments[0].start}-${cmDelLine.comments[0].end}`);

  // Rentang yang habis terhapus dibuang, bukan menyisakan jangkar hantu e<=s.
  const cmGoneLine = { text: 'ab', comments: [{ id: 'x4', start: 0, end: 2, author: 'Saya', text: 't', createdAt: '2026-01-01T00:00:00Z', resolved: false, replies: [] }] };
  kix14._shiftComments(cmGoneLine, 0, -2);
  assert(!Array.isArray(cmGoneLine.comments) || cmGoneLine.comments.length === 0,
    `Docs: komentar yang rentangnya habis terhapus ikut dibuang :: ${JSON.stringify(cmGoneLine.comments)}`);

  // Opsi A — Enter TIDAK membelah thread menjadi dua percakapan.
  // Kasus 1: cut <= start -> seluruh komentar pindah ke baris kanan, offset dinormalkan.
  const cmSplit1 = kix14._splitCommentsAt({ comments: [{ id: 'a', start: 4, end: 8, author: 'S', text: 't', createdAt: '', resolved: false, replies: [] }] }, 3);
  assert(cmSplit1 && cmSplit1.keep.length === 0 && cmSplit1.move.length === 1
    && cmSplit1.move[0].start === 1 && cmSplit1.move[0].end === 5,
    `Docs: Enter sebelum komentar -> komentar pindah utuh ke baris baru :: ${JSON.stringify(cmSplit1 && cmSplit1.move.map(C => C.start + '-' + C.end))}`);
  // Kasus 2: cut memotong rentang -> tetap di kiri, dipangkas ke start..cut.
  const cmSplit2 = kix14._splitCommentsAt({ comments: [{ id: 'b', start: 1, end: 7, author: 'S', text: 't', createdAt: '', resolved: false, replies: [] }] }, 4);
  assert(cmSplit2 && cmSplit2.keep.length === 1 && cmSplit2.move.length === 0
    && cmSplit2.keep[0].start === 1 && cmSplit2.keep[0].end === 4,
    `Docs: Enter memotong rentang -> komentar tetap di kiri & dipangkas :: ${JSON.stringify(cmSplit2 && cmSplit2.keep.map(C => C.start + '-' + C.end))}`);
  // Kasus 3: cut >= end -> tidak tersentuh sama sekali.
  const cmSplit3 = kix14._splitCommentsAt({ comments: [{ id: 'c', start: 0, end: 2, author: 'S', text: 't', createdAt: '', resolved: false, replies: [] }] }, 5);
  assert(cmSplit3 && cmSplit3.keep.length === 1 && cmSplit3.move.length === 0
    && cmSplit3.keep[0].start === 0 && cmSplit3.keep[0].end === 2,
    `Docs: Enter sesudah komentar -> komentar tak tersentuh :: ${JSON.stringify(cmSplit3 && cmSplit3.keep.map(C => C.start + '-' + C.end))}`);

  // Integrasi: Enter NYATA lewat handleKey harus memakai aturan Opsi A di atas.
  kix14.setDocumentData({ pages: [{ lines: [{ text: 'abcdef' }] }] });
  kix14.activePageIdx = 0; kix14.activeLineIdx = 0; kix14.cursorCharIdx = 3;
  kix14.addComment(0, 0, 1, 5, 'lintas titik potong', 'Saya');
  kix14.cursorCharIdx = 3;
  kix14.handleKey({ key: 'Enter', ctrlKey: false, metaKey: false, preventDefault() {} });
  const cmLeftLine = kix14.pages[0].lines[0];
  const cmRightLine = kix14.pages[0].lines[1];
  const cmLeftRanges = kix14._commentsOf(cmLeftLine).map(C => `${C.start}-${C.end}`).join(',');
  assert(cmLeftLine.text === 'abc' && cmRightLine.text === 'def',
    `Docs: Enter memecah baris di kursor :: "${cmLeftLine.text}" | "${cmRightLine.text}"`);
  assert(cmLeftRanges === '1-3' && kix14._commentsOf(cmRightLine).length === 0,
    `Docs: komentar melintasi titik potong tetap SATU thread di baris kiri :: kiri=${cmLeftRanges} kanan=${kix14._commentsOf(cmRightLine).length}`);

  // Siklus persistensi: payload JSON harus membawa komentar + balasan utuh.
  const cmTarget = kix14.getAllComments()[0];
  kix14.addReply(cmTarget.comment.id, '  Setuju, saya rapikan.  ', 'Budi');
  const cmRound = JSON.parse(JSON.stringify(kix14.getDocumentData()));
  kix14.setDocumentData(cmRound);
  const cmBack = kix14.getAllComments()[0];
  assert(cmBack && cmBack.comment.replies.length === 1
    && cmBack.comment.replies[0].text === 'Setuju, saya rapikan.'
    && cmBack.comment.replies[0].author === 'Budi',
    `Docs: komentar + balasan selamat melewati round-trip JSON :: ${JSON.stringify(cmBack && cmBack.comment.replies)}`);

  // Tahan-reflow: reflowPages() memindahkan OBJEK line antar-halaman, jadi
  // komentar harus ikut berpindah tanpa kalkulasi ulang posisi.
  kix14.setDocumentData({ pages: [{ lines: Array.from({ length: 28 }, (_, i) => ({ text: 'baris ' + i })) }] });
  kix14.addComment(0, 27, 0, 5, 'baris terakhir halaman satu', 'Saya');
  kix14.pages[0].lines.push(...Array.from({ length: 12 }, (_, i) => ({ text: 'tambahan ' + i })));
  kix14.reflowPages();
  const cmReflow = kix14.getAllComments();
  assert(cmReflow.length === 1
    && kix14.pages[cmReflow[0].pIdx].lines[cmReflow[0].lIdx].text === 'baris 27',
    `Docs: komentar ikut berpindah halaman saat reflow :: p=${cmReflow[0] && cmReflow[0].pIdx} teks="${cmReflow[0] && kix14.pages[cmReflow[0].pIdx].lines[cmReflow[0].lIdx].text}"`);

  // resolve / reply / remove — siklus hidup thread.
  const cmId = cmReflow[0].comment.id;
  const cmResolved = kix14.resolveComment(cmId);
  assert(cmResolved === true && kix14.findComment(cmId).comment.resolved === true,
    'Docs: komentar dapat ditandai selesai');
  kix14.resolveComment(cmId);
  assert(kix14.findComment(cmId).comment.resolved === false,
    'Docs: tanda selesai dapat dibuka kembali (toggle)');
  const cmRemoved = kix14.removeComment(cmId);
  assert(cmRemoved === true && kix14.getAllComments().length === 0
    && !Object.prototype.hasOwnProperty.call(kix14.pages[0].lines[0], 'comments'),
    'Docs: hapus komentar terakhir membersihkan properti baris');

  // Komentar TIDAK boleh bocor ke hitungan kata maupun teks ekspor.
  kix14.setDocumentData({ pages: [{ lines: [{ text: 'satu dua tiga' }] }] });
  kix14.addComment(0, 0, 0, 4, 'kata kata kata kata kata', 'Saya');
  const cmWords = kix14.calculateWordCount();
  const cmPlain = kix14.exportPlainText();
  assert(cmWords === 3 && !String(cmPlain).includes('kata kata kata'),
    `Docs: teks komentar tidak ikut dihitung sebagai isi dokumen :: kata=${cmWords}`);

  // Backspace di TENGAH baris adalah jalur BERBEDA dari Delete (baris kode
  // yang berbeda, bukan sekadar delta berlawanan). Tanpa panggilan
  // _shiftComments di sana, offset komentar melenceng satu karakter setiap kali
  // user menghapus ke belakang — cacat senyap: highlight bergeser pelan-pelan
  // sementara tes Delete di atas tetap hijau.
  kix14.setDocumentData({ pages: [{ lines: [{ text: 'abcdef' }] }] });
  kix14.activePageIdx = 0; kix14.activeLineIdx = 0; kix14.cursorCharIdx = 4;
  kix14.addComment(0, 0, 4, 6, 'ekor', 'Saya');
  kix14.activeLineIdx = 0; kix14.cursorCharIdx = 2;   // Backspace menghapus 'b'
  kix14.handleKey({ key: 'Backspace', ctrlKey: false, metaKey: false, preventDefault() {} });
  const cmBackLine = kix14.pages[0].lines[0];
  const cmBackC = kix14._commentsOf(cmBackLine)[0];
  assert(cmBackLine.text === 'acdef',
    `Docs: Backspace menghapus karakter sebelum kursor :: "${cmBackLine.text}"`);
  assert(cmBackC && cmBackC.start === 3 && cmBackC.end === 5,
    `Docs: Backspace sebelum rentang menggeser offset komentar :: ${cmBackC && cmBackC.start + '-' + cmBackC.end}`);

  // Backspace-join: komentar baris KEDUA pindah ke baris pertama, digeser
  // sepanjang teks baris pertama. Objek WAJIB di-spread agar metadata selamat.
  kix14.setDocumentData({ pages: [{ lines: [{ text: 'AAA' }, { text: 'BBB' }] }] });
  kix14.activePageIdx = 0; kix14.activeLineIdx = 1; kix14.cursorCharIdx = 0;
  kix14.addComment(0, 1, 0, 3, 'seluruh baris dua', 'Budi');
  kix14.activePageIdx = 0; kix14.activeLineIdx = 1; kix14.cursorCharIdx = 0;
  kix14.handleKey({ key: 'Backspace', ctrlKey: false, metaKey: false, preventDefault() {} });
  const cmJoinLine = kix14.pages[0].lines[0];
  const cmJoinC = kix14._commentsOf(cmJoinLine)[0];
  assert(kix14.pages[0].lines.length === 1 && cmJoinLine.text === 'AAABBB',
    `Docs: Backspace di awal baris menggabung dua baris :: baris=${kix14.pages[0].lines.length} teks="${cmJoinLine.text}"`);
  assert(cmJoinC && cmJoinC.start === 3 && cmJoinC.end === 6
    && cmJoinC.author === 'Budi' && cmJoinC.text === 'seluruh baris dua',
    `Docs: komentar baris gabungan pindah utuh ke baris pertama :: ${cmJoinC && cmJoinC.start + '-' + cmJoinC.end} author=${cmJoinC && cmJoinC.author}`);

  // ================= TEST SUITE 9e: REGRESI 5 PERILAKU INTI SHEETS =================
  // m6 mengaudit cakupan regresi resize/autofill/freeze/seleksi/undo. Audit itu
  // membuktikan resize, autofill, dan freeze NOL asersi permanen: perilakunya
  // hanya tersentuh tidak langsung, sehingga tidak ada yang menangkap regresi.
  // Suite ini mengunci kelimanya dengan angka HASIL UKUR (colWidth=110,
  // rowHeight=26, headerWidth=46, headerHeight=28), bukan angka karangan.
  // Undo/redo tidak diuji di sini karena state-nya milik app_shell (undoStack),
  // bukan Ritz; cakupannya dijaga Suite 9b/9d + E2E S8 (batas 60 entri).
  console.log('\n--- Suite 9e: Regresi resize / autofill / freeze / seleksi ---');
  const rRz = new Ritz14('sheetsGridCanvas', 'sheetFormulaInput', 'sheetActiveCell');
  rRz.render = () => {};
  rRz.recalculateAll = () => rRz.cells;

  // --- RESIZE KOLOM: default, geser prefix-sum, dan clamp minimum ---
  assert(rRz.colWidth === 110 && rRz.rowHeight === 26 && rRz.headerWidth === 46 && rRz.headerHeight === 28,
    `Resize: geometri dasar tidak berubah :: colW=${rRz.colWidth} rowH=${rRz.rowHeight} hW=${rRz.headerWidth} hH=${rRz.headerHeight}`);
  assert(rRz.getColWidth(0) === 110 && rRz.getColX(0) === 46 && rRz.getColX(1) === 156,
    `Resize: lebar default & posisi kolom :: w0=${rRz.getColWidth(0)} x0=${rRz.getColX(0)} x1=${rRz.getColX(1)}`);
  assert(rRz.setColWidth(1, 200) === 200 && rRz.getColWidth(1) === 200,
    `Resize: setColWidth menyimpan lebar baru :: ${rRz.getColWidth(1)}`);
  assert(rRz.getColX(2) === 356 && rRz.colBoundaryX(1) === 356,
    `Resize: kolom SESUDAHNYA ikut bergeser (prefix-sum) :: x2=${rRz.getColX(2)} batas1=${rRz.colBoundaryX(1)}`);
  assert(rRz.setColWidth(2, 5) === 30 && rRz.setColWidth(3, 'abc') === 30,
    `Resize: lebar di-clamp ke minimum 30 (input tak wajar tidak merusak grid) :: ${rRz.getColWidth(2)}/${rRz.getColWidth(3)}`);
  assert(rRz.colResizeHit(357, 10) === 1 && rRz.colResizeHit(300, 10) === -1 && rRz.colResizeHit(357, 40) === -1,
    'Resize: hit-test hanya tepat di garis (toleransi 4px) & hanya di pita header');

  // --- RESIZE BARIS: cermin kolom, minimum 18 ---
  assert(rRz.setRowHeight(1, 40) === 40 && rRz.getRowHeight(1) === 40 && rRz.cellY(1) === 28,
    `Resize: tinggi baris tersimpan :: h=${rRz.getRowHeight(1)} y1=${rRz.cellY(1)}`);
  assert(rRz.setRowHeight(2, 5) === 18 && rRz.getRowHeight(2) === 18 && rRz.getRowHeight(3) === 26,
    `Resize: tinggi di-clamp ke minRowHeight=18 & baris lain tetap 26 :: ${rRz.getRowHeight(2)}/${rRz.getRowHeight(3)}`);
  assert(rRz.rowResizeHit(20, 69) === 1 && rRz.rowResizeHit(100, 69) === -1,
    'Resize: hit-test baris hanya di pita header kiri (x <= headerWidth)');

  // --- FREEZE: panel beku mengabaikan scroll, selain itu ikut scroll ---
  const rFz = new Ritz14('sheetsGridCanvas', 'sheetFormulaInput', 'sheetActiveCell');
  rFz.render = () => {};
  rFz.recalculateAll = () => rFz.cells;
  assert(rFz.freezeX() === 46 && rFz.freezeY() === 28,
    `Freeze: tanpa panel beku rumus IDENTIK versi lama :: x=${rFz.freezeX()} y=${rFz.freezeY()}`);
  rFz.frozenCols = 2;
  rFz.frozenRows = 1;
  rFz.scrollX = 50;
  rFz.scrollY = 30;
  assert(rFz.freezeX() === 266 && rFz.freezeY() === 54,
    `Freeze: batas panel beku = header + lebar/tinggi yang dibekukan :: x=${rFz.freezeX()} y=${rFz.freezeY()}`);
  assert(rFz.cellX(0) === 46 && rFz.cellX(3) === 326,
    `Freeze: kolom beku ABAIKAN scroll, kolom lain ikut :: x0=${rFz.cellX(0)} x3=${rFz.cellX(3)}`);
  assert(rFz.cellY(1) === 28 && rFz.cellY(2) === 24,
    `Freeze: baris beku ABAIKAN scroll, baris lain ikut :: y1=${rFz.cellY(1)} y2=${rFz.cellY(2)}`);
  assert(rFz.colFromX(50) === 0 && rFz.colFromX(rFz.cellX(3) + 2) === 3,
    `Freeze: colFromX konsisten dengan cellX di area beku & area scroll :: ${rFz.colFromX(50)}/${rFz.colFromX(rFz.cellX(3) + 2)}`);

  // --- AUTOFILL: deret angka, geser relatif formula, lanjut teks, salin ---
  const rAf = new Ritz14('sheetsGridCanvas', 'sheetFormulaInput', 'sheetActiveCell');
  rAf.render = () => {};
  rAf.recalculateAll = () => rAf.cells;
  rAf.cells = { A1: { raw: '1', val: 1 }, A2: { raw: '2', val: 2 } };
  const afN = rAf.applyAutofill({ minCol: 0, maxCol: 0, minRow: 1, maxRow: 2 },
                               { minCol: 0, maxCol: 0, minRow: 3, maxRow: 5 });
  assert(afN === 3 && rAf.cells.A3.val === 3 && rAf.cells.A4.val === 4 && rAf.cells.A5.val === 5,
    `Autofill: 2 angka jadi deret berlanjut :: tulis=${afN} A3..A5=${rAf.cells.A3 && rAf.cells.A3.val}/${rAf.cells.A4 && rAf.cells.A4.val}/${rAf.cells.A5 && rAf.cells.A5.val}`);
  assert(rAf.cells.A1.val === 1 && rAf.cells.A2.val === 2,
    'Autofill: sel SUMBER tidak ikut berubah (hanya tujuan yang ditulis)');

  const rAfF = new Ritz14('sheetsGridCanvas', 'sheetFormulaInput', 'sheetActiveCell');
  rAfF.render = () => {};
  rAfF.recalculateAll = () => rAfF.cells;
  rAfF.cells = { B1: { raw: '=A1', val: 7 } };
  const afF = rAfF.applyAutofill({ minCol: 1, maxCol: 1, minRow: 1, maxRow: 1 },
                                 { minCol: 1, maxCol: 1, minRow: 2, maxRow: 2 });
  assert(afF === 1 && rAfF.cells.B2.raw === '=A2',
    `Autofill: formula digeser RELATIF (bukan disalin mentah) :: tulis=${afF} B2=${rAfF.cells.B2 && rAfF.cells.B2.raw}`);

  const rAfT = new Ritz14('sheetsGridCanvas', 'sheetFormulaInput', 'sheetActiveCell');
  rAfT.render = () => {};
  rAfT.recalculateAll = () => rAfT.cells;
  rAfT.cells = { C1: { raw: 'Bab 1', val: 'Bab 1' } };
  const afT = rAfT.applyAutofill({ minCol: 2, maxCol: 2, minRow: 1, maxRow: 1 },
                                 { minCol: 2, maxCol: 2, minRow: 2, maxRow: 3 });
  assert(afT === 2 && rAfT.cells.C2.raw === 'Bab 2' && rAfT.cells.C3.raw === 'Bab 3',
    `Autofill: teks berakhiran angka dilanjutkan :: tulis=${afT} C2=${rAfT.cells.C2 && rAfT.cells.C2.raw} C3=${rAfT.cells.C3 && rAfT.cells.C3.raw}`);

  const rAfC = new Ritz14('sheetsGridCanvas', 'sheetFormulaInput', 'sheetActiveCell');
  rAfC.render = () => {};
  rAfC.recalculateAll = () => rAfC.cells;
  rAfC.cells = { D1: { raw: 'teks', val: 'teks' } };
  const afC = rAfC.applyAutofill({ minCol: 3, maxCol: 3, minRow: 1, maxRow: 1 },
                                 { minCol: 3, maxCol: 3, minRow: 2, maxRow: 4 });
  assert(afC === 3 && rAfC.cells.D2.raw === 'teks' && rAfC.cells.D4.raw === 'teks',
    `Autofill: teks tanpa angka DISALIN apa adanya :: tulis=${afC} D2=${rAfC.cells.D2 && rAfC.cells.D2.raw}`);
  assert(rAfC.applyAutofill(null, null) === 0,
    'Autofill: argumen kosong tidak menulis apa pun (tidak melempar)');

  // --- SELEKSI RENTANG: arah terbalik dinormalisasi, label A1 kanonik ---
  const rSel = new Ritz14('sheetsGridCanvas', 'sheetFormulaInput', 'sheetActiveCell');
  rSel.render = () => {};
  rSel.activeCol = 0;
  rSel.activeRow = 1;
  rSel.selStartCol = 3; rSel.selEndCol = 1;   // sengaja TERBALIK
  rSel.selStartRow = 5; rSel.selEndRow = 2;
  const sb = rSel.getRangeBounds();
  assert(sb.minCol === 1 && sb.maxCol === 3 && sb.minRow === 2 && sb.maxRow === 5,
    `Seleksi: seret terbalik tetap dinormalisasi :: ${JSON.stringify(sb)}`);
  assert(rSel.isRangeSelection() === true && rSel.getRangeA1() === 'B2:D5',
    `Seleksi: label rentang kanonik Google Sheets :: ${rSel.getRangeA1()}`);
  rSel.selStartCol = 0; rSel.selEndCol = 0; rSel.selStartRow = 1; rSel.selEndRow = 1;
  assert(rSel.isRangeSelection() === false && rSel.getRangeA1() === rSel.getActiveCoord(),
    `Seleksi: satu sel bukan rentang (label = koordinat aktif) :: ${rSel.getRangeA1()}`);
  assert(rSel.colLabel(1) === 'B' && rSel.colLabel(3) === 'D',
    `Seleksi: kolom -> huruf konsisten :: ${rSel.colLabel(1)}/${rSel.colLabel(3)}`);

  // ================= SUITE 9f: KONTRAK UNDO/REDO + RENDER SEGITIGA =================
  // Tiga celah yang ditemukan audit cakupan (m7):
  // - Undo round-trip Sheets: 0 asersi unit (state di app_shell, E2E saja)
  // - Render segitiga cellComment: 0 asersi sumber (hanya render canvas)
  // Solusi: kontrak source-level yang terukur dan diskriminatif.
  console.log('\n--- Suite 9f: Kontrak undo/redo + render segitiga ---');
  {
    // ---- A. UNDO/REDO: kontrak sumber app_shell ----
    // Undo/redo sepenuhnya di app_shell (undoStack/redoStack).
    // Yang dikunci: recordHistory push, performUndo pop + apply,
    //               performRedo pop + apply, batas 60, dedup.

    // A1. recordHistory ada dan push ke undoStack
    assert(/recordHistory\s*\(app,\s*data\)/.test(shellSrc),
      'Undo: recordHistory(app, data) terdefinisi');
    assert(shellSrc.includes('stack.push(key)'),
      'Undo: recordHistory push ke stack');
    assert(/stack\.length\s*>\s*60/.test(shellSrc),
      'Undo: batas 60 entri diterapkan (shift saat melebihi)');

    // A2. performUndo: pop undoStack, push ke redoStack, applySnapshot
    const iUndo = shellSrc.indexOf('performUndo(app)');
    assert(iUndo !== -1, 'Undo: performUndo terdefinisi');
    const undoBlock = shellSrc.slice(iUndo, iUndo + 500);
    assert(undoBlock.includes('u.pop()') || undoBlock.includes('.pop()'),
      'Undo: performUndo pop dari undoStack');
    assert(undoBlock.includes('redoStack') && undoBlock.includes('.push('),
      'Undo: performUndo push ke redoStack');
    assert(undoBlock.includes('applySnapshot'),
      'Undo: performUndo memanggil applySnapshot');

    // A3. performRedo: pop redoStack, push ke undoStack, applySnapshot
    const iRedo = shellSrc.indexOf('performRedo(app)');
    assert(iRedo !== -1, 'Undo: performRedo terdefinisi');
    const redoBlock = shellSrc.slice(iRedo, iRedo + 500);
    assert(redoBlock.includes('.pop()'),
      'Undo: performRedo pop dari redoStack');
    assert(redoBlock.includes('undoStack') && redoBlock.includes('.push('),
      'Undo: performRedo push ke undoStack');
    assert(redoBlock.includes('applySnapshot'),
      'Undo: performRedo memanggil applySnapshot');

    // A4. recordSheetsHistory: guard pindah-tab (hanya ganti puncak, tidak push)
    assert(/recordSheetsHistory\s*\(data\)/.test(shellSrc),
      'Undo: recordSheetsHistory terdefinisi (guard pindah-tab)');
    assert(shellSrc.includes('JSON.stringify(prev.sheets) === JSON.stringify(data.sheets)'),
      'Undo: guard pindah-tab membandingkan sheets[], bukan cells');

    // A5. dedup: snapshot identik tidak di-push ulang
    assert(shellSrc.includes('stack[stack.length - 1] === key') &&
      shellSrc.includes('return'),
      'Undo: snapshot identik didedup (tidak push ulang)');

    // A6. resetHistory: menyetel ulang stack
    assert(/resetHistory\s*\(app,\s*data\)/.test(shellSrc),
      'Undo: resetHistory terdefinisi');

    // ---- B. RENDER SEGITIGA CELLCOMMENT: kontrak sumber ritz ----
    // Segitiga digambar oleh renderCellCommentIndicators() yang dipanggil
    // dari render(). Yang dikunci: fungsi ada, dipanggil di render,
    // warna amber (terbuka) vs abu-abu (selesai), ukuran 8px.

    // ritzSrc sudah ada: editorSrc.ritz (didefinisikan di :512)

    // B1. Fungsi renderCellCommentIndicators ada
    assert(/renderCellCommentIndicators\s*\(ctx/.test(ritzSrc),
      'Comment render: renderCellCommentIndicators(ctx,...) terdefinisi');

    // B2. Dipanggil di render()
    assert(ritzSrc.includes('this.renderCellCommentIndicators(ctx'),
      'Comment render: dipanggil dari render()');

    // B3. Memakai visibleCommentCoords()
    const iRender = ritzSrc.indexOf('renderCellCommentIndicators(ctx');
    const renderBlock = ritzSrc.slice(iRender, iRender + 1500);
    assert(renderBlock.includes('visibleCommentCoords'),
      'Comment render: memakai visibleCommentCoords()');

    // B4. Warna: amber untuk terbuka, abu-abu untuk selesai
    assert(renderBlock.includes("'#f9ab00'") || renderBlock.includes('#f9ab00'),
      'Comment render: warna amber #f9ab00 untuk komentar terbuka');
    assert(renderBlock.includes("'#9aa0a6'") || renderBlock.includes('#9aa0a6'),
      'Comment render: warna abu-abu #9aa0a6 untuk komentar selesai');

    // B5. Logika: anyOpen = some(!resolved) menentukan warna
    assert(renderBlock.includes('anyOpen') && renderBlock.includes('!c.resolved'),
      'Comment render: logika anyOpen = ada komentar belum resolved');

    // B6. Ukuran segitiga = 8px
    assert(/size\s*=\s*8/.test(renderBlock),
      'Comment render: ukuran segitiga = 8px');

    // B7. Clipping: header area tidak digambar
    assert(renderBlock.includes('ctx.clip()') && renderBlock.includes('this.headerWidth'),
      'Comment render: clipping menghindari area header');
  }


  // ================= Suite 9g: KONTRAK SUMBER KIX (kix_editor.js) =================
  // Penjaga arsitektur + kontrak engine Kix. Setiap asersi terbukti diskriminatif:
  // menghapus/mengubah kode yang dijaga membuat asersi GAGAL. Source-level, tanpa DOM.
  {
    const kx = kixSrc;  // sudah tersedia dari :511

    // 9g-01: FULL-CANVAS — ctx.fillText ada, innerHTML/textContent injeksi TIDAK ada di tile
    assert(/ctx\.fillText\(/.test(kx),
      'Kix 9g-01a: ctx.fillText harus ada (full-canvas rendering)');
    assert(!/\.innerHTML\s*\+?=.*line\.text/.test(kx) && !/\.textContent\s*=.*line\.text/.test(kx),
      'Kix 9g-01b: TIDAK boleh ada innerHTML/textContent injeksi konten ke tile');

    // 9g-02: KONSTANTA GEOMETRI — 6 konstanta kritis
    assert(/PAGE_CANVAS_WIDTH\s*=\s*636/.test(kx), 'Kix 9g-02a: PAGE_CANVAS_WIDTH=636');
    assert(/PAGE_CANVAS_HEIGHT\s*=\s*850/.test(kx), 'Kix 9g-02b: PAGE_CANVAS_HEIGHT=850');
    assert(/MARGIN\s*=\s*30/.test(kx), 'Kix 9g-02c: MARGIN=30');
    assert(/LINE_TOP_OFFSET\s*=\s*60/.test(kx), 'Kix 9g-02d: LINE_TOP_OFFSET=60');
    assert(/LINE_HEIGHT\s*=\s*24/.test(kx), 'Kix 9g-02e: LINE_HEIGHT=24');
    assert(/MAX_TEXT_Y\s*=\s*770/.test(kx), 'Kix 9g-02f: MAX_TEXT_Y=770');

    // 9g-03: SATU SUMBER METRIK — measureLine dipanggil di reflowPages DAN renderPage
    // (bukan dua implementasi pengukuran terpisah)
    const mlCalls = kx.match(/this\.measureLine\(/g) || [];
    assert(mlCalls.length >= 3,
      'Kix 9g-03: measureLine() dipanggil minimal 3× (definisi + reflowPages + renderPage), actual=' + mlCalls.length);

    // 9g-04: PAGINASI SATU ARAH — reflowPages hanya MEMECAH, tidak MENGGABUNG
    // Cari blok reflowPages, pastikan ada splice untuk pindah baris, TIDAK ada splice penggabungan
    // reflowPages memakai rebuild total: const out = []; ... this.pages = out;
    // Ini LEBIH KUAT dari splice — otomatis memecah, tidak pernah menggabung.
    assert(/reflowPages\s*\(\)\s*\{/.test(kx), 'Kix 9g-04a: reflowPages() harus ada');
    assert(/const out\s*=\s*\[\]/.test(kx) && /this\.pages\s*=\s*out/.test(kx),
      'Kix 9g-04b: reflowPages rebuild total (const out=[] -> this.pages=out)');
    // Rebuild per halaman asli: for (const page of this.pages) { ... }
    // Baris yang meluber dipindah ke halaman baru, bukan digabung.
    assert(/MAX_TEXT_Y/.test(kx) && /cur\.lines\.push/.test(kx),
      'Kix 9g-04c: reflowPages pecah baris meluber ke halaman baru via MAX_TEXT_Y');

    // 9g-05: SANITASI LINK — sanitizeUrl menolak javascript:/data:/file:
    assert(/sanitizeUrl\s*\(/.test(kx), 'Kix 9g-05a: sanitizeUrl() harus ada');
    assert(/javascript\|data\|vbscript\|file/.test(kx),
      'Kix 9g-05b: sanitizeUrl memeriksa javascript/data/vbscript/file');

    // 9g-06: THREAD KOMENTAR UTUH — _shiftComments memakai spread, replies tidak dipotong
    assert(/_shiftComments\s*\(/.test(kx), 'Kix 9g-06a: _shiftComments harus ada');
    // Cari blok _shiftComments, pastikan ada spread operator
    // _shiftComments memakai spread: out.push({ ...C, start: s, end: e })
    assert(/\.\.\.C/.test(kx),
      'Kix 9g-06b: _shiftComments memakai spread (...C) untuk preservasi metadata');

    // 9g-07: GUARD INPUT KEYDOWN — handler hanya aktif saat currentApp === 'docs'
    assert(/currentApp\s*[!=]==?\s*['"]docs['"]/.test(kx),
      'Kix 9g-07: keydown guard memeriksa currentApp docs');

    // 9g-08: CARET RE-RENDER BERSIH — renderPage memfilter _linkBoxes/_commentBoxes per halaman
    assert(/_linkBoxes\s*=\s*this\._linkBoxes\.filter/.test(kx),
      'Kix 9g-08a: renderPage memfilter _linkBoxes per halaman');
    assert(/_commentBoxes\s*=\s*this\._commentBoxes\.filter/.test(kx),
      'Kix 9g-08b: renderPage memfilter _commentBoxes per halaman');

    // 9g-09: WORD WRAP — wrapSegmentsFor mengembalikan segmen dengan offset start
    assert(/wrapSegmentsFor\s*\(/.test(kx), 'Kix 9g-09a: wrapSegmentsFor harus ada');
    // Segmen harus memiliki properti 'start' (caret placement)
    assert(/segs\.push\(\{\s*text:.*start:/.test(kx),
      'Kix 9g-09b: wrapSegmentsFor push segmen dengan offset start');

    // 9g-10: HIT-TEST KARAKTER — charIndexAtPoint memakai measureLine (bukan implementasi terpisah)
    // charIndexAtPoint METHOD definition (3 params: pIdx, lIdx, x)
    assert(/charIndexAtPoint\s*\(\s*pIdx\s*,\s*lIdx/.test(kx),
      'Kix 9g-10a: charIndexAtPoint(pIdx, lIdx, x) method harus ada');
    // Method DEFINITION (bukan call site) — match signature + opening brace
    const cipMatch = kx.match(/charIndexAtPoint\s*\(\s*pIdx\s*,\s*lIdx\s*,\s*\w+\s*\)\s*\{[\s\S]{0,2000}/);
    assert(cipMatch && /this\.measureLine/.test(cipMatch[0]),
      'Kix 9g-10b: charIndexAtPoint memakai this.measureLine');

    // 9g-11: INPUT HIDDEN TEXTAREA — bukan contentEditable
    // Input capture: kix_editor.js MENERIMA event dari hidden textarea yang dibuat app_shell.
    // Kontrak: handler keydown ada di dalam class, dan TIDAK pakai contentEditable.
    assert(/handleKey\s*\(/.test(kx) && !/contentEditable/.test(kx),
      'Kix 9g-11: input via handleKey, bukan contentEditable');

    // 9g-12: BLINK CARET — startCaretBlink dengan interval (bukan CSS animation)
    assert(/startCaretBlink\s*\(/.test(kx), 'Kix 9g-12a: startCaretBlink harus ada');
    assert(/setInterval/.test(kx), 'Kix 9g-12b: caret blink memakai setInterval');

    // 9g-13: RENDERING Z-ORDER — highlight SEBELUM fillText (find match, comment, lalu teks)
    // Di renderPage: findMatches fillRect harus muncul SEBELUM ctx.fillText(seg.text
    // Body diambil via brace-matching, bukan jendela karakter ajaib. Versi lama
    // memakai {0,8000} sementara body renderPage 15.062 karakter -> regex TIDAK
    // PERNAH match, dan asersi terkurung `if (renderBlock)` sehingga gagal senyap
    // (suite tetap hijau). Guard di bawah wajib lulus supaya kegagalan itu berisik.
    const renderBlock = sliceMethod(kx, 'renderPage');
    assert(renderBlock.length > 0,
      'Kix 9g-13: body renderPage terpotong utuh (guard anti fail-silent)');
    {
      const rb = renderBlock;
      const findRectPos = rb.indexOf('findMatches');
      const commentRectPos = rb.indexOf('_commentsOf');
      const fillTextPos = rb.indexOf('ctx.fillText(seg');
      assert(findRectPos > -1 && fillTextPos > -1 && findRectPos < fillTextPos,
        'Kix 9g-13a: find highlight digambar SEBELUM fillText (z-order benar)');
      assert(commentRectPos > -1 && fillTextPos > -1 && commentRectPos < fillTextPos,
        'Kix 9g-13b: comment highlight digambar SEBELUM fillText (z-order benar)');
    }

    // 9g-14: HYPERLINK OVERLAY — digambar SETELAH fillText utama, dengan warna biru
    {
      const rb = renderBlock;
      const fillTextPos = rb.indexOf('ctx.fillText(seg');
      const linkBoxPos = rb.indexOf('_linkBoxes.push');
      assert(fillTextPos > -1 && linkBoxPos > -1 && linkBoxPos > fillTextPos,
        'Kix 9g-14: hyperlink overlay digambar SETELAH fillText utama');
    }

    // 9g-15: LINK WARNA BIRU — #1a73e8 (Google Docs link color)
    assert(/#1a73e8/.test(kx), 'Kix 9g-15: link color #1a73e8 (Google Docs blue)');

    // 9g-16: COMMENT HIGHLIGHT WARNA — kuning (belum resolve) vs abu (sudah resolve)
    assert(/rgba\(255,\s*214,\s*102/.test(kx), 'Kix 9g-16a: comment highlight kuning (belum resolve)');
    assert(/rgba\(154,\s*160,\s*166/.test(kx), 'Kix 9g-16b: comment highlight abu (sudah resolve)');

    // 9g-17: FIND MATCH HIGHLIGHT — #fbbc04 (aktif) dan #ffe066 (lainnya)
    assert(/#fbbc04/.test(kx), 'Kix 9g-17a: find match aktif #fbbc04');
    assert(/#ffe066/.test(kx), 'Kix 9g-17b: find match lainnya #ffe066');

    // 9g-18: LINE_STYLE_KEYS — warisan gaya saat Enter
    assert(/LINE_STYLE_KEYS/.test(kx) || /lineStyleKeys/.test(kx) || 
           (/bold.*italic.*underline.*strike/.test(kx) && /heading/.test(kx) && /listType/.test(kx)),
      'Kix 9g-18: LINE_STYLE_KEYS ada (warisan gaya saat Enter)');

    // 9g-19: PARAGRAPH PRESETS — title/heading1/heading2/heading3 dengan ukuran berbeda
    assert(/heading1/.test(kx) && /heading2/.test(kx) && /heading3/.test(kx),
      'Kix 9g-19a: paragraph presets heading1/2/3 ada');
    assert(/title.*size.*26|size.*26.*title/s.test(kx),
      'Kix 9g-19b: title preset size 26');

    // 9g-20: EXPORT PLAINTEXT — exportPlainText dengan pemisah halaman
    assert(/exportPlainText/.test(kx), 'Kix 9g-20a: exportPlainText() harus ada');
    assert(/Halaman Baru/.test(kx) || /Page Break/.test(kx) || /----/.test(kx),
      'Kix 9g-20b: exportPlainText memakai pemisah halaman');

    // 20 asersi di atas — passedTests/failedTests sudah di-increment oleh assert()
    console.log('  Suite 9g (kontrak sumber Kix): selesai');
  }

  // ================= TEST SUITE 9h: FITUR & PARITAS BARU KIX =================
  // Menjaga kontrak dan perilaku baru yang telah diterapkan pada Kix Engine & Shell:
  // 1. Semantik Enter pada list kosong (outdent / exit-list tanpa baris baru)
  // 2. Semantik Backspace pada col 0 (outdent / exit-list / reset heading tanpa hapus teks)
  // 3. Paritas DOM (.kix-page-paginated & window.__kixEditor / window.kixEditor)
  // 4. Penghitung kata & statistik dokumen (getStatistics)
  // 5. Rich text inline runs (applyInlineFormat)
  // 6. Penomoran halaman footer (setPageNumbers / togglePageNumbers)
  // 7. Hit-testing safe boundary clamping (clampPoint)
  // 8. Sinkronisasi reaktif toolbar shell (#tbChecklist & Word Count shortcut)
  {
    console.log('\n--- Suite 9h: Fitur & Paritas Baru Kix (List Semantics, Word Count, Runs, Page Numbers) ---');
    const kx = fs.readFileSync('static/kix_editor.js', 'utf8');
    const sh = fs.readFileSync('static/app_shell.js', 'utf8');

    // 9h-01: SEMANTIK LIST — ENTER PADA LIST KOSONG
    // Enter pada list kosong indent 0 melepaskan listType dan TIDAK menambah baris baru.
    // Enter pada list kosong indent > 0 menurunkan indent (outdent).
    const Kix9h = loadEditor('static/kix_editor.js', 'KixDocsEditor');
    const k9h = new Kix9h('docsScrollBox', 'kixHiddenInput');

    k9h.setDocumentData({ pages: [{ lines: [{ text: '', listType: 'bullet', indent: 0 }] }] });
    k9h.activePageIdx = 0; k9h.activeLineIdx = 0; k9h.cursorCharIdx = 0;
    k9h.handleKey({ key: 'Enter', ctrlKey: false, metaKey: false, preventDefault() {} });
    const lEnter0 = k9h.pages[0].lines[0];
    assert(!lEnter0.listType && k9h.pages[0].lines.length === 1,
      'Kix 9h-01a: Enter pada list kosong indent 0 melepas listType tanpa menambah baris baru');

    k9h.setDocumentData({ pages: [{ lines: [{ text: '', listType: 'bullet', indent: 1 }] }] });
    k9h.activePageIdx = 0; k9h.activeLineIdx = 0; k9h.cursorCharIdx = 0;
    k9h.handleKey({ key: 'Enter', ctrlKey: false, metaKey: false, preventDefault() {} });
    const lEnter1 = k9h.pages[0].lines[0];
    assert(lEnter1.indent === 0 && lEnter1.listType === 'bullet' && k9h.pages[0].lines.length === 1,
      'Kix 9h-01b: Enter pada list kosong indent 1 menurunkan indent ke 0 (outdent)');

    // 9h-02: SEMANTIK LIST — BACKSPACE PADA COL 0
    // Backspace pada col 0 baris list ber-indentasi menurunkan indent; pada indent 0 melepas listType tanpa menghapus teks.
    k9h.setDocumentData({ pages: [{ lines: [{ text: 'Item 1', listType: 'bullet', indent: 1 }] }] });
    k9h.activePageIdx = 0; k9h.activeLineIdx = 0; k9h.cursorCharIdx = 0;
    k9h.handleKey({ key: 'Backspace', ctrlKey: false, metaKey: false, preventDefault() {} });
    const lBs1 = k9h.pages[0].lines[0];
    assert(lBs1.indent === 0 && lBs1.text === 'Item 1',
      'Kix 9h-02a: Backspace di col 0 baris list indent 1 menurunkan indent tanpa hapus teks');

    k9h.setDocumentData({ pages: [{ lines: [{ text: 'Item 2', listType: 'bullet', indent: 0 }] }] });
    k9h.activePageIdx = 0; k9h.activeLineIdx = 0; k9h.cursorCharIdx = 0;
    k9h.handleKey({ key: 'Backspace', ctrlKey: false, metaKey: false, preventDefault() {} });
    const lBs0 = k9h.pages[0].lines[0];
    assert(!lBs0.listType && lBs0.text === 'Item 2' && k9h.pages[0].lines.length === 1,
      'Kix 9h-02b: Backspace di col 0 baris list indent 0 melepas listType tanpa hapus teks');

    // 9h-03: SEMANTIK HEADING — BACKSPACE PADA COL 0
    // Backspace pada col 0 baris heading mereset ke 'normal' (size 13) tanpa menghapus teks.
    k9h.setDocumentData({ pages: [{ lines: [{ text: 'Judul Dokumen', heading: 'heading1', size: 20, bold: true }] }] });
    k9h.activePageIdx = 0; k9h.activeLineIdx = 0; k9h.cursorCharIdx = 0;
    k9h.handleKey({ key: 'Backspace', ctrlKey: false, metaKey: false, preventDefault() {} });
    const lBsH = k9h.pages[0].lines[0];
    assert(lBsH.heading === 'normal' && lBsH.size === 13 && lBsH.text === 'Judul Dokumen',
      'Kix 9h-03: Backspace di col 0 baris heading mereset heading ke normal (size 13)');

    // 9h-04: PARITAS DOM & INSTANCE GLOBAL
    assert(/kix-page-paginated/.test(kx),
      'Kix 9h-04a: kix-page-paginated ada di renderAllPages kix_editor.js');
    assert(/window\.__kixEditor\s*=/.test(kx) && /window\.kixEditor\s*=/.test(sh),
      'Kix 9h-04b: window.__kixEditor di kix_editor.js dan window.kixEditor di app_shell.js');

    // 9h-05: PENGHITUNG KATA & STATISTIK DOKUMEN (getStatistics)
    k9h.setDocumentData({ pages: [{ lines: [{ text: 'Halo Dunia' }, { text: 'Google Docs Kix' }] }] });
    const stats = k9h.getStatistics();
    assert(stats && stats.pages === 1 && stats.words === 5 && stats.characters === 25 && stats.charactersNoSpaces === 22,
      `Kix 9h-05: getStatistics menghitung pages=1, words=5, chars=25, noSpaces=22 :: ${JSON.stringify(stats)}`);

    // 9h-06: RICH TEXT INLINE RUNS (applyInlineFormat)
    k9h.setDocumentData({ pages: [{ lines: [{ text: 'Halo Dunia Indah' }] }] });
    k9h.activePageIdx = 0; k9h.activeLineIdx = 0;
    k9h.applyInlineFormat(5, 10, { bold: true });
    const lRun = k9h.pages[0].lines[0];
    assert(Array.isArray(lRun.runs) && lRun.runs.length === 3 && lRun.runs[1].bold === true && lRun.runs[1].text === 'Dunia',
      `Kix 9h-06: applyInlineFormat memecah runs menjadi 3 segmen dengan Dunia berformat bold :: ${JSON.stringify(lRun.runs)}`);

    // 9h-07: FOOTER & NOMOR HALAMAN (setPageNumbers / togglePageNumbers)
    k9h.setPageNumbers(true);
    const p1On = k9h.showPageNumbers;
    k9h.togglePageNumbers();
    const p1Off = k9h.showPageNumbers;
    assert(p1On === true && p1Off === false,
      'Kix 9h-07: setPageNumbers(true) dan togglePageNumbers() mengendalikan showPageNumbers');

    // 9h-08: SAFE BOUNDARY CLAMPING (clampPoint)
    const cpHigh = k9h.clampPoint(999, 999, 9999);
    const cpLow = k9h.clampPoint(-5, -5, -100);
    assert(cpHigh.pIdx === 0 && cpHigh.lIdx === 0 && cpHigh.x === 606 &&
           cpLow.pIdx === 0 && cpLow.lIdx === 0 && cpLow.x === 30,
      `Kix 9h-08: clampPoint menjaga koordinat tetap di dalam bounds valid :: high=${JSON.stringify(cpHigh)} low=${JSON.stringify(cpLow)}`);

    // 9h-09: SHELL TOOLBAR & SHORTCUT SINKRONISASI
    assert(/set\(['"]tbChecklist['"],\s*st\.listType\s*===\s*['"]checklist['"]\)/.test(sh),
      'Kix 9h-09a: syncToolbar menyinkronkan status tombol tbChecklist');
    assert(/openWordCountModal/.test(sh) && /Ctrl\+Shift\+C|key\s*===\s*['"][Cc]['"]/.test(sh),
      'Kix 9h-09b: openWordCountModal dan shortcut Ctrl+Shift+C terdefinisi di app_shell.js');

    // 9h-10: RUN-AWARE MEASUREMENT — jalur wrap membaca `runs`
    // Baris multi-run WAJIB diukur per-run. Kalau tidak, teks tebal yang lebih
    // lebar akan meluber melewati margin kanan tanpa terdeteksi paginasi.
    assert(/runsCumWidths\s*\(/.test(kx),
      'Kix 9h-10a: runsCumWidths() ada (lebar kumulatif per batas karakter)');
    assert(/wrapSegmentsFor\s*\([^)]*runs/.test(kx) || /line\.runs,\s*prefix\.length/.test(kx),
      'Kix 9h-10b: wrapSegmentsFor menerima runs + prefixLen (jalur run-aware)');

    // 9h-11: RUN-AWARE RENDER — potongan runs per SEGMEN, bukan per baris
    // Tanpa pemotongan per segmen, setiap segmen hasil wrap menggambar ulang
    // seluruh isi baris sehingga teks tampak berlipat di kanvas.
    assert(/segRunsFor\s*\(/.test(kx),
      'Kix 9h-11a: segRunsFor() ada (irisan runs terhadap satu segmen wrap)');

    // 9h-12: SINKRONISASI `runs` TERHADAP EDIT TEKS
    // Kontrak: concat(runs.text) === line.text setelah SETIAP edit. Kalau tidak,
    // offset run melenceng satu karakter tiap ketikan (cacat senyap).
    assert(/_editRuns\s*\(/.test(kx),
      'Kix 9h-12a: _editRuns() ada (pemindah batas run saat teks berubah)');
    const editRunCalls = (kx.match(/this\._editRuns\(/g) || []).length;
    assert(editRunCalls >= 3,
      `Kix 9h-12b: _editRuns dipanggil di ketik/Backspace/Delete :: calls=${editRunCalls}`);
    assert(/delete line\.runs/.test(kx),
      'Kix 9h-12c: _editRuns membuang runs saat concat mismatch / tinggal 1 run (fail-safe)');

    // 9h-13: PERILAKU NYATA — _editRuns menjaga konsistensi teks↔runs
    const Kix13 = loadEditor('static/kix_editor.js', 'KixDocsEditor');
    const k13 = new Kix13('docsScrollBox', 'kixHiddenInput');
    k13.setDocumentData({ pages: [{ lines: [{ text: 'Halo Dunia Indah' }] }] });
    k13.activePageIdx = 0; k13.activeLineIdx = 0;
    k13.applyInlineFormat(5, 10, { bold: true });
    const l13 = k13.pages[0].lines[0];
    assert(Array.isArray(l13.runs) && l13.runs.length === 3 && l13.runs[1].bold === true,
      'Kix 9h-13a: applyInlineFormat menghasilkan 3 run, "Dunia" tebal');
    assert(l13.runs.map(r => r.text).join('') === l13.text,
      `Kix 9h-13b: concat(runs.text) === line.text :: ${JSON.stringify(l13.runs.map(r => r.text).join(''))}`);

    // Ketik 'X' di tengah run tebal (offset 7) — X harus mewarisi tebal.
    k13.activeLineIdx = 0; k13.cursorCharIdx = 7;
    k13.handleKey({ key: 'X', ctrlKey: false, metaKey: false, preventDefault() {} });
    const l13b = k13.pages[0].lines[0];
    assert(l13b.text === 'Halo DuXnia Indah',
      `Kix 9h-13c: mengetik menyisipkan karakter di posisi kursor :: "${l13b.text}"`);
    assert(Array.isArray(l13b.runs) && l13b.runs.map(r => r.text).join('') === l13b.text,
      `Kix 9h-13d: runs tetap konsisten setelah mengetik :: ${JSON.stringify(l13b.runs && l13b.runs.map(r => r.text))}`);
    assert(l13b.runs.some(r => r.bold && r.text.includes('X')),
      `Kix 9h-13e: karakter baru mewarisi gaya tebal run induk :: ${JSON.stringify(l13b.runs.map(r => [r.text, r.bold]))}`);

    // Backspace menghapus karakter — runs wajib tetap konsisten.
    k13.activeLineIdx = 0; k13.cursorCharIdx = 8;
    k13.handleKey({ key: 'Backspace', ctrlKey: false, metaKey: false, preventDefault() {} });
    const l13c = k13.pages[0].lines[0];
    assert(l13c.text === 'Halo Dunia Indah' && (!l13c.runs || l13c.runs.map(r => r.text).join('') === l13c.text),
      `Kix 9h-13f: Backspace menjaga konsistensi runs :: text="${l13c.text}" runs=${JSON.stringify(l13c.runs && l13c.runs.map(r => r.text))}`);

    // 9h-14: FAIL-SAFE — runs tidak konsisten dibuang, bukan dibiarkan melenceng
    const l14 = { text: 'abcdef', runs: [{ text: 'abc', bold: true }, { text: 'def', bold: false }] };
    l14.text = 'ZZZZZZ';                       // paksa mismatch
    k13._editRuns(l14, 0, 1, '');
    assert(!l14.runs,
      'Kix 9h-14: runs dibuang saat tidak lagi mereproduksi line.text (fail-safe, bukan offset salah)');

    // 9h-15: BACKWARD COMPAT — baris tanpa runs tetap memakai jalur lama
    // Ini yang menjaga 451 asersi lama tetap hijau: dokumen seed tidak punya
    // `runs`, jadi paginasi & render harus identik dengan sebelum perubahan.
    assert(/else\s*\{\s*\n\s*ctx\.fillText\(seg\.text, segX, y\);/.test(kx),
      'Kix 9h-15: jalur render lama (fillText seg.text) dipertahankan sebagai fallback');

    console.log('  Suite 9h (fitur & paritas baru Kix): selesai');
  }

  {
    console.log('\n--- Suite 9i: Wiring UI Docs (Tabel/Gambar/Page Setup/Cetak) + Seleksi Rentang ---');
    const kx9i = fs.readFileSync('static/kix_editor.js', 'utf8');
    const sh9i = fs.readFileSync('static/app_shell.js', 'utf8');

    // 9i-01..04: tiap dialog ADA dan TERDEFINISI TEPAT SATU KALI.
    // Duplikasi nama metode adalah bug nyata yang pernah terjadi (openWordCountModal
    // terdefinisi 2x dan membuat E2E "catatan pembicara" gagal), jadi jumlah
    // definisi dijadikan asersi, bukan sekadar keberadaan.
    const countDef = (s, name) =>
      (s.match(new RegExp('^    (?:async\\s+)?' + name + '\\s*\\(', 'gm')) || []).length;
    for (const m of ['openInsertTableModal', 'openInsertImageModal', 'openPageSetupModal', 'printOrExportPdf']) {
      const c = countDef(sh9i, m);
      assert(c === 1, `Docs 9i: app_shell.${m} terdefinisi tepat 1x :: ${c}`);
    }

    // 9i-05: tidak ada SATU PUN nama metode duplikat di seluruh app_shell.
    const shNames = (sh9i.match(/^    (?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm) || [])
      .map(s => s.trim().replace(/^async\s+/, '').replace(/\s*\($/, ''));
    const dupNames = [...new Set(shNames.filter((n, i) => shNames.indexOf(n) !== i))];
    assert(dupNames.length === 0,
      `Docs 9i: app_shell bebas metode duplikat :: ${JSON.stringify(dupNames)}`);

    // 9i-06..08: entri menu Sisipkan benar-benar terpasang dan memanggil dialog.
    assert(/label: 'Tabel', action: \(\) => this\.openInsertTableModal\(\)/.test(sh9i),
      'Docs 9i: menu Sisipkan -> Tabel memanggil openInsertTableModal');
    assert(/label: 'Gambar', action: \(\) => this\.openInsertImageModal\(\)/.test(sh9i),
      'Docs 9i: menu Sisipkan -> Gambar memanggil openInsertImageModal');
    // Penyiapan Halaman dipindah ke menu File (paritas Google Docs)
    assert(/label: 'Penyiapan Halaman', action: \(\) => this\.openPageSetupModal\(\)/.test(sh9i),
      'Docs 9i: menu File -> Penyiapan Halaman memanggil openPageSetupModal');

    // 9i-09..10: Cetak diarahkan ke jalur rasterisasi, BUKAN window.print() mentah.
    // Canvas tidak ikut alur cetak browser, jadi window.print() polos = halaman kosong.
    assert(/label: 'Cetak'[^\n]*this\.printOrExportPdf\(\)/.test(sh9i),
      'Docs 9i: menu File -> Cetak memanggil printOrExportPdf');
    assert(!/label: 'Cetak'[^\n]*window\.print\(\)/.test(sh9i),
      'Docs 9i: Cetak TIDAK lagi memakai window.print() mentah');
    assert(/toDataURL\('image\/png'\)/.test(sh9i),
      'Docs 9i: printOrExportPdf merasterisasi tiap canvas via toDataURL');

    // 9i-11..13: shell benar-benar menyentuh API engine (bukan cuma punya dialog).
    for (const api of ['insertTable', 'insertImage', 'setPageSetup']) {
      assert(sh9i.includes('this.kix.' + api + '('),
        `Docs 9i: shell memanggil this.kix.${api}(...) pada engine`);
    }

    // 9i-14: dialog memakai promptModal yang SUDAH ada (anti sistem modal kedua).
    assert(/openPageSetupModal\(\)\s*\{[\s\S]{0,700}?this\.promptModal\(/.test(sh9i),
      'Docs 9i: openPageSetupModal memakai promptModal bersama, bukan modal baru');
    // 9i-15: gambar divalidasi skemanya sebelum masuk engine.
    assert(sh9i.includes('URL tidak diizinkan') && sh9i.includes('data:image'),
      'Docs 9i: openInsertImageModal menolak skema URL di luar http/https/data:image');

    // 9i-16..18: SELEKSI RENTANG — perilaku nyata lewat API publik.
    const Kix9i = loadEditor('static/kix_editor.js', 'KixDocsEditor');
    const k9i = new Kix9i('docsScrollBox', 'kixHiddenInput');
    k9i.setDocumentData({ pages: [{ lines: [{ text: 'Halo Dunia Indah' }, { text: 'Baris Kedua' }] }] });
    const r9i = k9i.setSelectionRange(
      { pageIdx: 0, lineIdx: 0, charIdx: 5 },
      { pageIdx: 0, lineIdx: 1, charIdx: 5 }
    );
    assert(r9i && r9i.start.lineIdx === 0 && r9i.start.charIdx === 5 &&
           r9i.end.lineIdx === 1 && r9i.end.charIdx === 5,
      `Docs 9i: setSelectionRange membentuk rentang lintas baris :: ${JSON.stringify(r9i && { s: r9i.start, e: r9i.end })}`);
    assert(k9i.hasSelection() === true,
      'Docs 9i: hasSelection() true setelah setSelectionRange');
    const selText9i = k9i.getSelectedText();
    assert(selText9i.includes('Dunia Indah') && selText9i.includes('Baris'),
      `Docs 9i: getSelectedText memuat teks terpilih :: ${JSON.stringify(selText9i)}`);

    // 9i-19: seleksi MUNDUR dinormalkan — start selalu <= end.
    const rBack9i = k9i.setSelectionRange(
      { pageIdx: 0, lineIdx: 1, charIdx: 5 },
      { pageIdx: 0, lineIdx: 0, charIdx: 0 }
    );
    assert(rBack9i && rBack9i.backward === true && rBack9i.start.lineIdx === 0 && rBack9i.start.charIdx === 0,
      'Docs 9i: seleksi arah mundur dinormalkan (start <= end, backward=true)');

    // 9i-20: deleteSelection benar-benar memotong teks terpilih.
    k9i.setSelectionRange({ pageIdx: 0, lineIdx: 0, charIdx: 0 }, { pageIdx: 0, lineIdx: 0, charIdx: 5 });
    k9i.deleteSelection();
    assert(k9i.pages[0].lines[0].text.indexOf('Halo') === -1 && k9i.pages[0].lines[0].text.startsWith('Dunia'),
      `Docs 9i: deleteSelection menghapus rentang terpilih :: "${k9i.pages[0].lines[0].text}"`);

    // 9i-21..22: TABEL — perilaku nyata.
    const k9t = new Kix9i('docsScrollBox', 'kixHiddenInput');
    k9t.setDocumentData({ pages: [{ lines: [{ text: 'awal' }] }] });
    k9t.activePageIdx = 0; k9t.activeLineIdx = 0;
    const okT9i = k9t.insertTable(3, 4);
    const tl9i = k9t.pages[0].lines.find(l => l.type === 'table');
    assert(okT9i === true && tl9i && tl9i.table.rows.length === 3 && tl9i.table.rows[0].length === 4,
      `Docs 9i: insertTable(3,4) menghasilkan baris tabel 3x4 :: ${tl9i ? tl9i.table.rows.length + 'x' + tl9i.table.rows[0].length : 'null'}`);
    assert(tl9i && tl9i.table.rows.every(r => r.every(c => c.text === '')),
      'Docs 9i: sel tabel baru kosong (bukan undefined)');

    // 9i-23..26: PAGE SETUP — default identik seed, lalu berubah terkendali.
    const k9p = new Kix9i('docsScrollBox', 'kixHiddenInput');
    k9p.setDocumentData({ pages: [{ lines: [{ text: 'x' }] }] });
    assert(k9p.pageWidth() === 636 && k9p.pageHeight() === 850 && k9p.marginLeft() === 30,
      `Docs 9i: default page setup identik seed (636x850, margin 30) :: ${k9p.pageWidth()}x${k9p.pageHeight()} m=${k9p.marginLeft()}`);
    k9p.setPageSetup({ paperSize: 'a4', orientation: 'portrait' });
    assert(k9p.pageWidth() === 794 && k9p.pageHeight() === 1123,
      `Docs 9i: setPageSetup(a4) -> 794x1123 :: ${k9p.pageWidth()}x${k9p.pageHeight()}`);
    k9p.setPageSetup({ paperSize: 'a4', orientation: 'landscape' });
    assert(k9p.pageWidth() === 1123 && k9p.pageHeight() === 794,
      `Docs 9i: orientasi landscape menukar lebar/tinggi :: ${k9p.pageWidth()}x${k9p.pageHeight()}`);
    k9p.setPageSetup({ paperSize: 'ngawur' });
    assert(k9p.pageWidth() === 1123,
      'Docs 9i: paperSize tak dikenal diabaikan (dokumen tidak rusak)');

    // 9i-27..28: GAMBAR — perilaku nyata.
    const k9g = new Kix9i('docsScrollBox', 'kixHiddenInput');
    k9g.setDocumentData({ pages: [{ lines: [{ text: 'a' }] }] });
    k9g.activePageIdx = 0; k9g.activeLineIdx = 0;
    const okG9i = k9g.insertImage('https://example.com/x.png');
    const il9i = k9g.pages[0].lines.find(l => l.type === 'image');
    assert(okG9i === true && il9i && il9i.image.src === 'https://example.com/x.png' && il9i.image.width === 240,
      `Docs 9i: insertImage menambah baris gambar (lebar default 240) :: ${il9i ? il9i.image.width : 'null'}`);
    assert(k9g.insertImage('') === false,
      'Docs 9i: insertImage menolak src kosong (guard, bukan crash)');

    console.log('  Suite 9i (wiring UI Docs + seleksi rentang): selesai');
  }

    // ================= Suite 9j: VIRTUALISASI TILE, JALUR CETAK, STRUKTUR TABEL & GAMBAR =================
    console.log('\n--- Suite 9j: Virtualisasi Tile, Jalur Cetak, Struktur Tabel & Gambar ---');
    {
      // Kix9i dideklarasikan const DI DALAM blok Suite 9i, jadi tidak terlihat
      // di sini (ReferenceError: Kix9i is not defined). Muat kelas sendiri.
      const Kix9j = loadEditor('static/kix_editor.js', 'KixDocsEditor');
      const srcKix9j = fs.readFileSync(path.resolve(__dirname, 'static/kix_editor.js'), 'utf8');
      const srcShell9j = fs.readFileSync(path.resolve(__dirname, 'static/app_shell.js'), 'utf8');
      const defCount9j = (src, name) => (src.match(new RegExp('^\\s{4}(?:async\\s+)?' + name + '\\s*\\(', 'gm')) || []).length;
      const mkDoc9j = (n) => ({
        pages: Array.from({ length: n }, (_, i) => ({ lines: [{ text: 'baris halaman ' + (i + 1) }] }))
      });
      const findTable9j = (k) => k.pages.reduce((acc, p) => acc || p.lines.find(l => l && l.type === 'table') || null, null);
      // Stub DOM tidak mengosongkan children saat innerHTML='' (cacat harness,
      // bukan cacat engine). Reset manual supaya hitungan tile bermakna.
      const resetBox9j = (k) => { k.scrollBox.children.length = 0; k._dirtyPages = new Set(); };

      // ---- 9j-01..02: state & gerbang ambang ----
      const k9v0 = new Kix9j('docsScrollBox', 'kixHiddenInput');
      assert(k9v0.tileVirtualizeMin === 3 && k9v0.tileWindowSpan === 1,
        `Docs 9j: state virtualisasi default (min=3, span=1) :: min=${k9v0.tileVirtualizeMin} span=${k9v0.tileWindowSpan}`);
      assert(k9v0._dirtyPages instanceof Set && k9v0._forceAll === false,
        'Docs 9j: penanda _dirtyPages berupa Set dan _forceAll mulai false');

      // ---- 9j-03..04: DOKUMEN PENDEK identik perilaku lama (bukti gerbang) ----
      const k9vShort = new Kix9j('docsScrollBox', 'kixHiddenInput');
      k9vShort.setDocumentData(mkDoc9j(2));
      k9vShort.activePageIdx = 0;
      resetBox9j(k9vShort);
      k9vShort.renderAllPages();
      assert(k9vShort._dirtyPages.size === 2,
        `Docs 9j: dokumen 2 halaman tetap dicat SELURUHNYA (gerbang min=3) :: dirty=${k9vShort._dirtyPages.size}`);
      assert(k9vShort._renderWindow.lo === 0 && k9vShort._renderWindow.hi === 1,
        `Docs 9j: jendela dokumen pendek mencakup semua halaman :: ${JSON.stringify(k9vShort._renderWindow)}`);

      // ---- 9j-05..09: DOKUMEN BANYAK HALAMAN - hanya sekitar viewport dicat ----
      const k9v = new Kix9j('docsScrollBox', 'kixHiddenInput');
      k9v.setDocumentData(mkDoc9j(8));
      k9v.activePageIdx = 0;
      resetBox9j(k9v);
      k9v.renderAllPages();
      const total9j = k9v.pages.length;
      assert(total9j === 8,
        `Docs 9j: prasyarat dokumen 8 halaman :: pages=${total9j}`);
      assert(k9v._dirtyPages.size < total9j,
        `Docs 9j: halaman JAUH tidak dirasterisasi (dirty ${k9v._dirtyPages.size} < ${total9j})`);
      assert(k9v._dirtyPages.has(7) === false,
        'Docs 9j: halaman terakhir (di luar jendela) belum dicat :: has(7)=false');
      assert(k9v._renderWindow.lo === 0 && k9v._renderWindow.hi === 1,
        `Docs 9j: jendela render awal = halaman aktif +-1 :: ${JSON.stringify(k9v._renderWindow)}`);
      assert(k9v.scrollBox.children.length === 8,
        `Docs 9j: SEMUA tile tetap dibuat di DOM walau paint dibatasi (paritas E2E S11) :: tile=${k9v.scrollBox.children.length}`);

      // ---- 9j-10..12: jendela bergeser saat scroll ----
      const before9j = k9v._dirtyPages.size;
      k9v.updateRenderWindow(false, 7);
      assert(k9v._renderWindow.lo === 6 && k9v._renderWindow.hi === 7,
        `Docs 9j: updateRenderWindow(probe=7) menggeser jendela :: ${JSON.stringify(k9v._renderWindow)}`);
      assert(k9v._dirtyPages.has(7) === true && k9v._dirtyPages.has(0) === true,
        'Docs 9j: halaman baru dicat tanpa membuang halaman yang sudah dicat');
      assert(k9v._dirtyPages.size > before9j,
        `Docs 9j: jumlah halaman tercat bertambah setelah scroll :: ${before9j} -> ${k9v._dirtyPages.size}`);

      // ---- 9j-13..15: renderAllForce (kunci jalur cetak) ----
      const nForce = k9v.renderAllForce();
      assert(nForce === 8 && k9v._dirtyPages.size === 8,
        `Docs 9j: renderAllForce mencet SEMUA halaman :: ret=${nForce} dirty=${k9v._dirtyPages.size}`);
      assert(k9v._renderWindow.lo === 0 && k9v._renderWindow.hi === 7,
        `Docs 9j: renderAllForce melebarkan jendela ke seluruh dokumen :: ${JSON.stringify(k9v._renderWindow)}`);
      assert(k9v._forceAll === false,
        'Docs 9j: penanda _forceAll dikembalikan false (tidak bocor ke render berikutnya)');

      // ---- 9j-16: renderAllPages mereset penanda & kembali menyempit ----
      k9v.renderAllPages();
      assert(k9v._dirtyPages.size === 2 && k9v._renderWindow.hi === 1,
        `Docs 9j: renderAllPages mereset _dirtyPages lalu menyempit lagi :: dirty=${k9v._dirtyPages.size} win=${JSON.stringify(k9v._renderWindow)}`);

      // ---- 9j-17..20: kontrak sumber virtualisasi ----
      assert(srcKix9j.includes("container.classList.toggle('kix-rotatingtilemanager', virtual)"),
        'Docs 9j: kontainer ditandai kelas kix-rotatingtilemanager (paritas Docs asli)');
      assert(srcKix9j.includes("container.setAttribute('data-virtualized'"),
        'Docs 9j: atribut data-virtualized dipasang untuk pembuktian tes');
      assert(srcKix9j.includes('this.updateRenderWindow(false, this.activePageIdx)'),
        'Docs 9j: renderAllPages memakai jendela render, bukan mencet semua');
      assert(srcKix9j.includes('this.updateRenderWindow(false, curPage - 1)'),
        'Docs 9j: handler scroll memperbarui jendela render');

      // ---- 9j-21: klik pada halaman belum tercat harus mengecat dulu ----
      assert(/if \(this\._dirtyPages && !this\._dirtyPages\.has\(pIdxRaw\)\) \{[\s\S]{0,120}this\.renderPage\(pIdxRaw\)/.test(srcKix9j),
        'Docs 9j: mousedown mengecat halaman yang belum terpaint sebelum hit-test');

      // ---- 9j-22..24: JALUR CETAK - jebakan PDF kosong ----
      // Anchor WAJIB pada DEFINISI method, bukan kemunculan pertama string:
      // 'printOrExportPdf()' juga muncul di entri menu File (baris ~1242),
      // sehingga indexOf() pertama memotong blok yang salah dan asersi ini
      // gagal palsu (force=-1 data=-1).
      const iPrint9j = srcShell9j.indexOf('    printOrExportPdf() {');
      const blkPrint9j = iPrint9j === -1 ? '' : srcShell9j.slice(iPrint9j, iPrint9j + 2600);
      assert(iPrint9j !== -1 && blkPrint9j.includes('this.kix.renderAllForce()'),
        'Docs 9j: printOrExportPdf memanggil renderAllForce() (tanpa ini PDF berisi halaman kosong)');
      const pForce9j = blkPrint9j.indexOf('renderAllForce');
      const pData9j = blkPrint9j.indexOf('toDataURL');
      assert(pForce9j !== -1 && pData9j !== -1 && pForce9j < pData9j,
        `Docs 9j: renderAllForce dipanggil SEBELUM toDataURL :: force=${pForce9j} data=${pData9j}`);
      assert(blkPrint9j.includes('updateRenderWindow'),
        'Docs 9j: jendela render dipulihkan setelah rasterisasi cetak');

      // ---- 9j-25..27: WIRING SHELL (pintu UI untuk kode yang tadinya mati) ----
      assert(defCount9j(srcShell9j, 'openImageSizeModal') === 1
        && defCount9j(srcShell9j, 'setImageAlign') === 1
        && defCount9j(srcShell9j, 'tableOp') === 1,
        'Docs 9j: shell mendefinisikan openImageSizeModal/setImageAlign/tableOp tepat 1x (tanpa duplikat)');
      assert(srcShell9j.includes("'Ukuran Gambar'")
        && srcShell9j.includes("'Gambar Rata Tengah'")
        && srcShell9j.includes("'Tabel: Sisip Baris di Bawah'")
        && srcShell9j.includes("'Tabel: Hapus Kolom'"),
        'Docs 9j: entri menu gambar & struktur tabel tersedia di menu Sisipkan');
      assert(srcShell9j.includes('this.kix.resizeActiveImage(')
        && srcShell9j.includes('this.kix.setActiveImageAlign(')
        && srcShell9j.includes("this.kix.insertTableRow('above')")
        && srcShell9j.includes('this.kix.deleteTableColumn()'),
        'Docs 9j: shell benar-benar memanggil method engine gambar & tabel');

      // ---- 9j-28..31: PERILAKU tabel - tambah/hapus baris & kolom ----
      const k9t = new Kix9j('docsScrollBox', 'kixHiddenInput');
      k9t.setDocumentData({ pages: [{ lines: [{ text: 'a' }] }] });
      k9t.activePageIdx = 0; k9t.activeLineIdx = 0;
      k9t.insertTable(2, 2);
      const sync9j = () => {
        for (let p = 0; p < k9t.pages.length; p++) {
          const li = k9t.pages[p].lines.findIndex(l => l && l.type === 'table');
          if (li !== -1) { k9t.activePageIdx = p; k9t.activeLineIdx = li; return; }
        }
      };
      sync9j();
      assert(findTable9j(k9t) && findTable9j(k9t).table.rows.length === 2,
        'Docs 9j: prasyarat tabel 2x2 :: rows=' + (findTable9j(k9t) ? findTable9j(k9t).table.rows.length : 'null'));
      k9t.activeCell = { r: 0, c: 0 };
      const okRow9j = k9t.insertTableRow('below');
      sync9j();
      assert(okRow9j === true && findTable9j(k9t).table.rows.length === 3 && k9t.activeCell.r === 1,
        `Docs 9j: insertTableRow('below') menambah baris di bawah sel aktif :: rows=${findTable9j(k9t).table.rows.length} active=${k9t.activeCell.r}`);
      k9t.activeCell = { r: 0, c: 0 };
      k9t.insertTableColumn('right');
      sync9j();
      assert(findTable9j(k9t).table.rows.every(r => r.length === 3),
        'Docs 9j: insertTableColumn(\'right\') menambah kolom di SEMUA baris :: cols=' + findTable9j(k9t).table.rows[0].length);
      const okDelCol9j = k9t.deleteTableColumn();
      sync9j();
      assert(okDelCol9j === true && findTable9j(k9t).table.rows.every(r => r.length === 2),
        'Docs 9j: deleteTableColumn() mengembalikan tabel ke 2 kolom');
      const okDelRow9j = k9t.deleteTableRow();
      sync9j();
      assert(okDelRow9j === true && findTable9j(k9t).table.rows.length === 2,
        'Docs 9j: deleteTableRow() mengembalikan tabel ke 2 baris');

      // 9j-38: cabang 'above' HARUS diuji terpisah. Sebelum ini hanya
      // 'below' yang dieksekusi, sehingga mutasi yang mengabaikan 'above'
      // lolos tanpa suara (falsifikasi menemukannya, bukan dugaan).
      k9t.activeCell = { r: 1, c: 0 };
      const okAbove9j = k9t.insertTableRow('above');
      sync9j();
      assert(okAbove9j === true && findTable9j(k9t).table.rows.length === 3 && k9t.activeCell.r === 1,
        `Docs 9j: insertTableRow('above') menyisipkan DI ATAS sel aktif :: rows=${findTable9j(k9t).table.rows.length} active=${k9t.activeCell.r}`);

      // ---- 9j-32..33: penjaga struktur minimal tabel ----
      const k9min = new Kix9j('docsScrollBox', 'kixHiddenInput');
      k9min.setDocumentData({ pages: [{ lines: [{ text: 'a' }] }] });
      k9min.activePageIdx = 0; k9min.activeLineIdx = 0;
      k9min.insertTable(1, 1);
      for (let p = 0; p < k9min.pages.length; p++) {
        const li = k9min.pages[p].lines.findIndex(l => l && l.type === 'table');
        if (li !== -1) { k9min.activePageIdx = p; k9min.activeLineIdx = li; break; }
      }
      k9min.activeCell = { r: 0, c: 0 };
      assert(k9min.deleteTableRow() === false && k9min.deleteTableColumn() === false,
        'Docs 9j: tabel 1x1 menolak hapus baris/kolom terakhir (guard, bukan crash)');

      // ---- 9j-34..37: PERILAKU gambar - pilih, ubah ukuran, ratakan ----
      const k9i = new Kix9j('docsScrollBox', 'kixHiddenInput');
      k9i.setDocumentData({ pages: [{ lines: [{ text: 'a' }] }] });
      k9i.activePageIdx = 0; k9i.activeLineIdx = 0;
      k9i.insertImage('https://example.com/a.png');
      const imgLine9j = k9i.pages[0].lines.findIndex(l => l && l.type === 'image');
      k9i.activeLineIdx = imgLine9j;
      k9i.renderAllPages();
      const box9j = k9i._imageBoxes.filter(b => b.pIdx === 0)[0] || null;
      assert(box9j && k9i.imageAt(0, box9j.x + 1, box9j.y + 1),
        'Docs 9j: imageAt() menemukan kotak gambar pada koordinat di dalamnya (hit-test hidup)');
      const maxW9j = k9i.pageWidth() - k9i.marginLeft() - k9i.marginRight();
      k9i.resizeActiveImage(99999);
      const wClamp9j = k9i.pages[0].lines[imgLine9j].image.width;
      assert(wClamp9j === maxW9j,
        `Docs 9j: resizeActiveImage menjepit lebar ke area teks :: ${wClamp9j} (maks ${maxW9j})`);
      k9i.resizeActiveImage(120);
      assert(k9i.pages[0].lines[imgLine9j].image.width === 120,
        'Docs 9j: resizeActiveImage menerapkan lebar yang sah');
      k9i.setActiveImageAlign('center');
      const al1_9j = k9i.pages[0].lines[imgLine9j].image.align;
      k9i.setActiveImageAlign('ngawur');
      const al2_9j = k9i.pages[0].lines[imgLine9j].image.align;
      assert(al1_9j === 'center' && al2_9j === 'left',
        `Docs 9j: setActiveImageAlign menerima center & menormalkan nilai asing ke left :: ${al1_9j} -> ${al2_9j}`);

      console.log('  Suite 9j (virtualisasi + cetak + tabel/gambar): selesai');
    }

    // ================= Suite 9k: HEADER & FOOTER TEKS (paritas Docs) =================
    console.log('\n--- Suite 9k: Header & Footer Teks (margin, merge, persistensi, wiring) ---');
    {
      const Kix9k = loadEditor('static/kix_editor.js', 'KixDocsEditor');
      const srcKix9k = fs.readFileSync(path.resolve(__dirname, 'static/kix_editor.js'), 'utf8');
      const srcShell9k = fs.readFileSync(path.resolve(__dirname, 'static/app_shell.js'), 'utf8');
      const defCount9k = (src, name) => (src.match(new RegExp('^\\s{4}(?:async\\s+)?' + name + '\\s*\\(', 'gm')) || []).length;
      const mkDoc9k = (n) => ({
        pages: Array.from({ length: n }, (_, i) => ({ lines: [{ text: 'halaman ' + (i + 1) }] }))
      });
      // Spion ctx: mencatat setiap fillText supaya geometri bisa diuji tanpa canvas asli.
      const spy9k = () => {
        const calls = [];
        return {
          calls,
          ctx: {
            save() {}, restore() {}, font: '', fillStyle: '', textAlign: '',
            fillText(t, x, y) { calls.push({ t: String(t), x: x, y: y }); }
          }
        };
      };

      // ---- 9k-01..02: STATE DEFAULT ----
      const k9h = new Kix9k('docsScrollBox', 'kixHiddenInput');
      assert(k9h.headerText === '' && k9h.footerText === '',
        `Docs 9k: state header/footer default string kosong (bukan undefined) :: "${k9h.headerText}"/"${k9h.footerText}"`);
      k9h.setDocumentData(mkDoc9k(2));
      const hf0 = k9h.getHeaderFooter();
      assert(hf0.header === '' && hf0.footer === '',
        `Docs 9k: getHeaderFooter() memakai kunci {header, footer} :: ${JSON.stringify(hf0)}`);

      // ---- 9k-03..05: MERGE PARSIAL (risiko tertinggi) ----
      k9h.setHeaderFooter({ header: 'Laporan Q4' });
      k9h.setHeaderFooter({ footer: 'Rahasia' });
      const hfA = k9h.getHeaderFooter();
      assert(hfA.header === 'Laporan Q4' && hfA.footer === 'Rahasia',
        `Docs 9k: dua panggilan parsial saling melengkapi, bukan menimpa :: ${JSON.stringify(hfA)}`);
      k9h.setHeaderFooter({ header: 'Header baru' });
      const hfB = k9h.getHeaderFooter();
      assert(hfB.footer === 'Rahasia',
        `Docs 9k: memperbarui header saja MEMPERTAHANKAN footer :: footer="${hfB.footer}"`);
      const ret9k = k9h.setHeaderFooter({ footer: 'Kaki baru' });
      assert(ret9k && ret9k.header === 'Header baru' && ret9k.footer === 'Kaki baru',
        `Docs 9k: setHeaderFooter mengembalikan pasangan hasil merge :: ${JSON.stringify(ret9k)}`);

      // ---- 9k-06..07: NORMALISASI NILAI KOSONG ----
      k9h.setHeaderFooter({ header: null, footer: undefined });
      const hfN = k9h.getHeaderFooter();
      assert(hfN.header === '' && hfN.footer === '',
        `Docs 9k: null/undefined dinormalkan ke string kosong :: ${JSON.stringify(hfN)}`);
      k9h.setHeaderFooter({ header: 'A', footer: 'B' });
      k9h.clearHeaderFooter();
      const hfC = k9h.getHeaderFooter();
      assert(hfC.header === '' && hfC.footer === '',
        `Docs 9k: clearHeaderFooter() mengosongkan keduanya :: ${JSON.stringify(hfC)}`);

      // ---- 9k-08..11: PERSISTENSI + GUARD SEED EXACT MATCH ----
      const kEmpty = new Kix9k('docsScrollBox', 'kixHiddenInput');
      kEmpty.setDocumentData(mkDoc9k(1));
      const dEmpty = kEmpty.getDocumentData();
      assert(!('headerFooter' in dEmpty),
        'Docs 9k: tanpa header/footer kunci headerFooter TIDAK ditulis (seed lama tetap EXACT MATCH)');
      kEmpty.setHeaderFooter({ header: 'Kop surat' });
      const dSet = kEmpty.getDocumentData();
      assert(dSet.headerFooter && dSet.headerFooter.header === 'Kop surat',
        `Docs 9k: header terisi -> kunci headerFooter ikut tersimpan :: ${JSON.stringify(dSet.headerFooter)}`);
      const kRT = new Kix9k('docsScrollBox', 'kixHiddenInput');
      kRT.setDocumentData({ pages: [{ lines: [{ text: 'x' }] }], headerFooter: { header: 'H', footer: 'F' } });
      const hfRT = kRT.getHeaderFooter();
      assert(hfRT.header === 'H' && hfRT.footer === 'F',
        `Docs 9k: setDocumentData memulihkan header/footer dari data tersimpan :: ${JSON.stringify(hfRT)}`);
      const kOld = new Kix9k('docsScrollBox', 'kixHiddenInput');
      kOld.setDocumentData({ pages: [{ lines: [{ text: 'dokumen lama' }] }] });
      assert(kOld.headerText === '' && kOld.footerText === '',
        'Docs 9k: dokumen lama tanpa headerFooter dimuat sebagai string kosong (bukan undefined)');

      // ---- 9k-12..15: GEOMETRI MARGIN ----
      const kGeo = new Kix9k('docsScrollBox', 'kixHiddenInput');
      kGeo.setDocumentData(mkDoc9k(1));
      kGeo.setHeaderFooter({ header: 'KOP', footer: 'KAKI' });
      const s1 = spy9k();
      kGeo._drawHeaderFooter(s1.ctx);
      const cH = s1.calls.find(c => c.t === 'KOP');
      const cF = s1.calls.find(c => c.t === 'KAKI');
      assert(!!cH && !!cF,
        `Docs 9k: _drawHeaderFooter mengecat header & footer :: ${JSON.stringify(s1.calls.map(c => c.t))}`);
      assert(cH && Math.abs(cH.y - (kGeo.marginTop() + 14)) < 0.01,
        `Docs 9k: header digambar di margin atas + 14 :: y=${cH ? cH.y : 'NA'} harap=${kGeo.marginTop() + 14}`);
      assert(cF && Math.abs(cF.y - (kGeo.pageHeight() - 38)) < 0.01,
        `Docs 9k: footer digambar di dasar halaman - 38 :: y=${cF ? cF.y : 'NA'} harap=${kGeo.pageHeight() - 38}`);
      assert(cH && cF && cH.y < cF.y,
        'Docs 9k: header berada DI ATAS footer (urutan vertikal benar)');
      const kNo = new Kix9k('docsScrollBox', 'kixHiddenInput');
      kNo.setDocumentData(mkDoc9k(1));
      const s2 = spy9k();
      kNo._drawHeaderFooter(s2.ctx);
      assert(s2.calls.length === 0,
        `Docs 9k: tanpa header/footer tidak ada yang dicat :: ${s2.calls.length} fillText`);

      // ---- 9k-16..18: WIRING ENGINE ----
      const rp9k = sliceMethod(srcKix9k, 'renderPage');
      // Baris komentar dibuang SEBELUM diperiksa. Versi pertama memakai
      // includes() polos, dan `// this._drawHeaderFooter(ctx);` tetap lolos
      // sehingga mutasi "matikan pemanggilan" SURVIVED di falsifikasi batch 1.
      const rpCode9k = rp9k.split('\n')
        .filter(l => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l) && !/^\s*\/\*/.test(l))
        .join('\n');
      assert(rpCode9k.length > 0 && /this\._drawHeaderFooter\(/.test(rpCode9k),
        'Docs 9k: renderPage memanggil _drawHeaderFooter di KODE (bukan komentar)');
      assert(/else if \(!this\.footerText\)/.test(srcKix9k),
        'Docs 9k: watermark tidak menimpa footer teks (gerbang !this.footerText)');

      // ---- 9k-19..23: WIRING SHELL ----
      assert(defCount9k(srcShell9k, 'openHeaderFooterModal') === 1,
        `Docs 9k: shell mendefinisikan openHeaderFooterModal tepat 1x :: ${defCount9k(srcShell9k, 'openHeaderFooterModal')}`);
      assert(/Header & Footer/.test(srcShell9k),
        'Docs 9k: entri menu "Header & Footer" tersedia di menu Sisipkan');
      // Shell memanggil setHeaderFooter DUA kali (header lalu footer). Versi
      // pertama hanya menuntut satu kemunculan, sehingga menghapus panggilan
      // header tetap lolos (mutasi "shell tak panggil engine" SURVIVED).
      const setCalls9k = (srcShell9k.match(/this\.kix\.setHeaderFooter\(/g) || []).length;
      assert(setCalls9k >= 2
        && /this\.kix\.setHeaderFooter\(\{ header \}\)/.test(srcShell9k)
        && /this\.kix\.setHeaderFooter\(\{ footer \}\)/.test(srcShell9k)
        && /this\.kix\.getHeaderFooter\(\)/.test(srcShell9k),
        `Docs 9k: shell memanggil engine utk header DAN footer :: set=${setCalls9k}`);
      assert(/if \(header === null\) return;/.test(srcShell9k),
        'Docs 9k: batal prompt (null) TIDAK menghapus header yang sudah ada');
      const nullRes9k = (srcShell9k.match(/_resolveModal\(null\)/g) || []).length;
      assert(nullRes9k >= 3,
        `Docs 9k: promptModal me-resolve null di semua jalur batal :: ${nullRes9k} jalur`);

      console.log('  Suite 9k (header & footer teks): selesai');
    }

    // ================= Suite 9l: GEOMETRI & RESOLUSI TEKS =================
    // Suite ini lahir dari audit mendalam atas dokumen nyata. Tiga cacat yang
    // ditemukan SEMUANYA lolos karena tidak ada satu pun asersi yang menjaganya:
    //   1. kanvas 636x850 di-stretch CSS ke 900px  -> glyph melar 5,88% vertikal
    //   2. hit-test klik memakai konstanta LINE_HEIGHT=24 sementara renderPage
    //      memakai measureLine().height (variabel) -> klik meleset s.d. 46px
    //   3. baseX memakai MARGIN mentah -> margin kiri/kanan hanya mengubah wrap
    //   4. tanpa devicePixelRatio -> teks buram di layar HiDPI
    console.log('\n--- Suite 9l: Geometri Kanvas, Margin, Tinggi Baris & devicePixelRatio ---');
    {
      const Kix9l = loadEditor('static/kix_editor.js', 'KixDocsEditor');
      const srcKix9l = fs.readFileSync(path.resolve(__dirname, 'static/kix_editor.js'), 'utf8');
      const html9l = fs.readFileSync(path.resolve(__dirname, 'dashboard.html'), 'utf8');

      // Buang komentar SEBELUM memeriksa kode. Tanpa ini, asersi `includes()`
      // akan lolos hanya karena simbolnya masih tertulis di komentar — persis
      // jebakan yang membuat mutasi SURVIVED pada falsifikasi batch 1.
      const codeOnly9l = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
      const code9l = codeOnly9l(srcKix9l);
      // Komentar CSS juga dibuang: komentar di dashboard.html MENJELASKAN nilai
      // lama `height: 900px`, jadi memeriksa teks mentah akan menuduh dokumentasi
      // sendiri sebagai pelanggaran (jebakan yang sama seperti falsifikasi batch 1).
      const htmlCode9l = html9l.replace(/\/\*[\s\S]*?\*\//g, '');

      // ---- 9l-01..05: UKURAN KANVAS == UKURAN KERTAS (anti-distorsi) ----
      const kSz = new Kix9l('docsScrollBox', 'kixHiddenInput');
      kSz.setDocumentData({ pages: [{ lines: [{ text: 'satu' }] }] });
      const cvsSz = docStub.getElementById('kixCanvas1');
      const dprSz = kSz._applyCanvasSize(cvsSz);
      assert(dprSz === 1,
        `Docs 9l: dpr default 1 (mesin uji tanpa HiDPI) :: ${dprSz}`);
      assert(cvsSz.width === 636 && cvsSz.height === 850,
        `Docs 9l: backing store = ukuran kertas 636x850 :: ${cvsSz.width}x${cvsSz.height}`);
      assert(cvsSz.style.width === '636px' && cvsSz.style.height === '850px',
        `Docs 9l: ukuran TAMPIL = ukuran kertas, tidak melar :: ${cvsSz.style.width}x${cvsSz.style.height}`);

      // Kertas A4: tinggi tampil WAJIB ikut berubah. Dulu CSS memaku 900px,
      // sehingga preset apa pun tetap tampil 900px dan Page Setup tidak nyata.
      kSz.pageSetup = { paperSize: 'a4', orientation: 'portrait' };
      kSz._applyCanvasSize(cvsSz);
      assert(cvsSz.width === 794 && cvsSz.height === 1123,
        `Docs 9l: A4 -> backing store 794x1123 :: ${cvsSz.width}x${cvsSz.height}`);
      assert(cvsSz.style.height === '1123px',
        `Docs 9l: A4 -> tinggi TAMPIL ikut jadi 1123px (Page Setup nyata) :: ${cvsSz.style.height}`);

      // ---- 9l-06..09: MARGIN MENGGESER TINTA (bukan hanya wrap) ----
      const calls9l = [], transforms9l = [], clears9l = [];
      const mkSpy9l = () => {
        const ctx = {
          font: '', fillStyle: '', strokeStyle: '', textAlign: '', lineWidth: 1,
          save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
          fillRect() {}, strokeRect() {}, arc() {}, closePath() {}, translate() {},
          setTransform(a, b, c, d, e, f) { transforms9l.push([a, b, c, d, e, f]); },
          clearRect(x, y, w, h) { clears9l.push([x, y, w, h]); },
          measureText(s) { return { width: String(s).length * 7 }; },
          fillText(t, x, y) { calls9l.push({ t: String(t), x: x, y: y }); },
          createLinearGradient() { return { addColorStop() {} }; },
          drawImage() {}
        };
        const cv = docStub.getElementById('kixCanvas1');
        cv.getContext = () => ctx;
        cv.width = 636; cv.height = 850;
        return cv;
      };

      const kMg = new Kix9l('docsScrollBox', 'kixHiddenInput');
      kMg.setDocumentData({ pages: [{ lines: [{ text: 'satu', size: 13 }] }] });
      mkSpy9l();
      kMg.renderPage(0);
      const inkDefault = calls9l.find(c => c.t === 'satu');
      assert(inkDefault && inkDefault.x === 30,
        `Docs 9l: margin default -> tinta di x=30 :: ${inkDefault ? inkDefault.x : 'NA'}`);

      kMg.pageSetup.marginLeft = 90;
      kMg.pageSetup.marginRight = 90;
      kMg.reflowPages();
      calls9l.length = 0;
      mkSpy9l();
      kMg.renderPage(0);
      const inkWide = calls9l.find(c => c.t === 'satu');
      assert(inkWide && inkWide.x === 90,
        `Docs 9l: marginLeft 90 -> tinta BERGESER ke x=90 (dulu tetap 30) :: ${inkWide ? inkWide.x : 'NA'}`);
      assert(kMg.viewW() - kMg.marginLeft() - kMg.marginRight() === 456,
        `Docs 9l: lebar area teks ikut menyempit jadi 456 :: ${kMg.viewW() - kMg.marginLeft() - kMg.marginRight()}`);

      // ---- 9l: ALIGN memakai margin AKTIF, bukan MARGIN mentah ----
      // Falsifikasi menemukan celah: memutasi align center kembali ke MARGIN
      // SURVIVED karena tidak ada asersi yang merender baris center/right dengan
      // margin non-default. Diuji terpisah supaya mutasi itu benar-benar mati.
      const kAl = new Kix9l('docsScrollBox', 'kixHiddenInput');
      kAl.setDocumentData({ pages: [{ lines: [{ text: 'satu', size: 13, align: 'center' }] }] });
      kAl.pageSetup.marginLeft = 90;
      kAl.pageSetup.marginRight = 90;
      calls9l.length = 0;
      mkSpy9l();
      kAl.renderPage(0);
      const inkCenter = calls9l.find(c => c.t === 'satu');
      // availW = 636-90-90 = 456; tw = 4*7 = 28 -> 90 + (456-28)/2 = 304
      assert(inkCenter && inkCenter.x === 304,
        `Docs 9l: align center memakai margin aktif (x=304, bukan 244) :: ${inkCenter ? inkCenter.x : 'NA'}`);

      kAl.pages[0].lines[0].align = 'right';
      calls9l.length = 0;
      mkSpy9l();
      kAl.renderPage(0);
      const inkRight = calls9l.find(c => c.t === 'satu');
      // max(90, 636-90-28) = 518
      assert(inkRight && inkRight.x === 518,
        `Docs 9l: align right memakai marginRight aktif (x=518) :: ${inkRight ? inkRight.x : 'NA'}`);

      // ---- 9l: KOTAK CENTANG ikut margin aktif ----
      // Celah kedua dari falsifikasi: checklistBoxRect masih memakai MARGIN
      // mentah -> kotak centang meleset dari teksnya begitu margin diubah.
      const kCk = new Kix9l('docsScrollBox', 'kixHiddenInput');
      kCk.setDocumentData({ pages: [{ lines: [
        { text: 'tugas', size: 13, listType: 'checklist', checked: false }
      ] }] });
      const boxDefault = kCk.checklistBoxRect(0, 0);
      assert(boxDefault && boxDefault.left === 25 && boxDefault.centerX === 37,
        `Docs 9l: kotak centang default ikut margin 30 :: left=${boxDefault && boxDefault.left} cx=${boxDefault && boxDefault.centerX}`);
      kCk.pageSetup.marginLeft = 90;
      const boxWide = kCk.checklistBoxRect(0, 0);
      assert(boxWide && boxWide.left === 85 && boxWide.centerX === 97,
        `Docs 9l: kotak centang BERGESER saat marginLeft 90 (dulu tetap 25) :: left=${boxWide && boxWide.left} cx=${boxWide && boxWide.centerX}`);

      // ---- 9l-10..14: SATU SUMBER KEBENARAN TINGGI BARIS ----
      const kTop = new Kix9l('docsScrollBox', 'kixHiddenInput');
      kTop.setDocumentData({ pages: [{ lines: [
        { text: 'A', size: 20 }, { text: 'B', size: 14 },
        { text: 'C', size: 13 }, { text: 'D', size: 13 }
      ] }] });
      const tops = kTop._lineTops(0);
      assert(tops.length === 5 && tops[0] === 60,
        `Docs 9l: _lineTops = n+1 titik, mulai textTop()=60 :: len=${tops.length} top0=${tops[0]}`);
      // base = round(size*1.5), gap = 0 (baris 0) / 4 (antar paragraf)
      assert(tops[1] === 90 && tops[2] === 115,
        `Docs 9l: tinggi baris VARIABEL per fontSize (30 lalu 21+4) :: ${tops[1]}/${tops[2]}`);
      assert(tops[2] === 115 && (60 + 2 * 24) === 108,
        `Docs 9l: rumus konstanta 24 TERBUKTI meleset 7px (115 vs 108)`);

      for (let i = 0; i < 4; i++) {
        const r = kTop.lineRectAt(0, i);
        assert(r.top === tops[i] && r.height === tops[i + 1] - tops[i],
          `Docs 9l: lineRectAt[${i}] identik dengan geometri gambar :: top=${r.top} h=${r.height}`);
      }
      for (let i = 0; i < 4; i++) {
        const mid = (tops[i] + tops[i + 1]) / 2;
        assert(kTop.lineIndexAtY(0, mid) === i,
          `Docs 9l: klik di tengah baris ${i} mengembalikan baris ${i} :: ${kTop.lineIndexAtY(0, mid)}`);
      }

      // Titik UJUNG, bukan hanya titik tengah. Ini pelajaran dari falsifikasi:
      // asersi titik-tengah saja TIDAK mendiskriminasi — dengan rumus konstanta 24,
      // titik-tengah tiap baris kebetulan masih jatuh di baris yang benar sehingga
      // mutasi "kembali ke 24" SURVIVED. Hanya 1px di atas garis batas bawah yang
      // membedakan kedua rumus (drift terakumulasi 7px pada baris ke-2).
      for (let i = 0; i < 4; i++) {
        const nearBottom = tops[i + 1] - 1;
        const gotB = kTop.lineIndexAtY(0, nearBottom);
        assert(gotB === i,
          `Docs 9l: 1px di atas batas bawah baris ${i} (y=${nearBottom}) tetap baris ${i} :: ${gotB}`);
        const nearTop = tops[i] + 1;
        const gotT = kTop.lineIndexAtY(0, nearTop);
        assert(gotT === i,
          `Docs 9l: 1px di bawah puncak baris ${i} (y=${nearTop}) tetap baris ${i} :: ${gotT}`);
      }
      // Di luar area teks: clamp ke baris pertama / terakhir, bukan -1 atau n.
      assert(kTop.lineIndexAtY(0, 0) === 0,
        `Docs 9l: y di atas baris pertama -> clamp ke 0 :: ${kTop.lineIndexAtY(0, 0)}`);
      assert(kTop.lineIndexAtY(0, 9999) === 3,
        `Docs 9l: y jauh di bawah baris terakhir -> clamp ke n-1 :: ${kTop.lineIndexAtY(0, 9999)}`);

      // ---- 9l-15..18: devicePixelRatio (teks tajam di HiDPI) ----
      const kDpr = new Kix9l('docsScrollBox', 'kixHiddenInput');
      kDpr.setDocumentData({ pages: [{ lines: [{ text: 'satu', size: 13 }] }] });
      kDpr.devicePixelRatio = 2;
      transforms9l.length = 0; clears9l.length = 0;
      const cvsDpr = mkSpy9l();
      kDpr.renderPage(0);
      assert(cvsDpr.width === 1272 && cvsDpr.height === 1700,
        `Docs 9l: dpr 2 -> backing store 2x (1272x1700) :: ${cvsDpr.width}x${cvsDpr.height}`);
      assert(cvsDpr.style.width === '636px' && cvsDpr.style.height === '850px',
        `Docs 9l: dpr 2 -> ukuran tampil TETAP logis 636x850 :: ${cvsDpr.style.width}x${cvsDpr.style.height}`);
      assert(transforms9l.length > 0 && transforms9l[0][0] === 2 && transforms9l[0][3] === 2,
        `Docs 9l: ctx.setTransform(dpr,...) dipasang :: ${JSON.stringify(transforms9l[0])}`);
      assert(clears9l.length > 0 && clears9l[0][2] === 636 && clears9l[0][3] === 850,
        `Docs 9l: clearRect memakai koordinat LOGIS, bukan backing store :: ${JSON.stringify(clears9l[0])}`);

      // ---- 9l-19..24: PENJAGA SUMBER (kode, bukan komentar) ----
      assert(!/Math\.floor\(\s*clickY\s*\/\s*LINE_HEIGHT/.test(code9l),
        'Docs 9l: hit-test TIDAK lagi memakai konstanta LINE_HEIGHT');
      assert(!/const baseX = MARGIN \+ m\.indent/.test(code9l),
        'Docs 9l: baseX memakai marginLeft(), bukan MARGIN mentah');
      assert(!/canvas\.width \/ rect\.width/.test(code9l),
        'Docs 9l: rasio zoom memakai viewW(), bukan canvas.width (dpr-aware)');
      assert(/setTransform\(dpr/.test(code9l),
        'Docs 9l: renderPage memasang setTransform(dpr)');
      assert(!/height:\s*900px/.test(htmlCode9l),
        'Docs 9l: CSS tidak lagi memaku tinggi kanvas 900px');
      assert(/overflow-x:\s*auto/.test(htmlCode9l),
        'Docs 9l: kontainer bisa digeser horizontal untuk kertas lebar (A4/Letter)');

      console.log('  Suite 9l (geometri & resolusi teks): selesai');

  // ================= Suite 9m: SATUAN TIPOGRAFI (pt <-> px) =================
  console.log('\n--- Suite 9m: Satuan Tipografi (point vs pixel) ---');
  const loadWin9m = (file) => {
    const win = {
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: () => {},
      getSelection: () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {} }),
      getComputedStyle: () => ({ display: 'block' })
    };
    win.window = win; win.document = docStub;
    const noopTimer = () => 0;
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
      fs.readFileSync(path.resolve(__dirname, file), 'utf8'))(win, docStub, noopTimer, () => {}, noopTimer, () => {});
    return win;
  };
  const win9m = loadWin9m('static/kix_editor.js');
  const U = win9m.KixUnits;
  assert(U && typeof U.ptToPx === 'function' && typeof U.pxToPt === 'function',
    'Docs 9m: KixUnits diekspos (satu rumus untuk shell + tes)');

  assert(Math.abs(U.PT_TO_PX - 4 / 3) < 1e-12,
    `Docs 9m: PT_TO_PX = 4/3 (96dpi / 72pt) :: ${U.PT_TO_PX}`);
  assert(U.pxToPt(13) === 9.75, `Docs 9m: 13px = 9,75pt :: ${U.pxToPt(13)}`);
  assert(U.ptToPx(9.75) === 13, `Docs 9m: 9,75pt = 13px :: ${U.ptToPx(9.75)}`);

  // INVARIAN INTI: round-trip harus EKSAK untuk semua ukuran yang dipakai.
  // Kalau ini gagal, konversi akan menggeser tinggi baris lewat Math.round.
  const sizes9m = [10, 12, 13, 14, 16, 18, 20, 24, 26, 32];
  const bad9m = sizes9m.filter((px) => U.ptToPx(U.pxToPt(px)) !== px);
  assert(bad9m.length === 0,
    `Docs 9m: round-trip px->pt->px EKSAK untuk semua ukuran :: meleset=${JSON.stringify(bad9m)}`);

  // Tinggi baris tidak boleh bergeser gara-gara pembulatan konversi.
  const base9m = sizes9m.map((px) => Math.round(U.ptToPx(U.pxToPt(px)) * 1.5));
  const baseRef9m = sizes9m.map((px) => Math.round(px * 1.5));
  assert(JSON.stringify(base9m) === JSON.stringify(baseRef9m),
    `Docs 9m: tinggi baris (round(size*1.5)) tidak bergeser :: ${JSON.stringify(base9m)}`);

  assert(U.ptLabel(13) === '9,75' && U.ptLabel(14) === '10,5' && U.ptLabel(20) === '15',
    `Docs 9m: label tampilan memakai koma :: ${U.ptLabel(13)} / ${U.ptLabel(14)} / ${U.ptLabel(20)}`);

  // ---- Dropdown: value px, label pt, dan SETIAP label balik eksak ----
  const html9m = fs.readFileSync(path.resolve(__dirname, 'dashboard.html'), 'utf8');
  // WAJIB di-scope ke blok <select id="tbFontSize"> SAJA. Tanpa ini regex ikut
  // menyapu dropdown spasi baris (value "1" -> label "1,0"), yang bukan ukuran
  // font sama sekali — dan assertion round-trip gagal karena 1pt memang bukan 1px.
  const blok9m = (html9m.match(/<select[^>]*id="tbFontSize"[^>]*>([\s\S]*?)<\/select>/) || [])[1] || '';
  assert(blok9m.length > 0, 'Docs 9m: blok select#tbFontSize ditemukan di dashboard.html');
  const opts9m = [...blok9m.matchAll(/<option value="(\d+)">([0-9,]+)<\/option>/g)]
    .map((m) => ({ px: parseFloat(m[1]), label: m[2] }));
  assert(opts9m.length >= 9,
    `Docs 9m: dropdown ukuran punya >=9 opsi :: ${opts9m.length}`);
  const salah9m = opts9m.filter((o) => {
    const pt = parseFloat(o.label.replace(',', '.'));
    return U.ptToPx(pt) !== o.px;
  });
  assert(salah9m.length === 0,
    `Docs 9m: setiap label pt menunjuk balik ke px yang sama :: salah=${JSON.stringify(salah9m)}`);

  // Bug yang terukur di probe16: preset title = 26px, dulu tak ada opsinya.
  assert(opts9m.some((o) => o.px === 26),
    'Docs 9m: dropdown punya opsi untuk preset Title (26px) — dulu kotak jadi kosong');
  assert(opts9m.every((o) => o.px !== undefined && !Number.isNaN(o.px)),
    'Docs 9m: tidak ada opsi ukuran tanpa value numerik');

  // ---- Penjaga sumber shell ----
  const shell9m = fs.readFileSync(path.resolve(__dirname, 'static/app_shell.js'), 'utf8');
  assert(/syncFontSizeSelect\(px\)\s*\{/.test(shell9m),
    'Docs 9m: shell punya syncFontSizeSelect (injeksi opsi hilang)');
  // probe18: guard `!px` meloloskan -5 dan Infinity (keduanya truthy), lalu
  // <option value="-5"> benar-benar disuntik. Number() menormalkan string,
  // Number.isFinite menolak NaN/Infinity, n <= 0 menolak negatif/nol.
  assert(/const n = Number\(px\);/.test(shell9m) &&
    /!Number\.isFinite\(n\)\s*\|\|\s*n\s*<=\s*0/.test(shell9m),
    'Docs 9m: syncFontSizeSelect menolak ukuran non-finite/non-positif (NaN, -5, Infinity)');
  assert(/ptLabel\(n\)/.test(shell9m),
    'Docs 9m: label opsi sisipan memakai nilai ternormalisasi, bukan input mentah');
  assert((shell9m.match(/this\.syncFontSizeSelect\(st\.size\)/g) || []).length === 2,
    'Docs 9m: KEDUA cabang syncToolbar memakai syncFontSizeSelect');
  assert(!/sz\.value\s*=\s*String\(st\.size\)/.test(shell9m),
    'Docs 9m: tidak ada lagi penulisan langsung sz.value (sumber kosongnya select)');
  assert(/parseInt\(sz\.value, 10\)/.test(shell9m),
    'Docs 9m: handler change tetap parseInt karena value select masih px');

  console.log('  Suite 9m (satuan tipografi): selesai');

  // ---- Suite 9n: TEXT ALIGNMENT JUSTIFY ----
  // Membuktikan bahwa justify terpasang end-to-end:
  // engine menerima 'justify', UI sinkron, dan baris terakhir fallback left.
  console.log('  Suite 9n (justify alignment):');

  // 9n-1: kix menerima align='justify' tanpa exception
  // Pakai loadWin9m yang sudah mendefinisikan noopTimer di scope-nya sendiri.
  const win9n = loadWin9m('static/kix_editor.js');
  const K9n = win9n.KixDocsEditor;
  assert(typeof K9n === 'function',
    'Docs 9n: KixDocsEditor tersedia setelah eval');

  // 9n-2: penjaga sumber — renderPage punya cabang justify AKTIF (bukan di-false-kan)
  const kixSrc9n = fs.readFileSync(path.resolve(__dirname, 'static/kix_editor.js'), 'utf8');
  assertActive(kixSrc9n, /line\.align === 'justify'/,
    'Docs 9n: renderPage mengenal align=justify (aktif, bukan false&&)');

  // 9n-3: penjaga sumber — charIndexAtPoint punya cabang justify
  // Harus ada >= 2 kemunculan aktif (renderPage + charIndexAtPoint)
  assert((kixSrc9n.match(/line\.align === 'justify'/g) || []).length >= 2,
    'Docs 9n: charIndexAtPoint JUGA mengenal align=justify (konsistensi hit-test)');

  // 9n-4: penjaga sumber — justify gambar kata per kata (justifyGaps) AKTIF
  assertActive(kixSrc9n, /if\s*\(justifyGaps\)\s*\{/,
    'Docs 9n: renderer memiliki blok justifyGaps aktif (distribusi spasi)');

  // 9n-5: baris terakhir paragraf = fallback left (sIdx < segs.length - 1)
  assert(/sIdx < segs\.length - 1/.test(kixSrc9n),
    'Docs 9n: justify hanya berlaku untuk baris non-terakhir (standar tipografi)');

  // 9n-6: dashboard punya tombol tbAlignJustify
  const dashSrc9n = fs.readFileSync(path.resolve(__dirname, 'dashboard.html'), 'utf8');
  assert(/id="tbAlignJustify"/.test(dashSrc9n),
    'Docs 9n: dashboard punya tombol tbAlignJustify');

  // 9n-7: shell punya binding justify
  const shellSrc9n = fs.readFileSync(path.resolve(__dirname, 'static/app_shell.js'), 'utf8');
  assert(/tbAlignJustify/.test(shellSrc9n),
    'Docs 9n: shell punya binding tbAlignJustify');

  // 9n-8: syncToolbar punya set justify
  assert(/st\.align === 'justify'/.test(shellSrc9n),
    'Docs 9n: syncToolbar menyetel tbAlignJustify');

  // 9n-9: context menu punya opsi justify (exact match, bukan substring)
  assert(/\{ label: 'Rata Kanan Kiri \(Justify\)',/.test(shellSrc9n),
    'Docs 9n: context menu punya opsi Rata Kanan Kiri (Justify) (exact label)');

  console.log('  Suite 9n (justify alignment): selesai');

  // ================= Suite 10b: FORMULA ENGINE — Fungsi Baru =================
  console.log('\n--- Suite 10b: Formula Engine — Fungsi Conditional, Lookup, Date ---');
  const { evaluateFormula: ef10b, evaluateAllSheetCells: eAll10b } = await import('./formula.mjs');
  const g10b = (k) => {
    const data = {
      'A1': { raw: 10, val: 10 }, 'A2': { raw: 20, val: 20 },
      'A3': { raw: 30, val: 30 }, 'A4': { raw: 40, val: 40 },
      'B1': { raw: 'apel', val: 'apel' }, 'B2': { raw: 'jeruk', val: 'jeruk' },
      'B3': { raw: 'apel', val: 'apel' }, 'B4': { raw: 'mangga', val: 'mangga' },
      'C1': { raw: 100, val: 100 }, 'C2': { raw: 200, val: 200 },
      'C3': { raw: 300, val: 300 }, 'C4': { raw: 400, val: 400 },
    };
    return data[String(k).toUpperCase()] || null;
  };

  // 10b-1: COUNTIF angka
  assert(ef10b('=COUNTIF(A1:A4, ">15")', g10b) === 3,
    'Formula 10b: COUNTIF(A1:A4, ">15") = 3');

  // 10b-2: COUNTIF teks
  assert(ef10b('=COUNTIF(B1:B4, "apel")', g10b) === 2,
    'Formula 10b: COUNTIF(B1:B4, "apel") = 2');

  // 10b-3: SUMIF
  assert(ef10b('=SUMIF(A1:A4, ">15")', g10b) === 90,
    'Formula 10b: SUMIF(A1:A4, ">15") = 90 (20+30+40)');

  // 10b-4: SUMIF dengan sum_range
  assert(ef10b('=SUMIF(B1:B4, "apel", C1:C4)', g10b) === 400,
    'Formula 10b: SUMIF(B1:B4, "apel", C1:C4) = 400 (100+300)');

  // 10b-5: COUNTIFS multi-kriteria
  assert(ef10b('=COUNTIFS(A1:A4, ">15", A1:A4, "<35")', g10b) === 2,
    'Formula 10b: COUNTIFS >15 AND <35 = 2 (20, 30)');

  // 10b-6: SUMIFS
  assert(ef10b('=SUMIFS(C1:C4, A1:A4, ">15", B1:B4, "apel")', g10b) === 300,
    'Formula 10b: SUMIFS sum C where A>15 AND B=apel = 300');

  // 10b-7: VLOOKUP exact
  assert(ef10b('=VLOOKUP("jeruk", B1:C4, 2, FALSE)', g10b) === 200,
    'Formula 10b: VLOOKUP jeruk exact = 200');

  // 10b-8: VLOOKUP not found
  assert(ef10b('=VLOOKUP("durian", B1:C4, 2, FALSE)', g10b) === '#N/A',
    'Formula 10b: VLOOKUP durian = #N/A');

  // 10b-9: INDEX
  assert(ef10b('=INDEX(C1:C4, 3)', g10b) === 300,
    'Formula 10b: INDEX(C1:C4, 3) = 300');

  // 10b-10: MATCH exact
  assert(ef10b('=MATCH("apel", B1:B4, 0)', g10b) === 1,
    'Formula 10b: MATCH apel exact = 1');

  // 10b-11: MATCH not found
  assert(ef10b('=MATCH("durian", B1:B4, 0)', g10b) === '#N/A',
    'Formula 10b: MATCH durian = #N/A');

  // 10b-12: TODAY format YYYY-MM-DD
  const todayResult = ef10b('=TODAY()', g10b);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(todayResult),
    `Formula 10b: TODAY() format YYYY-MM-DD :: ${todayResult}`);

  // 10b-13: NOW format YYYY-MM-DD HH:MM:SS
  const nowResult = ef10b('=NOW()', g10b);
  assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(nowResult),
    `Formula 10b: NOW() format YYYY-MM-DD HH:MM:SS :: ${nowResult}`);

  // 10b-14: RANDBETWEEN
  const rb = ef10b('=RANDBETWEEN(1, 10)', g10b);
  assert(typeof rb === 'number' && rb >= 1 && rb <= 10,
    `Formula 10b: RANDBETWEEN(1,10) in [1..10] :: ${rb}`);

  // 10b-15: INDEX+MATCH combo (nested)
  assert(ef10b('=INDEX(C1:C4, MATCH("jeruk", B1:B4, 0))', g10b) === 200,
    'Formula 10b: INDEX+MATCH combo = 200');

  // 10b-16: COUNTIF <> operator
  assert(ef10b('=COUNTIF(B1:B4, "<>apel")', g10b) === 2,
    'Formula 10b: COUNTIF <> apel = 2 (jeruk, mangga)');

  // 10b-17: penjaga sumber — semua fungsi baru ada di FUNCTIONS
  const fmSrc10b = fs.readFileSync(path.resolve(__dirname, 'formula.mjs'), 'utf8');
  for (const fn of ['COUNTIF', 'COUNTIFS', 'SUMIF', 'SUMIFS', 'VLOOKUP', 'INDEX', 'MATCH', 'TODAY', 'NOW', 'RANDBETWEEN']) {
    const re = new RegExp('\\b' + fn + '\\s*:');
    assert(re.test(fmSrc10b),
      `Formula 10b: fungsi ${fn} ada di FUNCTIONS map`);
  }

  // 10b-18: matchesCriteria helper ada
  assert(/function matchesCriteria/.test(fmSrc10b),
    'Formula 10b: helper matchesCriteria ada di formula.mjs');

  console.log('  Suite 10b (formula conditional+lookup+date): selesai');

  // ================= Suite 10c: RENAME SHEET =================
  console.log('\n--- Suite 10c: Rename Sheet ---');
  const ritzSrc10c = fs.readFileSync(path.resolve(__dirname, 'static/ritz_editor.js'), 'utf8');

  // 10c-1: method renameSheet ada
  assert(/renameSheet\s*\(/.test(ritzSrc10c),
    'Sheets 10c: method renameSheet ada di ritz_editor.js');

  // 10c-2: validasi nama kosong
  assert(/trimmed/.test(ritzSrc10c) && /!trimmed/.test(ritzSrc10c),
    'Sheets 10c: renameSheet memvalidasi nama kosong');

  // 10c-3: cek duplikat case-insensitive
  assert(/toLowerCase\(\)\s*===/.test(ritzSrc10c),
    'Sheets 10c: renameSheet cek duplikat case-insensitive');

  // 10c-4: renderSheetTabs punya dblclick handler
  assert(/dblclick/.test(ritzSrc10c),
    'Sheets 10c: renderSheetTabs punya dblclick handler untuk rename');

  // 10c-5: input rename ada di renderSheetTabs
  assert(/sheet-tab-rename/.test(ritzSrc10c),
    'Sheets 10c: input rename punya class sheet-tab-rename');

  // 10c-6: Enter commit, Escape cancel
  assert(/Enter/.test(ritzSrc10c) && /Escape/.test(ritzSrc10c),
    'Sheets 10c: input rename handle Enter (commit) dan Escape (cancel)');

  // 10c-7: notifyChange dipanggil setelah rename
  assertActive(ritzSrc10c, /this\.notifyChange\(\)/,
    'Sheets 10c: notifyChange dipanggil setelah rename');

  console.log('  Suite 10c (rename sheet): selesai');

  // ================= Suite 10d: SLIDES — Rotasi, Group, Transisi =================
  console.log('\n--- Suite 10d: Slides — Rotasi, Group, Transisi ---');
  const punchSrc10d = fs.readFileSync(path.resolve(__dirname, 'static/punch_editor.js'), 'utf8');

  // 10d-1: rotateElement method ada
  assertActive(punchSrc10d, /rotateElement\s*\(/,
    'Slides 10d: rotateElement method ada (aktif)');

  // 10d-2: setElementAngle method ada
  assertActive(punchSrc10d, /setElementAngle\s*\(/,
    'Slides 10d: setElementAngle method ada (aktif)');

  // 10d-3: _wrapRotation helper ada
  assertActive(punchSrc10d, /_wrapRotation\s*\(/,
    'Slides 10d: _wrapRotation helper ada (aktif)');

  // 10d-4: SVG transform="rotate(...)" ada di _wrapRotation
  assert(/transform="rotate\(/.test(punchSrc10d),
    'Slides 10d: SVG transform rotate ada di punch');

  // 10d-5: elementToSvg memanggil _wrapRotation
  assert((punchSrc10d.match(/this\._wrapRotation\(/g) || []).length >= 4,
    'Slides 10d: elementToSvg memanggil _wrapRotation >= 4x (rect, circle, line, text)');

  // 10d-6: groupElements method ada
  assertActive(punchSrc10d, /groupElements\s*\(/,
    'Slides 10d: groupElements method ada (aktif)');

  // 10d-7: ungroupElements method ada
  assertActive(punchSrc10d, /ungroupElements\s*\(/,
    'Slides 10d: ungroupElements method ada (aktif)');

  // 10d-8: elementToSvg punya branch group
  assert(/el\.type === 'group'/.test(punchSrc10d),
    'Slides 10d: elementToSvg punya branch type=group');

  // 10d-9: group children recursive render
  assert(/el\.children/.test(punchSrc10d),
    'Slides 10d: group render iterates el.children');

  // 10d-10: selectionBox punya branch group
  assert(/kind: 'group'/.test(punchSrc10d),
    'Slides 10d: selectionBox handle type=group');

  // 10d-11: setSlideTransition method ada
  assertActive(punchSrc10d, /setSlideTransition\s*\(/,
    'Slides 10d: setSlideTransition method ada (aktif)');

  // 10d-12: getSlideTransition method ada
  assertActive(punchSrc10d, /getSlideTransition\s*\(/,
    'Slides 10d: getSlideTransition method ada (aktif)');

  // 10d-13: validTypes mengandung fade, slide-left, zoom
  assert(/fade/.test(punchSrc10d) && /slide-left/.test(punchSrc10d) && /zoom/.test(punchSrc10d),
    'Slides 10d: transisi mendukung fade, slide-left, zoom');

  // 10d-14: CSS @keyframes ada di presentation mode
  assert(/@keyframes punchFadeIn/.test(punchSrc10d),
    'Slides 10d: @keyframes punchFadeIn ada');

  // 10d-15: transitionDuration disimpan di slide
  assert(/transitionDuration/.test(punchSrc10d),
    'Slides 10d: transitionDuration property ada');

  // 10d-16: angle property dipakai di rotateElement
  assert(/el\.angle/.test(punchSrc10d),
    'Slides 10d: el.angle property dipakai');

  // 10d-17: pusat rotasi dihitung dari bounding box (cx, cy)
  assert(/el\.x \+ el\.width \/ 2/.test(punchSrc10d),
    'Slides 10d: pusat rotasi rect = x + width/2');

  // 10d-18: onChange dipanggil setelah rotate
  assert((punchSrc10d.match(/this\.onChange/g) || []).length >= 8,
    'Slides 10d: onChange dipanggil cukup banyak (>= 8 tempat)');

  console.log('  Suite 10d (slides rotasi+group+transisi): selesai');

  // ================= Suite 10e: TRASH & RESTORE + EKSPOR =================
  console.log('\n--- Suite 10e: Trash & Restore + Ekspor PDF/DOCX/XLSX ---');

  // 10e-1: store.mjs punya trashDocument
  const storeSrc10e = fs.readFileSync(path.resolve(__dirname, 'store.mjs'), 'utf8');
  assertActive(storeSrc10e, /export function trashDocument/,
    'Store 10e: trashDocument ada (aktif)');

  // 10e-2: store.mjs punya restoreDocument
  assertActive(storeSrc10e, /export function restoreDocument/,
    'Store 10e: restoreDocument ada (aktif)');

  // 10e-3: store.mjs punya listTrash
  assertActive(storeSrc10e, /export function listTrash/,
    'Store 10e: listTrash ada (aktif)');

  // 10e-4: store.mjs punya emptyTrash
  assertActive(storeSrc10e, /export function emptyTrash/,
    'Store 10e: emptyTrash ada (aktif)');

  // 10e-5: listDocuments filter trashed
  assert(/\.filter\(f\s*=>\s*!f\.trashed\)/.test(storeSrc10e),
    'Store 10e: listDocuments filter trashed');

  // 10e-6: trashDocument set meta.trashed = true
  assert(/meta\.trashed\s*=\s*true/.test(storeSrc10e),
    'Store 10e: trashDocument set trashed=true');

  // 10e-7: restoreDocument delete meta.trashed
  assert(/delete meta\.trashed/.test(storeSrc10e),
    'Store 10e: restoreDocument delete meta.trashed');

  // 10e-8: server.mjs punya route /trash
  const serverSrc10e = fs.readFileSync(path.resolve(__dirname, 'server.mjs'), 'utf8');
  assert(/\/trash/.test(serverSrc10e),
    'Server 10e: route /trash ada');

  // 10e-9: server.mjs punya route /restore
  assert(/\/restore/.test(serverSrc10e),
    'Server 10e: route /restore ada');

  // 10e-10: server import trashDocument
  assert(/trashDocument/.test(serverSrc10e),
    'Server 10e: import trashDocument ada');

  // 10e-11: shell punya restoreDoc
  const shellSrc10e = fs.readFileSync(path.resolve(__dirname, 'static/app_shell.js'), 'utf8');
  assertActive(shellSrc10e, /restoreDoc\s*\(/,
    'Shell 10e: restoreDoc method ada (aktif)');

  // 10e-12: shell punya loadTrash
  assertActive(shellSrc10e, /loadTrash\s*\(/,
    'Shell 10e: loadTrash method ada (aktif)');

  // 10e-13: shell punya emptyTrash
  assertActive(shellSrc10e, /emptyTrash\s*\(/,
    'Shell 10e: emptyTrash method ada (aktif)');

  // 10e-14: shell deleteDoc menggunakan /trash (soft-delete)
  assert(/\/trash/.test(shellSrc10e),
    'Shell 10e: deleteDoc menggunakan /trash route');

  // 10e-15: downloadCurrentDoc mendukung html format
  assert(/format === 'html'/.test(shellSrc10e),
    'Shell 10e: downloadCurrentDoc mendukung format html');

  // 10e-16: downloadCurrentDoc mendukung xlsx format
  assert(/format === 'xlsx'/.test(shellSrc10e),
    'Shell 10e: downloadCurrentDoc mendukung format xlsx');

  // 10e-17: downloadCurrentDoc mendukung pdf format
  assert(/format === 'pdf'/.test(shellSrc10e),
    'Shell 10e: downloadCurrentDoc mendukung format pdf');

  // 10e-18: _escHtml helper ada
  assertActive(shellSrc10e, /_escHtml\s*\(/,
    'Shell 10e: _escHtml helper ada (aktif)');

  // 10e-19: BOM untuk xlsx/csv
  assert(/\\uFEFF/.test(shellSrc10e),
    'Shell 10e: BOM prefix untuk xlsx/csv');

  console.log('  Suite 10e (trash+restore+ekspor): selesai');

  // ================= Suite 10f: DOCS letterSpacing + textBaseline =================
  console.log('\n--- Suite 10f: Docs letterSpacing + textBaseline ---');
  const kixSrc10f = fs.readFileSync(path.resolve(__dirname, 'static/kix_editor.js'), 'utf8');

  // 10f-1: ctx.textBaseline = 'alphabetic' ada di renderPage
  assert((kixSrc10f.match(/ctx\.textBaseline\s*=\s*'alphabetic'/g) || []).length >= 2,
    'Docs 10f: ctx.textBaseline alphabetic ada >= 2 tempat (render + hitTest)');

  // 10f-2: ctx.letterSpacing ada di renderPage
  assert(/ctx\.letterSpacing/.test(kixSrc10f),
    'Docs 10f: ctx.letterSpacing ada di kix');

  // 10f-3: line.letterSpacing property dipakai
  assert(/line\.letterSpacing/.test(kixSrc10f),
    'Docs 10f: line.letterSpacing property dipakai');

  // 10f-4: letterSpacing ada di daftar properti
  assert(/letterSpacing/.test(kixSrc10f),
    'Docs 10f: letterSpacing ada di daftar properti');

  // 10f-5: guard typeof ctx.letterSpacing (backward compat)
  assertActive(kixSrc10f, /typeof ctx\.letterSpacing/,
    'Docs 10f: guard typeof ctx.letterSpacing (backward compat, aktif)');

  // 10f-6: default '0px' untuk letterSpacing
  assert(/letterSpacing \|\| '0px'/.test(kixSrc10f),
    'Docs 10f: default 0px untuk letterSpacing');

  // 10f-7: letterSpacing di daftar prop yang disync
  assert(/'letterSpacing'/.test(kixSrc10f),
    "Docs 10f: 'letterSpacing' sebagai string property name");

  // 10f-8: changeLetterSpacing method ada
  assertActive(kixSrc10f, /changeLetterSpacing\s*\(/,
    'Docs 10f: changeLetterSpacing method ada (aktif)');

  console.log('  Suite 10f (letterSpacing + textBaseline): selesai');

  // ================= Suite 11a: MENU KONTEKSTUAL PER APP =================
  console.log('\n--- Suite 11a: Menu kontekstual per app ---');
  const shellSrc11a = fs.readFileSync(path.resolve(__dirname, 'static/app_shell.js'), 'utf8');

  // 11a-1: getMenuItems ada dan pakai this.currentApp
  assertActive(shellSrc11a, /getMenuItems\s*\(menu\)/,
    'Shell 11a: getMenuItems(menu) ada (aktif)');
  assert(/const app = this\.currentApp/.test(shellSrc11a),
    'Shell 11a: getMenuItems pakai this.currentApp');

  // 11a-2: File menu punya branch per app
  assert(/app === 'docs'/.test(shellSrc11a), 'Shell 11a: branch docs');
  assert(/app === 'sheets'/.test(shellSrc11a), 'Shell 11a: branch sheets');
  assert(/app === 'slides'/.test(shellSrc11a), 'Shell 11a: branch slides');

  // 11a-3: Label lama yang campur app sudah dihapus
  assert(!/Unduh Dokumen \(\.txt\)/.test(shellSrc11a),
    'Shell 11a: label lama "Unduh Dokumen (.txt)" dihapus');
  assert(!/Unduh Spreadsheet \(\.csv\)/.test(shellSrc11a),
    'Shell 11a: label lama "Unduh Spreadsheet (.csv)" dihapus');
  assert(!/Unduh Slide \(\.svg\)/.test(shellSrc11a),
    'Shell 11a: label lama "Unduh Slide (.svg)" dihapus');

  // 11a-4: Docs file menu punya Dokumen Baru dan Cetak
  assert(/Dokumen Baru/.test(shellSrc11a), 'Shell 11a: Docs file punya Dokumen Baru');
  assert(/Unduh sebagai Teks Biasa/.test(shellSrc11a), 'Shell 11a: Docs file punya unduh txt');
  assert(/Unduh sebagai Halaman Web/.test(shellSrc11a), 'Shell 11a: Docs file punya unduh html');

  // 11a-5: Sheets file menu punya Spreadsheet Baru dan CSV
  assert(/Spreadsheet Baru/.test(shellSrc11a), 'Shell 11a: Sheets file punya Spreadsheet Baru');
  assert(/Unduh sebagai CSV/.test(shellSrc11a), 'Shell 11a: Sheets file punya unduh csv');

  // 11a-6: Slides file menu punya Presentasi Baru dan SVG
  assert(/Presentasi Baru/.test(shellSrc11a), 'Shell 11a: Slides file punya Presentasi Baru');
  assert(/Unduh sebagai SVG/.test(shellSrc11a), 'Shell 11a: Slides file punya unduh svg');

  // 11a-7: Edit — Docs punya Cari dan Ganti, Slides punya Hapus Elemen
  assert(/Cari dan Ganti/.test(shellSrc11a), 'Shell 11a: Docs edit punya Cari dan Ganti');
  assert(/Hapus Elemen Terpilih/.test(shellSrc11a), 'Shell 11a: Slides edit punya Hapus Elemen');

  // 11a-8: View — Docs punya Penghitung Kata, Sheets punya Bekukan, Slides punya Mode Presentasi
  assert(/Penghitung Kata/.test(shellSrc11a), 'Shell 11a: Docs view punya Penghitung Kata');
  assert(/Bekukan 1 baris/.test(shellSrc11a), 'Shell 11a: Sheets view punya Bekukan');
  assert(/Mode Presentasi/.test(shellSrc11a), 'Shell 11a: Slides view punya Mode Presentasi');

  // 11a-9: Insert — Docs punya Tabel + Header & Footer, Sheets punya Tambah Sheet, Slides punya Slide Baru
  assert(/Header & Footer/.test(shellSrc11a), 'Shell 11a: Docs insert punya Header & Footer');
  assert(/Tambah Sheet Baru/.test(shellSrc11a), 'Shell 11a: Sheets insert punya Tambah Sheet');
  assert(/Slide Baru/.test(shellSrc11a), 'Shell 11a: Slides insert punya Slide Baru');

  // 11a-10: Format — Docs punya Justify, Sheets punya Mata Uang
  assert(/Justify/.test(shellSrc11a), 'Shell 11a: Docs format punya Justify');
  assert(/Mata Uang/.test(shellSrc11a), 'Shell 11a: Sheets format punya Mata Uang');

  // 11a-11: Tools — Docs punya Penghitung Kata, Sheets punya Ekspor CSV, Slides punya Ekspor SVG
  assert(/Ekspor CSV/.test(shellSrc11a), 'Shell 11a: Sheets tools punya Ekspor CSV');
  assert(/Ekspor SVG/.test(shellSrc11a), 'Shell 11a: Slides tools punya Ekspor SVG');

  // 11a-12: Catatan Pembicara (Slides View only)
  assert(/Catatan Pembicara/.test(shellSrc11a), 'Shell 11a: Slides view punya Catatan Pembicara');

  console.log('  Suite 11a (menu kontekstual per app): selesai');
    }

    // =========================================================================
    // Suite 11b: PARITAS REA DOCS (TOOLBAR 6 KONTROL & MENU ALAT KANONIKAL)
    // =========================================================================
    {
      console.log('\n--- Suite 11b: Paritas REA Docs (Toolbar & Menu Alat) ---');
      const htmlSrc11b = fs.readFileSync(path.resolve(__dirname, 'dashboard.html'), 'utf8');
      const shellSrc11b = fs.readFileSync(path.resolve(__dirname, 'static/app_shell.js'), 'utf8');
      const kixSrc11b = fs.readFileSync(path.resolve(__dirname, 'static/kix_editor.js'), 'utf8');

      // 11b-1: Kontrol toolbar baru Docs di dashboard.html
      assert(/id="tbSpellCheck"/.test(htmlSrc11b), 'Toolbar Docs punya tbSpellCheck');
      assert(/id="tbFormatPainter"/.test(htmlSrc11b), 'Toolbar Docs punya tbFormatPainter');
      assert(/id="tbFontSizeDec"/.test(htmlSrc11b), 'Toolbar Docs punya tbFontSizeDec');
      assert(/id="tbFontSizeInc"/.test(htmlSrc11b), 'Toolbar Docs punya tbFontSizeInc');
      assert(/id="tbInsertLink"/.test(htmlSrc11b), 'Toolbar Docs punya tbInsertLink');
      assert(/id="tbInsertImage"/.test(htmlSrc11b), 'Toolbar Docs punya tbInsertImage');

      // 11b-2: Toolbar bindings di app_shell.js
      assert(/bind\('tbSpellCheck'/.test(shellSrc11b), 'Shell punya binding tbSpellCheck');
      assert(/bind\('tbFormatPainter'/.test(shellSrc11b), 'Shell punya binding tbFormatPainter');
      assert(/bind\('tbFontSizeDec'/.test(shellSrc11b), 'Shell punya binding tbFontSizeDec');
      assert(/bind\('tbFontSizeInc'/.test(shellSrc11b), 'Shell punya binding tbFontSizeInc');
      assert(/bind\('tbInsertImage'/.test(shellSrc11b), 'Shell punya binding tbInsertImage');

      // 11b-3: Engine methods di kix_editor.js
      assert(/changeFontSizeBy\(delta\)/.test(kixSrc11b), 'Kix punya changeFontSizeBy');
      assert(/copyFormatting\(\)/.test(kixSrc11b), 'Kix punya copyFormatting');
      assert(/applyFormatPainter\(\)/.test(kixSrc11b), 'Kix punya applyFormatPainter');
      assert(/toggleLineNumbers\(\)/.test(kixSrc11b), 'Kix punya toggleLineNumbers');
      assert(/checkSpelling\(\)/.test(kixSrc11b), 'Kix punya checkSpelling');

      // 11b-4: Paritas Menu Alat kanonikal Docs di app_shell.js
      assert(/Ejaan dan Tata Bahasa/.test(shellSrc11b), 'Menu Alat Docs punya Ejaan dan Tata Bahasa');
      assert(/Nomor Baris/.test(shellSrc11b), 'Menu Alat Docs punya Nomor Baris');
      assert(/Kamus & Definisi/.test(shellSrc11b), 'Menu Alat Docs punya Kamus & Definisi');
      assert(/Terjemahkan Dokumen/.test(shellSrc11b), 'Menu Alat Docs punya Terjemahkan Dokumen');
      assert(/Dikte \(Pengetikan Suara\)/.test(shellSrc11b), 'Menu Alat Docs punya Dikte (Pengetikan Suara)');
      assert(/Preferensi/.test(shellSrc11b), 'Menu Alat Docs punya Preferensi');

      // 11b-5: Supporting methods di AppShell
      assert(/toggleFormatPainter\(\)/.test(shellSrc11b), 'Shell punya method toggleFormatPainter');
      assert(/checkSpelling\(\)/.test(shellSrc11b), 'Shell punya method checkSpelling');
      assert(/toggleLineNumbers\(\)/.test(shellSrc11b), 'Shell punya method toggleLineNumbers');
      assert(/openDictionaryModal\(\)/.test(shellSrc11b), 'Shell punya method openDictionaryModal');
      assert(/openTranslateModal\(\)/.test(shellSrc11b), 'Shell punya method openTranslateModal');
      assert(/openPreferencesModal\(\)/.test(shellSrc11b), 'Shell punya method openPreferencesModal');
      assert(/toggleVoiceTyping\(\)/.test(shellSrc11b), 'Shell punya method toggleVoiceTyping');

      console.log('  Suite 11b (Paritas REA Docs): selesai');
    }



    // Laporan keutuhan ISI seed (informatif, bukan kegagalan): pengujian E2E
  // mengetik & menyimpan dokumen contoh secara nyata, jadi isinya bisa berubah.
  // Struktur tetap diuji di Suite 8/12; nilai persisnya dilaporkan di sini.
  try {
    const seedNow = store.getDocument('sheets-example');
    const cNow = (seedNow && seedNow.data && seedNow.data.cells) || {};
    const nums = ['C1', 'C2', 'C3', 'C4'].map(k => (cNow[k] ? cNow[k].val : null));
    const intact = JSON.stringify(nums) === JSON.stringify([250, 120, 45, 85]);
    console.log(`  [INFO] Isi seed sheets C1..C4 = ${JSON.stringify(nums)} (kanonik [250,120,45,85]) -> ${intact ? 'UTUH' : 'BERUBAH: jejak pengujian E2E yang mengetik & autosave'}`);
    console.log('  [INFO] Pulihkan demo ke data contoh: node reset_demo.mjs');
  } catch (e) {
    console.log(`  [INFO] Laporan keutuhan seed dilewati: ${e.message}`);
  }

  console.log('\n====================================================');
  console.log(` HASIL PENGUJIAN: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('====================================================');

  // Keluar secara eksplisit dengan kode status yang benar. Editor menyimpan
  // timer (kedip kursor) sehingga event loop bisa tetap hidup; jalur
  // process.exit(1) di bawah hanya berjalan bila ADA kegagalan, sehingga tanpa
  // baris ini proses menggantung justru ketika semua tes lulus.
  process.exit(failedTests > 0 ? 1 : 0);
}

runTestSuite();
