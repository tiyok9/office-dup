// D:\program\google\tool\reset_demo.mjs
// Pulihkan 3 dokumen contoh (Docs/Sheets/Slides) ke data kanonik.
//
// Kenapa perlu: pengujian E2E benar-benar mengetik dan menyimpan lewat autosave
// (itu memang tujuannya — menguji sebagai user nyata), sehingga isi dokumen
// contoh ikut berubah. Skrip ini mengembalikan demo ke keadaan rapi.
// Dokumen LAIN milik user tidak disentuh.

import { initSeedData, resetSeedData, listDocuments } from './store.mjs';

initSeedData();
const n = resetSeedData();
const files = listDocuments();

console.log(`Dipulihkan: ${n} dokumen contoh (docs-2002-nominee, sheets-example, slides-krusevac)`);
console.log(`Total dokumen di Drive sekarang: ${files.length}`);
files.forEach(f => console.log(`  - ${f.id.padEnd(24)} ${String(f.type).padEnd(7)} ${f.title}`));
