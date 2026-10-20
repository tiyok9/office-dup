// D:\program\google\tool\wasm_verifier.mjs
// Verifikasi binary WASM Google Sheets & decode payload bootstrap worker

import fs from 'node:fs';
import crypto from 'node:crypto';

export function decodeBootstrapPayload(wbParam) {
  if (!wbParam) {
    return { success: false, error: 'Parameter wb kosong' };
  }
  try {
    const raw = Buffer.from(wbParam, 'base64').toString('utf8');
    const parsed = JSON.parse(raw);
    const wasmUrl = Array.isArray(parsed) ? parsed.find(x => typeof x === 'string' && x.endsWith('.wasm')) : null;
    return {
      success: true,
      rawJson: raw,
      parsedArray: parsed,
      wasmUrl: wasmUrl || null
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Pola pesan V8 yang menandakan binary memakai fitur Wasm modern
// (WasmGC custom descriptors / explicit supertype). Diekspor agar tes dan
// verifier memakai SATU sumber kebenaran (hindari drift).
// Catatan: V8 lama melaporkan konstruk yang sama sebagai "unknown type form: 77"
// (type form 0x4D belum dikenali), V8 baru sebagai "descriptor types need ...".
export const V8_GAP_PATTERNS = [
  'explicit supertype',
  'invalid type',
  'descriptor types',
  'custom-descriptors',
  'unknown type form'
];

export function isV8FeatureGap(message) {
  const msg = String(message || '');
  return V8_GAP_PATTERNS.some(p => msg.includes(p));
}

export function inspectWasmBinary(filePath) {
  if (!fs.existsSync(filePath)) {
    return { success: false, error: `File tidak ditemukan: ${filePath}` };
  }

  const buf = fs.readFileSync(filePath);
  const size = buf.length;
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  // Periksa WebAssembly magic bytes: \0asm (0x00, 0x61, 0x73, 0x6d) & version 1 (0x01, 0x00, 0x00, 0x00)
  const isWasmMagic = buf.length >= 8 &&
    buf[0] === 0x00 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d &&
    buf[4] === 0x01 && buf[5] === 0x00 && buf[6] === 0x00 && buf[7] === 0x00;

  // Baca section headers dasar
  const sections = [];
  let offset = 8;
  const SECTION_NAMES = [
    'custom', 'type', 'import', 'function', 'table',
    'memory', 'global', 'export', 'start', 'element',
    'code', 'data', 'data_count'
  ];

  while (offset < buf.length) {
    const id = buf[offset++];
    // Read LEB128 length
    let len = 0;
    let shift = 0;
    while (offset < buf.length) {
      const byte = buf[offset++];
      len |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    const name = SECTION_NAMES[id] || `section_${id}`;
    sections.push({ id, name, offset, length: len });
    offset += len;
  }

  // Uji kompilasi dengan WebAssembly.Module (Node.js engine V8)
  let compilationSuccess = false;
  let compilationError = null;
  let requiresCustomDescriptors = false;

  try {
    new WebAssembly.Module(buf);
    compilationSuccess = true;
  } catch (err) {
    compilationError = err.message;
    if (isV8FeatureGap(err.message)) {
      requiresCustomDescriptors = true;
    }
  }

  return {
    success: true,
    filePath,
    sizeBytes: size,
    sha256,
    isWasmMagic,
    magicHex: buf.subarray(0, 8).toString('hex'),
    sectionCount: sections.length,
    sections: sections.map(s => `${s.name} (${s.length} B)`),
    compilation: {
      compiled: compilationSuccess,
      error: compilationError,
      requiresV8BleedingEdge: requiresCustomDescriptors,
      // CATATAN: note HARUS konsisten dengan hasil kompilasi.
      // Dulu: gagal-kompilasi tapi note bilang "Standar 1.0/2.0" (kontradiksi).
      note: compilationSuccess
        ? 'Standar WebAssembly 1.0/2.0'
        : (requiresCustomDescriptors
            ? 'Memerlukan fitur WasmGC / Custom Descriptors modern yang aktif di Chrome 155'
            : `Gagal dikompilasi oleh V8 runtime ini: ${compilationError}`)
    }
  };
}
