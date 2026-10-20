# REA — Reverse Engineering Aplikasi Web Google Workspace
## Docs · Slides · Sheets

Tanggal    : 2026-10-19
Alat       : REA (rea-agents 6.5.0) via MCP `mcp__rea__*` + CLI
Metode     : CDP observation (read-only) — INSTANCE SCRATCH HEADLESS TERPISAH
Browser    : Chrome 155.0.8059.80 (headless, profile throwaway, port 9333 — sudah dimatikan)
Objek uji  : dokumen PUBLIK "view only" milik orang lain (tanpa login, tanpa menyentuh akun Anda)

> Catatan penting: instance 9333 adalah profil sekali-pakai TANPA login. Analisis
> ini TIDAK memakai sesi Chrome Anda yang sudah login, dan tidak ada dokumen
> akun Anda yang dibaca.

---

## 1. Ringkasan — TIGA PRODUK, TIGA ENGINE BERBEDA

| Aspek              | Docs                     | Slides                   | Sheets                    |
|--------------------|--------------------------|--------------------------|---------------------------|
| Doc uji (publik)   | 2002 Nominee List .docx  | KRUŠEVAC NEKRETNINE      | Example Spreadsheet       |
| Prod bundle        | docs.client_js_prod_integrated | presentations.editor_js_prod_integrated | spreadsheets.waffle_js_prod |
| Prefiks modul      | **kix_***                | (tanpa prefiks) app/core/tertiary | **ritz*** / waffle |
| Script dianalisis  | 51                       | 49                       | 53                        |
| Total byte bundle  | 17.250.107 (16,45 MB)    | 14.902.940 (14,21 MB)    | 17.237.559 (16,44 MB)     |
| AST node visited   | 6.688.974                | 5.888.736                | 5.837.339                 |
| parse_failures     | 0                        | 0                        | 0                         |
| DOM node           | 2.229                    | 1.910                    | 2.135                     |
| a11y node          | 361                      | 808                      | 392                       |
| `<canvas>`         | 2                        | **0**                    | 1                         |
| `<svg>`            | 2                        | **18**                   | 6                         |
| `<iframe>`         | 4                        | 6                        | 3                         |
| Surface render     | kanvas berbasis-tile     | **SVG + raster tertanam** | kanvas grid              |
| Verifikasi visual  | editor asli, teks terbaca | view-only, slide ter-render | view-only, grid A–F/1–12 |

**Bukti kunci (OBSERVED):** irisan nama modul khas ketiganya **kosong**.
`kix_*` tidak ada di Slides/Sheets; `ritz*` tidak ada di Docs/Slides.
Yang sama hanya infrastruktur lintas-produk (`docos`, `approvals`, `core`,
`peoplehovercard`, `emojidata`) — itu **tidak** membuktikan renderer bersama.

---

## 2. DOCS — detail

- URL: https://docs.google.com/document/d/0B2DZqTRLDhefWTFjWTVKeWMwalE/edit
- Judul: "2002 Nominee List (1).docx - Google Dokumen" (badge .DOCX, tombol "Minta akses edit")
- Modul khas: `kix_app`, `kix_docos`, `kix_core`, `kix_tertiary`,
  `kix_nestedsketchycore`, `kix_pre_tertiary_deps`, `kix_approvals`, `voice`
- Static: 3 route, 1 endpoint, 1.737 inference, 0 unknown
- Dynamic: canvas=2, svg=2, iframe=4 → permukaan kanvas (tile), bukan DOM teks
- Verifikasi visual: **dokumen asli ter-render**, paragraf terbaca
  (mis. "BRAVO, LIVINGSTONE MOUSE!", "DEAR DAISY GET WELL SOON")

## 3. SLIDES — detail

- URL: https://docs.google.com/presentation/d/1--vRBDTp0pf_Eck2Ga8XffBWn7gbUpnbuehkRnJE8vg/edit
- Judul: "KRUŠEVAC NEKRETNINE - Google Slide"
- Modul khas: `tertiary`, `app`, `core`, `pretertiarydeps`
- Static: 3 route, 1 endpoint, 1.764 inference, 0 unknown
- Dynamic top-tag: `g`=662, `#text`=352, `text`=182, `rect`=40, `path`=35, `svg`=18
- **canvas = 0** → bukan kanvas. Teks asli sebagai node `<text>` SVG.
- Verifikasi visual: "Hanya lihat" (view-only), 3 thumbnail slide, konten + gambar situs ter-render

