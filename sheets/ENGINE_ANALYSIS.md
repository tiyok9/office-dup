# Arsitektur & Reverse Engineering Engine Google Sheets (Ritz/Waffle)

Dokumen Uji: Example Spreadsheet (Public View-Only)
URL: https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit
Production Bundle: spreadsheets.waffle_js_prod (53 script chunks, 16.44 MB total)
Tanggal Observasi: 2026-10-19

---

## 1. Paradigma Rendering: Single Canvas Virtualized Grid

Google Sheets tidak merender sel spreadsheet sebagai tag `<table>`, `<tr>`, atau `<td>`.

### Karakteristik Permukaan Render:
- **Surface:** Single `<canvas>` viewport (`div.grid4-inner-container canvas`).
- **Virtualisasi Ekstrem:** Seluruh grid data (baris 1 s/d jutaan, kolom A s/d ZZZ) digambar ke dalam **satu elemen `<canvas>` tunggal**.
- **Repaint on Scroll:** Saat grid digeser, koordinat offset sel dihitung ulang dan digambar ulang (repainted) pada canvas buffer.
- **Uji Scroll (Empirical Observation):**
  - Viewport: 1280x900
  - Posisi Awal (x=0): Total DOM = 1.691 node, Canvas = 1 elemen.
  - Percobaan Scroll Horizontal (x=3000px): Hasil probe menunjukkan `scrollMoved: false` dan `contentChanged: false` (Delta DOM = -1 node).
  - **Catatan Integritas Data:** Manipulasi langsung `element.scrollLeft += 3000` pada host DOM luar diabaikan oleh Google Sheets karena aplikasi mencegat event input (wheel/touch/keyboard) secara custom dan mengelola koordinat virtual kanvasnya sendiri. Oleh karena itu, pengujian scroll programatik ini **tidak menggeser kanvas** (`scrollMoved: false`). Secara arsitektur, seluruh grid dirender ke dalam satu canvas tunggal, namun uji invariansi scroll dinamis tercatat *belum teruji via scroll programatik DOM*.

---

## 2. Editor & Floating Overlay

- **In-Cell Editor:** Saat sel aktif diedit, elemen `<textarea>` atau `<input>` mengambang (floating overlay) diposisikan secara presisi di atas koordinat sel pada canvas.
- **Formula Bar:** Komponen input terpisah di bagian atas (`class="formula-bar-text-content"`) tersinkronisasi dua arah dengan sel aktif.

---

## 3. Web Worker & WebAssembly (WASM) Engine (CONFIRMED)

Berbeda dari Docs dan Slides, Google Sheets memisahkan komputasi kalkulasi spreadsheet dari UI thread.

### Bukti Empiris:
1. **Dedicated Calculation Worker:**
   - Script Host: `https://docs.google.com/spreadsheets/j2clritzapp/static/client/js/2389023624-calcworkerhost_custom_descriptors_core_custom_descriptors.js`
   - Ukuran Host JS: 1.081.152 bytes (1,05 MB).
2. **WebAssembly Binary (`calcworker_wasm_cd.wasm`):**
   - URL: `https://docs.google.com/static/spreadsheets2/client/wasm/2473209068-calcworker_wasm_cd.wasm`
   - Ukuran Binary: **3.945.915 bytes (~3,76 MB)**.
   - Magic Header: `\x00asm\x01\x00\x00\x00` (hex: `0061736d01000000`).
   - SHA-256: `f4b2aa1d3a984f01c3e7f282eb231c0c5ed12f4e4a986ec6bca619a625b6c09e`.
   - V8 Feature Requirement: Memerlukan fitur *WASM Custom Descriptors & Typed Function References* (`--experimental-wasm-custom-descriptors`). Kompilasi menggunakan engine Node 24 V8 menghasilkan error `type 24 has invalid explicit supertype 23`, membuktikan binary memanfaatkan ekstensi WasmGC/Custom Descriptors bleeding-edge yang didukung pada runtime Chrome 155 terbaru.
   - Sumber Kompilasi: Berasal dari model J2CL (Java-to-Closure/WASM) atau core C++ Google Calculation Engine untuk evaluasi fungsi matematika, dependensi sel, dan parsing formula secara performant di background thread.
   - Status Worker Attachment: Target worker terdeteksi dan URL instansiasi terekam via instrumentasi `window.Worker`, namun attach CDP via `Runtime.enable` mengalami timeout (eksekusi worker berada di sandbox terisolasi).

---

## 4. Modul Kunci

- `ritzmain` & `ritzmaestro`: Orkestrator grid utama dan manajemen thread kalkulator.
- `ritzgenblocks` & `ritzbuildingblocks`: Logika sel, format cell data, evaluasi tipe data.
- `namedtables` & `columnsmith`: Pengelolaan struktur tabel dan metadata kolom.
- `postshellbase`: Bootstrap spreadsheet state.
