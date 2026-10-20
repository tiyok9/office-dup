// D:\program\google\tool\test_suite.mjs
// Automated Test Suite: Menguji seluruh modul program terhadap artefak analisis nyata

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPayload, classifyArtifact } from './gws_classifier.mjs';
import { decodeBootstrapPayload, inspectWasmBinary } from './wasm_verifier.mjs';
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
  assert(wasmInfo.compilation.requiresV8BleedingEdge === true, 'Deteksi feature gap V8 (explicit supertype) teridentifikasi');

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
    addEventListener() {}, removeEventListener() {}, appendChild(c) { this.children.push(c); if (c) c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    focus() {}, select() {}, blur() {}, insertBefore(c) { return this.appendChild(c); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; },
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