## 4. SHEETS — detail

- URL: https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit
- Judul: "Example Spreadsheet - Google Spreadsheet"
- Modul khas: `ritzgenblocks`, `ritzmaestro`, `ritzmain`, `ritzbuildingblocks`,
  `postshellbase`, `namedtables`, `chips`, `edit`, `assistant`, `revisions`, `onepick`
- Static: 3 route, 0 endpoint, 777 inference, 0 unknown
- Dynamic: canvas=1, svg=6, iframe=3
- Verifikasi visual: grid A–F / baris 1–12 berisi data siswa, formula bar "Student Name", tab "Class Data"

---

## 5. CAVEAT — yang BELUM terbukti (jangan dibaca sebagai PASS penuh)

1. **Worker / WASM: UNVERIFIED.** Pada ketiga app `workers = 0`, TAPI section
   `workers` masuk `policy_filtered` untuk Docs & Sheets. Jadi "tidak ada worker"
   **bukan bukti ketiadaan** — hanya "tidak teramati pada jendela itu".
   Pencarian string `.wasm` pada URL chunk = 0, tetapi itu **lemah**: kata itu
   hidup di *body* JS, bukan di URL (pitfall #25). Perlu enumerasi target CDP
   (`curl /json/list`, cari `"type":"worker"`) untuk membuktikan.
2. **Endpoint & route: sinyal lemah.** Docs/Slides melaporkan 1 endpoint bernilai
   KOSONG; Sheets 0 endpoint. Hanya 3 route per app yang terbaca. Bundle
   terminifikasi — jangan jadikan dasar klaim protokol.
3. **Test invariansi-under-scroll BELUM dijalankan** pada sesi ini. Klaim
   virtualisasi kanvas Sheets dari sesi sebelumnya adalah hipotesis terpisah;
   di sini saya hanya melaporkan hitungan statis satu viewport 764×485.
4. **Hitungan canvas/DOM adalah f(viewport, scroll-state).** Angka di atas hanya
   valid untuk viewport headless 764×485 pada posisi scroll awal.
5. **Bundle byte = ukuran arsip sumber**, bukan ukuran setelah dieksekusi.
   Analisis statis **tidak mengeksekusi** kode apa pun.
6. **Nama modul = OBSERVED; arsitektur yang disimpulkan = INFERRED.**
7. Sumber data: `source_artifacts` melaporkan `text_available: true` untuk
   semua, tetapi teks JS tidak disimpan inline (field `text` absen) — export byte
   penuh perlu `export-web-scripts`.

---

## 6. PITFALL BARU yang ditemukan sesi ini

**Google membalas HTTP 200 untuk dokumen yang TIDAK ADA (soft-404).**
Target Docs pertama saya lulus probe `curl` dengan status **200**, tetapi Chrome
menampilkan **"Halaman Tidak Ditemukan"** — DOM hanya 44 node, 1 script, 0 canvas.
Probe status-code saja **tidak cukup**. Harus klasifikasi dari **isi payload**:
- tanda soft-404: "Halaman Tidak Ditemukan", "Page not found", "unable to open the file"
- tanda dokumen asli: ada `kix_`, `kix-canvas-tile-content`, `docs-editor`
Setelah klasifikasi ulang dari isi, saya dapat target Docs valid (323.460 B).

**Peluncuran Chrome dari git-bash:** `cmd //c start "" "..."` **gagal total**
(hanya memunculkan banner cmd.exe, port 9222 tetap kosong). Yang berhasil:
`powershell.exe -NoProfile -Command "Start-Process -FilePath ... -ArgumentList ..."`.
Selalu verifikasi: `netstat -ano | grep :PORT` + `curl /json/version` SEBELUM
memanggil tool REA.

---

## 7. Investigasi CDP Mentah & Resolusi 3 Caveat (Fase Tuntas)

Mengatasi keterbatasan `policy_filtered_sections` REA dengan probe CDP langsung (Chrome 155, instance terisolasi per aplikasi):

### Caveat 1: Worker & WebAssembly (WASM)
- **Docs & Slides:** **0 App Worker & 0 WASM**. Kemunculan worker pada run awal terbukti Service Worker ekstensi browser lokal (`chrome-extension://...`). Komputasi layout teks dan vektor 100% pada main thread JS.
- **Sheets:** **TERKONFIRMASI**.
  - 1 Dedicated Calculation Worker: `calcworkerhost_...js?wb=[base64]`
  - Decode `wb=`: `https://docs.google.com/static/spreadsheets2/client/wasm/2473209068-calcworker_wasm_cd.wasm`
  - Binary WASM: **3.945.915 bytes**, magic `0061736d`, SHA-256 `f4b2aa1d3a984f01c3e7f282eb231c0c5ed12f4e4a986ec6bca619a625b6c09e`.
  - V8 ABI: Memerlukan fitur *WasmGC / Custom Descriptors* (`--experimental-wasm-custom-descriptors`). Kompilasi Node 24 V8 menghasilkan `type 24 has invalid explicit supertype 23`, membuktikan binary memanfaatkan ekstensi V8 modern.

### Caveat 2: Invariansi Render di Bawah Scroll
- **Docs:** **Terbukti Tile Virtualization**. Scroll vertikal y=3000px menghasilkan `scrollMoved: true`, total DOM 1.648 -> 1.650 (+2 node), canvas 3 -> 4 (+1 canvas tile mounted).
- **Slides:** **N/A (Model Slide Deck)**. Navigasi berbasis slide/thumbnail. `maxScroll: 119px`, rendering vektor murni 17 root `<svg>`.
- **Sheets:** **Single Canvas Grid (Virtual Scroll Custom)**. Grid dirender ke 1 elemen canvas tunggal. Uji scroll programatik DOM `scrollLeft += 3000` mencatat `scrollMoved: false` karena Sheets mencegat koordinat input kanvas secara kustom; invariansi dinamis via manipulasi DOM langsung tercatat *belum teruji*.

### Caveat 3: Protokol Jaringan & Real-Time Sync
- **WebSocket:** **0 koneksi aktif** (`webSockets: []`, `wsFrames: 0` pada mode view-only publik).
- **Transport:** Menggunakan Google BrowserChannel / WebChannel over HTTP POST long-polling (`/bind`, `/test`, `batchexecute`).
- **Operational Transformation (OT):** Static grep body bundle JS membuktikan mesin OT aktif (Docs: 226 pola revisi; Slides: 225 pola; Sheets: **711 pola mutasi**).

---

## 8. Dokumen Analisis Teknis Lengkap

Spesifikasi terperinci telah ditulis di:
- `D:\program\google\docs\ENGINE_ANALYSIS.md`
- `D:\program\google\slides\ENGINE_ANALYSIS.md`
- `D:\program\google\sheets\ENGINE_ANALYSIS.md`
- `D:\program\google\NETWORK_PROTOCOL_ANALYSIS.md`

## 9. Program Implementasi & Test Suite Terapan

Program konkret yang dibangun berdasarkan artefak analisis (`D:\program\google\tool\`):
- `gws_classifier.mjs`: Deteksi soft-404 & klasifikasi engine berdasarkan signature DOM, Canvas, dan SVG.
- `wasm_verifier.mjs`: Parser biner WASM Sheets, verifikasi SHA-256, dan decoder payload bootstrap `wb=`.
- `engine_prototypes.mjs`: Purwarupa operasional 3 engine (Kix tile virtualization, Punch pure SVG, Ritz virtual grid).
- `cli.mjs`: Antarmuka CLI (`analyze-artifacts`, `verify-wasm`, `run-prototypes`, `classify-html`).
- `test_suite.mjs`: Pengujian otomatis (27 skenario pengujian unit & integrasi terhadap artefak empiris asli, status **PASS 100%**).

## 9. Inventaris Artefak

Semua di `D:\program\google\public\`:
```
raw-cdp2/   docs.json, slides.json, sheets.json, sheets_wasm.json
            docs.{before,after}.png, slides.{before,after}.png, sheets.{before,after}.png
sheets/     calcworker_wasm_cd.wasm (3,95 MB), calcworkerhost.js (1,08 MB)
shots/      docs.png, docs_v2.png, slides.png, sheets.png
worker_wasm_static.json (hasil grep 41 chunk JS)
```

## 10. Kebersihan Sesi
- Port **9333** (scratch headless) → **DIMATIKAN & BERSIH**.
- Port **9222** (Chrome login user) → **TIDAK TERSENTUH & TETAP AKTIF** (PID 37452).