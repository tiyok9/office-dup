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
