# INVENTARIS HASIL REA (REVERSE ENGINEERING ANALYSIS) GOOGLE DOCS ASLI
Sumber Observasi: Tab Aktif Port 9222 (`Resume - Google Dokumen`, target `F328C18B3E65D91EEDEE77B79CA030FF`)
Waktu Ekstraksi: 2026-10-21 | Status: Live CDP 101 WebSocket Verified (Read-Only)

---

## 1. TOOLBAR PENGEDITAN DOCS (#docs-toolbar) — 48 KONTROL LIVE

| No | ID Elemen | Label / Tooltip Asli | Shortcut | Role | Status di Replika |
|---|---|---|---|---|---|
| 0 | `undoButton` | Urungkan | Ctrl+Z | button | ✅ Ada (`tbUndo`) |
| 1 | `redoButton` | Ulangi | Ctrl+Y | button | ✅ Ada (`tbRedo`) |
| 2 | `printButton` | Cetak | Ctrl+P | button | ✅ Ada (`tbPrint`) |
| 3 | `spellGrammarCheckButton` | Pemeriksaan ejaan dan tata bahasa | Ctrl+Alt+X | button | ⚠️ Belum ada di toolbar |
| 4 | `formatPainterButton` | Terapkan format (Kuas Format) | - | button | ⚠️ Belum ada di toolbar |
| 5 | `zoomSelect` | Zoom (Fit, 50%, 75%, 100%, 125%, 150%, 200%) | - | combobox | ✅ Ada (`tbZoom`) |
| 6 | `headingStyleSelect` | Gaya (Teks normal, Judul, Heading 1-6) | - | listbox | ✅ Ada (`tbParagraphStyle`) |
| 7 | `docs-font-family` | Font (Arial, Google Sans, Roboto, dll.) | - | listbox | ✅ Ada (`tbFontFamily`) |
| 8 | `fontSizeDecrement` | Perkecil ukuran font | Ctrl+Shift+koma | button | ⚠️ Belum ada tombol (-) |
| 9 | `fontSizeSelect` | Ukuran font (angka) | - | combobox | ✅ Ada (`tbFontSize`) |
| 10 | `fontSizeIncrement` | Perbesar ukuran font | Ctrl+Shift+titik | button | ⚠️ Belum ada tombol (+) |
| 11 | `boldButton` | Tebalkan | Ctrl+B | button | ✅ Ada (`tbBold`) |
| 12 | `italicButton` | Miringkan | Ctrl+I | button | ✅ Ada (`tbItalic`) |
| 13 | `underlineButton` | Garis bawahi | Ctrl+U | button | ✅ Ada (`tbUnderline`) |
| 14 | `textColorButton` | Warna teks | - | button | ✅ Ada (`tbColor`) |
| 15 | `bgColorButton` | Warna sorotan (Highlight) | - | button | ✅ Ada (`tbBg`) |
| 16 | `insertLinkButton` | Sisipkan link | Ctrl+K | button | ⚠️ Belum ada di toolbar Docs |
| 17 | `insertCommentButton` | Tambahkan komentar | Ctrl+Alt+M | button | ✅ Ada (`tbComment`) |
| 18 | `insertImageButton` | Sisipkan gambar | - | button | ⚠️ Belum ada di toolbar Docs |
| 19 | `alignButton` | Perataan & indentasi (Kiri, Tengah, Kanan, Justify) | - | button | ✅ Ada (`tbAlign*`) |
| 20 | `lineSpacingMenuButton` | Jarak antarbaris dan antarparagraf | - | button | ✅ Ada (`tbLineSpacing`) |
| 21 | `addChecklistButton` | Checklist | Ctrl+Shift+9 | button | ✅ Ada (`tbChecklist`) |
| 23 | `addBulletButton` | Daftar berbutir | Ctrl+Shift+8 | button | ✅ Ada (`tbBulletList`) |
| 25 | `addNumberedBulletButton` | Daftar bernomor | Ctrl+Shift+7 | button | ✅ Ada (`tbNumberedList`) |
| 27 | `outdentButton` | Kurangi inden | Ctrl+[ | button | ✅ Ada (`tbIndentDec`) |
| 28 | `indentButton` | Tambahkan inden | Ctrl+] | button | ✅ Ada (`tbIndentInc`) |
| 29 | `clearFormattingButton` | Hapus format | Ctrl+\ | button | ⚠️ Engine ada, tombol toolbar belum |

