# Arsitektur & Reverse Engineering Engine Google Docs (Kix)

Dokumen Uji: 2002 Nominee List (1).docx (Public View-Only)
URL: https://docs.google.com/document/d/0B2DZqTRLDhefWTFjWTVKeWMwalE/edit
Production Bundle: docs.client_js_prod_integrated (51 script chunks, 16.45 MB total)
Tanggal Observasi: 2026-10-19

---

## 1. Paradigma Rendering: Multi-Canvas Tile

Berbeda dengan editor berbasis DOM tradisional (seperti Notion, ProseMirror, atau CKEditor), Google Docs **tidak merender teks dokumen sebagai elemen HTML**.

### Karakteristik Permukaan Render:
- **Surface:** Multi-canvas tiles (`<canvas class="kix-canvas-tile-content">`).
- **Paginasi Fisik:** Dokumen dibagi ke dalam container halaman (`div.kix-page`), dan setiap viewport halaman memuat elemen `<canvas>` individual.
- **Font Shaping & Glyph Drawing:** Google Docs mengimplementasikan parser font dan layout engine sendiri di JavaScript (`m=kix_core`, `m=kix_app`). Layout garis, hyphenation, kerning, dan word wrapping dihitung secara manual di JS, lalu glyph digambar langsung ke 2D context canvas.
- **Uji Invariansi Scroll (Empirical Proof):**
  - Viewport: 1280x900
  - Posisi Awal (y=0): Total DOM = 1.648 node, Canvas = 3 elemen.
  - Setelah Scroll (y=3000px): Total DOM = 1.650 node (Delta = +2 node), Canvas = 4 elemen (Delta = +1 tile).
  - **Kesimpulan:** Virtualisasi berbasis tile terkonfirmasi. Menambah scroll sejauh ribuan pixel tidak menambah ribuan node teks ke DOM; DOM hanya mengelola container halaman aktif dan 3–4 canvas tile aktif.

---

## 2. Arsitektur Event & Input Handling

Karena canvas bersifat statis terhadap seleksi teks DOM bawaan browser, Google Docs menggunakan arsitektur **Hidden Input Interceptor**:
- **Hidden Input Layer:** Elemen tersembunyi berkelas `docs-texteventtarget-iframe` atau iframe tersembunyi dengan listener keyboard/clipboard.
- **IME & Keyboard Capture:** Saat pengguna mengklik canvas, fokus diarahkan ke textarea/iframe tersembunyi ini sehingga browser memicu event IME, keydown, keypress, paste, dan copy secara standar.
- **Selection Overlay:** Seleksi teks tidak menggunakan highlight browser bawaan, melainkan layer SVG/DOM transparan berkoordinat tepat di atas glyph yang dipilih pada canvas.

---

## 3. Worker & WebAssembly (WASM) Audit

- **Web Worker:** **0 App Worker**. Probe CDP pada browser bersih memastikan Docs tidak menjalankan Dedicated Worker kalkulasi. Target worker yang sempat terdeteksi pada putaran sebelumnya terbukti merupakan Service Worker ekstensi Chrome lokal.
- **WebAssembly:** **TIDAK ADA**. Tidak ditemukan pemanggilan `WebAssembly.instantiate`, tidak ada chunk `.wasm`, dan static grep pada 12 chunk JS utama menghasilkan 0 hit WASM.
- **Komputasi:** Layouting dan formatting teks sepenuhnya dieksekusi pada main thread JS (`m=kix_core`).

---

## 4. Modul Kunci

- `kix_app`: Bootstrap UI, editor toolbar, layout host.
- `kix_core`: Model dokumen internal, struktur paragraph/run, layout engine garis.
- `kix_nestedsketchycore`: Canvas drawing routines, drawing primitive shapes & lines.
- `kix_docos`: Sistem komentar dan anotasi kolaboratif.
- `kix_pre_tertiary_deps` & `kix_tertiary`: Fitur lanjutan (spellcheck, grammar, citation).
