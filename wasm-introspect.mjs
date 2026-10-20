#!/usr/bin/env node
/**
 * wasm-introspect.mjs — REAL WebAssembly.Module introspection (no hand parser).
 * Node's own WASM engine gives the authoritative import/export ABI.
 * Usage: node wasm-introspect.mjs <file.wasm> <out.json>
 */
import fs from 'node:fs';

const [wasmPath, outPath] = process.argv.slice(2);
const buf = fs.readFileSync(wasmPath);
const out = { file: wasmPath, bytes: buf.length, magic: buf.subarray(0,4).toString('hex'), version: buf.readUInt32LE(4) };

try {
  const mod = new WebAssembly.Module(buf);
  const imports = WebAssembly.Module.imports(mod);
  const exports = WebAssembly.Module.exports(mod);
  out.compiled = true;
  out.importCount = imports.length;
  out.exportCount = exports.length;
  const byMod = {};
  for (const i of imports) { byMod[i.module] = byMod[i.module] || { count: 0, kinds: {}, names: [] };
    byMod[i.module].count++; byMod[i.module].kinds[i.kind] = (byMod[i.module].kinds[i.kind] || 0) + 1;
    if (byMod[i.module].names.length < 12) byMod[i.module].names.push(i.name); }
  out.importsByModule = Object.fromEntries(Object.entries(byMod).sort((a,b)=>b[1].count-a[1].count));
  const byKind = {};
  for (const e of exports) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  out.exportsByKind = byKind;
  out.exportNames = exports.map((e)=>e.name);
  out.exportSample = exports.slice(0, 40).map((e)=>`${e.kind}:${e.name}`);
  // custom sections are where producers stash names
  for (const name of ['name','producers','target_features','linking','dylink.0']) {
    try { const s = WebAssembly.Module.customSections(mod, name); if (s && s.length) out[`custom_${name}`] = s.map((x)=>x.byteLength); } catch {}
  }
  console.log('COMPILED ok | imports', imports.length, '| exports', exports.length, '|', JSON.stringify(out.exportsByKind));
  console.log('import modules:', Object.entries(byMod).map(([m,v])=>`${m}(${v.count})`).join(', '));
} catch (e) {
  out.compiled = false; out.compileError = String(e && e.message || e);
  console.log('COMPILE FAILED:', out.compileError);
}
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log('wrote', outPath);
