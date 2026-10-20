# Arsitektur & Reverse Engineering Engine Google Slides (Punch)

Dokumen Uji: KRUŠEVAC NEKRETNINE (Public View-Only)
URL: https://docs.google.com/presentation/d/1--vRBDTp0pf_Eck2Ga8XffBWn7gbUpnbuehkRnJE8vg/edit
Production Bundle: presentations.editor_js_prod_integrated (49 script chunks, 14.21 MB total)
Tanggal Observasi: 2026-10-19

---

## 1. Paradigma Rendering: Pure Vector SVG Scene Graph

Berbeda secara fundamental dari Google Docs (canvas tile) dan Google Sheets (single canvas grid), Google Slides adalah **aplikasi berbasis SVG murni**.

### Karakteristik Permukaan Render:
- **Surface:** **0 `<canvas>`**. Elemen canvas sama sekali tidak digunakan untuk kanvas presentasi.
- **SVG Scene Graph:** Halaman editor memuat **17 elemen `<svg>`** dengan lebih dari **950 node anak SVG** (`<g>`, `<text>`, `<rect>`, `<path>`, `<image>`).
- **Teks sebagai DOM:** Teks pada slide dievaluasi dan dirender langsung sebagai elemen native SVG `<text>` dan `<tspan>`. Browser menangani rendering font dan anti-aliasing secara native melalui engine vektor SVG browser.
- **Komposisi Bentuk & Layer:** Setiap kotak teks, bentuk (shape), dan garis adalah elemen vector grafis terpisah di dalam pohon SVG, memungkinkan transformasi matriks SVG (`transform="matrix(...)"`) untuk rotasi, skala, dan translasi.

---

## 2. Navigasi & Karakteristik Scroll

- **Model Presentasi (Paged Deck):** Slides tidak menggunakan scroll dokumen kontinu tak-hingga seperti Docs atau Sheets.
- **Scroll Workspace Terbatas:** Container workspace hanya memiliki `maxScroll: 119px` (penyesuaian margin/zoom).
- **Virtualisasi Slide:** Navigasi antar-slide dilakukan melalui seleksi thumbnail slide di panel kiri, bukan melalui continuous infinite scroll.

---

## 3. Worker & WebAssembly (WASM) Audit

- **Web Worker:** **0 App Worker**. Probe CDP pada browser bersih memastikan Slides tidak menjalankan Worker background. Target worker yang sempat terlihat pada probe awal terbukti merupakan Service Worker ekstensi browser lokal.
- **WebAssembly:** **TIDAK ADA**. 0 pemanggilan WASM, 0 binary `.wasm`.
- **Komputasi:** Layouting vektor, penataan z-index, dan transformasi matriks sepenuhnya ditangani oleh main thread JS (`m=app`, `m=core`, `m=tertiary`).

---

## 4. Modul Kunci

- `app`: Inisialisasi editor slide, toolbar, thumbnail strip.
- `core`: Struktur data presentasi, slide tree, shape model.
- `tertiary` & `pretertiarydeps`: Komponen rendering vektor tingkat lanjut dan layout helper.
- `docos`: Sistem komentar dan diskusi kolaboratif.
