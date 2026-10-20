#!/usr/bin/env node
// D:\program\google\tool\cli.mjs
// CLI Analisis & Verifikasi Engine Google Workspace

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPayload, classifyArtifact } from './gws_classifier.mjs';
import { decodeBootstrapPayload, inspectWasmBinary } from './wasm_verifier.mjs';
import { KixTileEngine, PunchSvgEngine, RitzGridEngine } from './engine_prototypes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0] || 'help';

function printHeader(title) {
  console.log(`\n==================================================`);
  console.log(` ${title}`);
  console.log(`==================================================`);
}

switch (command) {
  case 'classify-html': {
    const targetFile = args[1];
    if (!targetFile || !fs.existsSync(targetFile)) {
      console.error('Usage: cli.mjs classify-html <path_to_html_or_text>');
      process.exit(1);
    }
    const content = fs.readFileSync(targetFile, 'utf8');
    const result = classifyPayload(content);
    printHeader('HASIL KLASIFIKASI PAYLOAD');
    console.log(JSON.stringify(result, null, 2));
    break;
  }

  case 'analyze-artifacts': {
    const artifactDir = args[1] || path.resolve(__dirname, '../public/raw-cdp2');
    printHeader(`ANALISIS ARTEFAK DARI: ${artifactDir}`);
    const files = ['docs.json', 'slides.json', 'sheets.json'];
    for (const f of files) {
      const fullPath = path.join(artifactDir, f);
      if (fs.existsSync(fullPath)) {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const analysis = classifyArtifact(data);
        console.log(`\n[TARGET: ${f.toUpperCase()}]`);
        console.log(`  Judul       : ${analysis.title}`);
        console.log(`  Engine      : ${analysis.engine}`);
        console.log(`  Arsitektur  : ${analysis.architecture}`);
        console.log(`  Surface     : Canvas=${analysis.surfaceMetrics.canvas}, SVG=${analysis.surfaceMetrics.svg}, DOM=${analysis.surfaceMetrics.nodes}`);
        console.log(`  App Worker  : ${analysis.workerMetrics.realAppWorkers} (Ekstensi Chrome difilter: ${analysis.workerMetrics.extensionWorkers})`);
        console.log(`  Scroll Uji  : Axis=${analysis.scrollEvaluation.axis}, Moved=${analysis.scrollEvaluation.scrollMoved}, DeltaCanvas=${analysis.scrollEvaluation.canvasDelta}`);
        console.log(`  Interpretasi: ${analysis.scrollEvaluation.interpretation}`);
      } else {
        console.log(`\n[!] File artefak tidak ditemukan: ${f}`);
      }
    }
    break;
  }

  case 'verify-wasm': {
    const wasmPath = args[1] || path.resolve(__dirname, '../public/sheets/calcworker_wasm_cd.wasm');
    const wbParam = args[2] || "W251bGwsbnVsbCxudWxsLCJodHRwczovL2RvY3MuZ29vZ2xlLmNvbS9zdGF0aWMvc3ByZWFkc2hlZXRzMi9jbGllbnQvd2FzbS8yNDczMjA5MDY4LWNhbGN3b3JrZXJfd2FzbV9jZC53YXNtIl0=";
    printHeader('VERIFIKASI BINARY WASM & DECODE BOOTSTRAP WORKER');
    console.log(`1. Decode parameter wb=:`);
    const dec = decodeBootstrapPayload(wbParam);
    console.log(`   JSON: ${dec.rawJson}`);
    console.log(`   URL WASM: ${dec.wasmUrl}`);

    console.log(`\n2. Analisis Biner WASM (${wasmPath}):`);
    const bin = inspectWasmBinary(wasmPath);
    if (!bin.success) {
      console.error(`   Error: ${bin.error}`);
    } else {
      console.log(`   Ukuran Biner    : ${bin.sizeBytes.toLocaleString()} bytes`);
      console.log(`   Magic Valid     : ${bin.isWasmMagic} (hex: ${bin.magicHex})`);
      console.log(`   SHA-256         : ${bin.sha256}`);
      console.log(`   Total Section   : ${bin.sectionCount}`);
      console.log(`   Daftar Section  : ${bin.sections.slice(0, 8).join(', ')} ...`);
      console.log(`   V8 Kompilasi    : ${bin.compilation.compiled ? 'BERHASIL' : 'GAGAL (Expected Feature Gap)'}`);
      console.log(`   Keterangan ABI  : ${bin.compilation.note}`);
      if (bin.compilation.error) {
        console.log(`   Pesan Engine V8 : ${bin.compilation.error}`);
      }
    }
    break;
  }

  case 'run-prototypes': {
    printHeader('EKSEKUSI PROTOTIPE ARSITEKTUR ENGINE');
    console.log('\n[1. KIX TILE ENGINE (DOCS)]');
    const kix = new KixTileEngine(10);
    console.log(`  Inisialisasi 10 halaman. Visible canvas tiles: ${kix.mountedTiles.size}, Total DOM: ${kix.totalDomNodes}`);
    const scroll1 = kix.scrollTo(2500);
    console.log(`  Scroll ke y=2500px -> Visible tiles: ${scroll1.mountedCanvasCount}, Halaman aktif: [${scroll1.visiblePages.join(', ')}], DOM: ${scroll1.totalDomNodes}`);

    console.log('\n[2. PUNCH SVG ENGINE (SLIDES)]');
    const punch = new PunchSvgEngine(3);
    console.log(`  Inisialisasi 3 slide. Canvas count: ${punch.canvasCount} (Strict 0 canvas)`);
    punch.selectSlide(1);
    const svgStr = punch.renderActiveSlideSvg();
    console.log(`  Render slide 2 ke SVG scene graph -> Root <svg>, node count shapes: ${punch.slides[1].shapes.length}`);
    console.log(`  Cuplikan SVG:\n${svgStr.split('\n').slice(0, 4).join('\n')}\n  ...`);

    console.log('\n[3. RITZ GRID ENGINE (SHEETS)]');
    const ritz = new RitzGridEngine(10000, 26);
    console.log(`  Inisialisasi grid 10.000 baris x 26 kolom. Canvas count: ${ritz.canvasCount} (Strict 1 single canvas)`);
    const rScroll = ritz.handleVirtualScroll(200, 500);
    console.log(`  Virtual scroll (dx=200, dy=500) -> Window: R${rScroll.visibleWindow.startRow}:C${rScroll.visibleWindow.startCol} s/d R${rScroll.visibleWindow.endRow}:C${rScroll.visibleWindow.endCol}`);
    console.log(`  Canvas count setelah scroll: ${rScroll.canvasCount} (Invarian)`);

    ritz.dispatchCalculation('C1', '=SUM(10, 25, 65)').then(res => {
      console.log(`  Async Calc Worker Dispatch: Sel ${res.cellCoord} ${res.formula} = ${res.calculatedValue} (via ${res.processedBy})`);
    });
    break;
  }

  default:
    console.log(`
Usage:
  node cli.mjs classify-html <file>       Klasifikasi isi HTML (soft-404 vs real editor)
  node cli.mjs analyze-artifacts [dir]   Audit artefak JSON dari raw-cdp2
  node cli.mjs verify-wasm [wasm] [wb]   Verifikasi biner WASM Sheets & decode wb=
  node cli.mjs run-prototypes            Jalankan purwarupa Kix, Punch, dan Ritz
`);
    break;
}
