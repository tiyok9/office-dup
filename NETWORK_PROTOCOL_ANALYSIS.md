# Protokol Jaringan & Sinkronisasi Real-Time Google Workspace

Analisis Berdasarkan Bukti CDP Mentah & Ekstraksi Chunk JS
Aplikasi: Google Docs, Google Slides, Google Sheets (Public View-Only)
Tanggal Observasi: 2026-10-19

---

## 1. Status Konektivitas WebSocket

Pada sesi inspeksi CDP mentah (browser Chrome headless 155 tanpa plugin):
- **WebSockets Aktif:** **0 koneksi** (`webSockets: []`, `wsFrames: 0` pada ketiga editor).
- **Temuan:** Google Workspace tidak menggunakan WebSocket native standar untuk sinkronisasi dokumen publik/view-only.

---

## 2. Arsitektur Komunikasi: Google BrowserChannel / WebChannel

Google Workspace mengandalkan arsitektur **BrowserChannel / WebChannel over HTTP**:
- **Handshake & Capability Probe:** Endpoint `/test` digunakan untuk memverifikasi kemampuan transport jaringan klien.
- **Duplex Channel (`/bind`):** Setiap aplikasi membuka 2 koneksi HTTP POST long-polling (`/bind`) ke `docs.google.com`. Satu koneksi berfungsi sebagai *forward channel* (mengirim mutasi/heartbeat) dan satu lagi sebagai *backward channel* (menerima event stream tersinkronisasi).
- **Batching:** Permintaan data dikemas menggunakan format `batchexecute` atau multiplexed chunk array.

---

## 3. Endpoint Spesifik per Aplikasi (Observed via CDP)

1. **Google Docs:**
   - `/docos/p/sync`: Sinkronisasi metadata komentar dan mention.
   - `/font/getmetadata`: Pengambilan metrik font dan glyph layouting.
   - `/peruserchrome` & `/prefs`: Pengambilan preferensi UI editor per pengguna.
   - `/bind`: Kanal streaming BrowserChannel.

2. **Google Slides:**
   - `/slides-images-rt/...`: Real-time image asset streaming dan optimasi rendering raster thumbnail.
   - `/docos/p/sync`: Sinkronisasi komentar.
   - `/bind`: Kanal streaming BrowserChannel.

3. **Google Sheets:**
   - `/streamrows`: Endpoint streaming data baris sel saat viewport bergeser.
   - `/externaldata/fetchData`: Pengambilan sumber data eksternal/formula import.
   - `/bind`: Kanal streaming BrowserChannel.

---

## 4. Mekanisme Operational Transformation (OT)

Grep statis pada body bundle JavaScript membuktikan keberadaan mesin Operational Transformation (OT) klien:
- **Docs:** 226 kemunculan pola mutasi/revisi dokumen.
- **Slides:** 225 kemunculan pola mutasi dokumen.
- **Sheets:** **711 kemunculan** pola mutasi dokumen (OT intensif untuk sel, range, formatting, dan sheet metadata).
- **Cara Kerja:** Setiap aksi pengetikan atau pemformatan diubah menjadi operasi diferensial (retain, insert, delete) dengan nomor revisi inkremental yang dikirimkan melalui BrowserChannel.