---

## 2. MENU "ALAT" (TOOLS) GOOGLE DOCS ASLI (#docs-tools-menu) — 18 ITEM

| No | Label Menu Asli | Shortcut | Submenu | Deskripsi & Implementasi di Replika |
|---|---|---|---|---|
| 1 | Ejaan dan tata bahasa | Ctrl+Alt+X | Ya | Pemeriksaan ejaan aktif & kamus kata |
| 2 | Jumlah kata | Ctrl+Shift+C | Tidak | Modal jumlah kata, karakter, dan live counter |
| 3 | Tinjau pengeditan yang disarankan | Ctrl+Alt+O Ctrl+Alt+U | Tidak | Tinjau usulan perubahan dokumen |
| 4 | Bandingkan dokumen | - | Tidak | Bandingkan 2 versi dokumen |
| 5 | Kutipan | - | Tidak | Format kutipan referensi (APA, MLA, Chicago) |
| 6 | Tanda tangan elektronik | - | Tidak | Sisipkan tanda tangan digital |
| 7 | Nomor baris | - | Tidak | Toggle tampilan nomor baris di margin kiri |
| 8 | Objek tertaut | - | Tidak | Kelola diagram/tabel tertaut dari Sheets |
| 9 | Kamus | Ctrl+Shift+Y | Tidak | Cari definisi kata & sinonim |
| 10 | Terjemahkan dokumen | - | Tidak | Bikin salinan terjemahan bahasa dokumen |
| 11 | Dikte (Pengetikan Suara) | Ctrl+Shift+S | Tidak | Input suara via Web Speech API |
| 12 | Setelan notifikasi | - | Tidak | Preferensi komentar & mention email |
| 13 | Preferensi | - | Tidak | Substitusi otomatis (`(c)` → `©`, `-->` → `→`, smart quotes) |
| 14 | Aksesibilitas | - | Tidak | Setelan pembaca layar & kontras tinggi |

---

## 3. SELURUH MENUBAR GOOGLE DOCS LAINNYA

- **File**: Baru, Buka (Ctrl+O), Buat salinan, Bagikan, Email, Download (.txt, .html, .pdf, .docx, .json), Penyiapan halaman, Cetak (Ctrl+P).
- **Edit**: Urungkan (Ctrl+Z), Ulangi (Ctrl+Y), Potong (Ctrl+X), Salin (Ctrl+C), Tempel (Ctrl+V), Tempel tanpa format (Ctrl+Shift+V), Pilih semua (Ctrl+A), Cari dan ganti (Ctrl+H).
- **Tampilan**: Mode, Komentar, Tampilkan tata letak cetak, Tampilkan penggaris, Tampilkan karakter tidak dapat dicetak (Ctrl+Shift+P), Zoom, Layar penuh (F11).
- **Sisipkan**: Gambar, Tabel, Elemen penyusun, Link (Ctrl+K), Kanvas, Garis horizontal, Batas halaman (Ctrl+Enter), Nomor halaman, Header & footer, Komentar (Ctrl+Alt+M).
- **Format**: Teks (Tebal, Miring, Garis bawah, Coret, Superskrip, Subskrip, Ukuran font), Gaya paragraf, Perataan & indentasi, Jarak antarbaris, Butir & penomoran, Header & footer, Nomor halaman, Hapus format (Ctrl+\).
- **Bantuan**: Telusuri menu (Alt+/), Bantuan Dokumen, Pintasan keyboard (Ctrl+/).
