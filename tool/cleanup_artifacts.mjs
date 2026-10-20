// D:\program\google\tool\cleanup_artifacts.mjs
// Hapus HANYA dokumen artefak hasil pengujian; sisakan dokumen kanonik/seed.
//
// Kenapa perlu: pengujian E2E benar-benar mengetik lalu autosave menyimpan,
// sehingga dokumen uji menumpuk di Drive. Skrip ini membersihkannya tanpa
// menyentuh dokumen yang dibuat user.
//
// Pakai: node cleanup_artifacts.mjs [--dry]
//   --dry  hanya menampilkan apa yang AKAN dihapus (tidak mengubah apa pun)

import { listDocuments, deleteDocument, getDocument } from './store.mjs';

const KANONIK = new Set(['docs-2002-nominee', 'sheets-example', 'slides-krusevac']);
const JUDUL_UJI = [
  'Tanpa Judul',            // "Dokumen Tanpa Judul", "Spreadsheet Tanpa Judul", dst.
  'Salinan dari',           // hasil tombol "Buat salinan"
  'DIPERBARUI OLEH USER'
];
const DRY = process.argv.includes('--dry');

const files = listDocuments();
const akanHapus = [];
const disimpan = [];

for (const f of files) {
  const isKan = KANONIK.has(f.id);
  const judulUji = JUDUL_UJI.some(t => String(f.title || '').includes(t));
  if (!isKan && judulUji) akanHapus.push(f);
  else disimpan.push(f);
}

console.log(`${DRY ? '[DRY-RUN] ' : ''}Total dokumen: ${files.length} — akan dihapus: ${akanHapus.length}, disimpan: ${disimpan.length}`);
for (const f of akanHapus) console.log(`  - HAPUS   ${f.id.padEnd(22)} ${String(f.type).padEnd(7)} ${f.title}`);
for (const f of disimpan) console.log(`  + SIMPAN  ${f.id.padEnd(22)} ${String(f.type).padEnd(7)} ${f.title}`);

if (!DRY) {
  let n = 0;
  for (const f of akanHapus) {
    // Pengaman terakhir: dokumen kanonik TIDAK PERNAH dihapus.
    if (KANONIK.has(f.id)) continue;
    if (deleteDocument(f.id)) n++;
  }
  const sisa = listDocuments();
  console.log(`\nDihapus: ${n}. Sisa dokumen: ${sisa.length}`);
  for (const f of sisa) console.log(`  ${f.id.padEnd(22)} ${String(f.type).padEnd(7)} ${f.title}`);
}