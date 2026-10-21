// D:\program\google\tool\static\kix_editor.js
// Kix Engine (Google Docs Multi-Canvas Tile Virtualization Editor)
// Mendukung: ketik nyata via hidden textarea, caret, word-wrap, formatting
// lengkap (bold/italic/underline/strike/warna/align/fontFamily/ukuran)
// dan paginasi dinamis (baris meluber otomatis pindah ke halaman berikutnya).

(function(window) {
  'use strict';

  const PAGE_CANVAS_WIDTH = 636;
  const PAGE_CANVAS_HEIGHT = 850;
  const MAX_TEXT_Y = 770; // batas bawah area teks sebelum halaman dianggap penuh
  const MARGIN = 30;
  // Geometri baris (canvas): satu sumber kebenaran. Dipakai oleh hit-test klik,
  // oleh penghitungan kotak centang, DAN oleh pengujian otomatis — sebelumnya
  // angka 60/24 ditulis terpisah di dua tempat sehingga mudah meleset.
  const LINE_TOP_OFFSET = 60;
  // LEGACY: tidak lagi dipakai hit-test. Geometri baris kini diturunkan dari
  // measureLine().height (lihat _lineTops). Nilai dipertahankan karena masih
  // menjadi kontrak API/konstanta yang diuji (Suite 9g-02e).
  const LINE_HEIGHT = 24;
  // Padding .kix-page di dashboard.html (padding: 72px 90px). Dipakai untuk
  // menghitung ukuran tile supaya kertas A4/Letter tidak meluber keluar kotak.
  const PAGE_PAD_X = 90;
  const PAGE_PAD_Y = 72;

  // ==== SATUAN TIPOGRAFI (paritas Google Docs) ====
  // Google Docs menampilkan ukuran font dalam POINT; engine ini menyimpan
  // PIXEL. Konversi 96dpi/72pt -> 1pt = 4/3 px.
  // Pembulatan 2 desimal BUKAN kosmetik: measureLine memakai
  // Math.round(size * 1.5), jadi nilai 12.999999 akan jatuh ke 19 (bukan 20)
  // dan tinggi baris menyusut 1px per baris tanpa terlihat di layar.
  const PT_TO_PX = 4 / 3;
  const PX_TO_PT = 3 / 4;
  const pxToPt = (px) => Math.round(px * PX_TO_PT * 100) / 100;
  const ptToPx = (pt) => Math.round(pt * PT_TO_PX * 100) / 100;
  // Label tampilan memakai koma (lokal Indonesia): 13px -> "9,75".
  const ptLabel = (px) => String(pxToPt(px)).replace('.', ',');

  // Properti gaya yang diwariskan ke baris baru saat user menekan Enter.
  // Tanpa daftar ini, underline/strike/list hilang begitu user menekan Enter.
  const LINE_STYLE_KEYS = [
    'bold', 'italic', 'underline', 'strike', 'size', 'color', 'align',
    'fontFamily', 'heading', 'listType', 'indent', 'spacing', 'checked'
  ];

  // Gaya paragraf ala Google Docs (dropdown "Normal text / Title / Heading n").
  const PARAGRAPH_PRESETS = {
    normal:   { size: 13, bold: false },
    title:    { size: 26, bold: true },
    heading1: { size: 20, bold: true },
    heading2: { size: 16, bold: true },
    heading3: { size: 14, bold: true }
  };

  // ==== PRESET UKURAN KERTAS (paritas Google Docs: File > Penyiapan Halaman) ====
  // 'kix' = ukuran asli engine (636x850) dan DIPAKAI SEBAGAI DEFAULT supaya
  // dokumen seed yang sudah ada tetap tampil identik byte-per-byte.
  const PAPER_PRESETS = {
    kix:    { width: PAGE_CANVAS_WIDTH, height: PAGE_CANVAS_HEIGHT, label: 'Kix (default)' },
    a4:     { width: 794,  height: 1123, label: 'A4' },
    letter: { width: 816,  height: 1056, label: 'Letter' },
    legal:  { width: 816,  height: 1344, label: 'Legal' }
  };

  class KixDocsEditor {
    constructor(scrollContainerId, hiddenInputId, onPageChange) {
      this.scrollBox = document.getElementById(scrollContainerId);
      this.hiddenInput = document.getElementById(hiddenInputId);
      this.onPageChange = onPageChange;

      // ==== VIRTUALISASI TILE (paritas .kix-rotatingtilemanager) ====
      // Ambang sengaja LEBIH TINGGI dari jumlah halaman dokumen seed (2),
      // supaya dokumen pendek berperilaku 100% identik dengan sebelumnya.
      // Yang dihemat hanya PAINT kanvas; tile tetap dibuat di DOM agar
      // indeks halaman, hit-test, dan scrollIntoView tidak berubah.
      this.tileVirtualizeMin = 3;   // aktif bila total halaman > 3
      this.tileWindowSpan = 1;      // halaman di kiri/kanan yang ikut dicat
      this._dirtyPages = new Set(); // halaman yang kanvasnya sudah terisi
      this._forceAll = false;       // paksa cat semua (dipakai renderAllForce)

      this.pages = [
        {
          pageNumber: 1,
          lines: [
            { text: '2002 ACADEMY AWARDS NOMINEE LIST', bold: true, size: 20, color: '#1a73e8' },
            { text: 'Kategori: Best Picture (Film Terbaik)', bold: true, size: 14, color: '#202124' },
            { text: '1. A Beautiful Mind — Brian Grazer & Ron Howard (PEMENANG)', bold: true, size: 13, color: '#0f9d58' },
            { text: '2. Gosford Park — Robert Altman, Bob Balaban', bold: false, size: 13, color: '#3c4043' },
            { text: '3. In the Bedroom — Graham Leader, Ross Katz', bold: false, size: 13, color: '#3c4043' },
            { text: '4. The Lord of the Rings: The Fellowship of the Ring', bold: false, size: 13, color: '#3c4043' },
            { text: '5. Moulin Rouge! — Martin Brown, Baz Luhrmann', bold: false, size: 13, color: '#3c4043' },
            { text: '', bold: false, size: 13, color: '#3c4043' },
            { text: 'Kategori: Best Actor in a Leading Role', bold: true, size: 14, color: '#202124' },
            { text: '• Denzel Washington — Training Day (PEMENANG)', bold: true, size: 13, color: '#0f9d58' },
            { text: '• Russell Crowe — A Beautiful Mind', bold: false, size: 13, color: '#3c4043' },
            { text: '• Sean Penn — I Am Sam', bold: false, size: 13, color: '#3c4043' },
            { text: '• Will Smith — Ali', bold: false, size: 13, color: '#3c4043' },
            { text: '• Tom Wilkinson — In the Bedroom', bold: false, size: 13, color: '#3c4043' }
          ]
        },
        {
          pageNumber: 2,
          lines: [
            { text: '2002 NOMINEES — BAGIAN 2 (TEKNIS)', bold: true, size: 18, color: '#1a73e8' },
            { text: '• Cinematography: The Lord of the Rings — Andrew Lesnie', bold: true, size: 13, color: '#0f9d58' },
            { text: '• Costume Design: Moulin Rouge! — Catherine Martin', bold: false, size: 13, color: '#3c4043' },
            { text: '• Film Editing: Black Hawk Down — Pietro Scalia', bold: false, size: 13, color: '#3c4043' },
            { text: '• Original Score: The Lord of the Rings — Howard Shore', bold: false, size: 13, color: '#3c4043' }
          ]
        }
      ];

      this.activePageIdx = 0;
      this.activeLineIdx = 0;
      this.cursorCharIdx = 0;
      this.isCaretVisible = true;
      this.caretTimer = null;

      this.currentStyle = {
        bold: false,
        italic: false,
        underline: false,
        strike: false,
        size: 13,
        color: '#202124',
        align: 'left',
        fontFamily: 'Arial'
      };

      this.onChange = null;
      // ==== STATE HYPERLINK (Docs) ====
      // Tautan disimpan sebagai RENTANG pada line.text: line.links = [{start,end,url}].
      // Offset memakai basis yang SAMA dengan cursorCharIdx dan findMatches (tanpa
      // penanda butir), jadi render, hit-test, dan caret tidak pernah meleset.
      // TIDAK ada struktur segmen baru: reflowPages()/paginasi tidak tersentuh,
      // dan karena getDocumentData() mengembalikan pages, tautan otomatis ikut
      // autosave + snapshot undo tanpa saluran persistensi tambahan.
      this._linkBoxes = [];       // kotak hit-test per halaman (diisi renderPage)
      this._commentBoxes = [];    // kotak hit-test highlight komentar (diisi renderPage)
      this.onLinkClick = null;    // callback buka tautan (dipaksa harness untuk uji)
      this.onCommentClick = null; // callback buka popover komentar (dipaksa harness)
      this.linkColor = '#1a73e8'; // warna tautan Docs
      // ==== STATE FIND & REPLACE ====
      // Pencarian bekerja pada MODEL TEKS (this.pages[].lines[].text), bukan DOM,
      // karena seluruh dokumen digambar ke kanvas. Offset match memakai indeks
      // karakter pada line.text TANPA penanda butir daftar, sama seperti
      // cursorCharIdx — sehingga highlight dan caret memakai basis yang sama.
      this.findMatches = [];
      this.findActiveIdx = -1;
      // Callback saat baris aktif / posisi kursor berubah — dipakai shell untuk
      // menyinkronkan status tombol toolbar (B/I/U/S/align) dengan baris di kursor.
      this.onActiveLineChange = null;
      // Penomoran halaman footer (paritas Google Docs: Sisipkan > Nomor Halaman).
      // Default MATI agar dokumen lama tampil identik seperti sebelumnya; user
      // menyalakannya lewat toolbarAction('pageNumbers') / setPageNumbers(true).
      this.showPageNumbers = false;
      // Teks header/footer (paritas Docs: Sisipkan > Header & footer).
      // Default kosong -> dokumen lama dan seed tampil IDENTIK seperti
      // sebelumnya, dan getDocumentData() tidak menambah kunci apa pun.
      this.headerText = '';
      this.footerText = '';
      // ==== STATE SELEKSI RENTANG (paritas Google Docs) ====
      // Seleksi disimpan sebagai pasangan TITIK DOKUMEN {pageIdx, lineIdx, charIdx},
      // bukan sekadar indeks baris aktif, supaya rentang bisa melintasi baris DAN
      // halaman. `anchor` = tempat drag dimulai (tetap), `focus` = ujung yang
      // bergerak. Urutan normal (start <= end) dihitung saat dibutuhkan oleh
      // getSelectionRange(), sehingga arah seleksi (maju/mundur) tidak pernah
      // membuat render atau pemotongan teks salah sisi.
      this.selection = null;
      this._dragging = false;
      this.selectionColor = 'rgba(66,133,244,0.28)'; // biru seleksi Docs
      this._clipboard = '';                            // fallback clipboard internal
      // ==== STATE TABEL KANVAS ====
      // Tabel disimpan sebagai BARIS KHUSUS (line.type === 'table') agar ikut
      // alur paginasi, snapshot undo, dan autosave yang sudah ada — tanpa
      // saluran persistensi baru. Bentuk: line.table = { rows: [[cell,...]], colWidths, rowHeight }
      // dengan cell = { text, bold?, italic?, ... }.
      this.activeCell = null;      // { r, c } sel yang sedang disunting
      this.cellCaret = 0;          // offset kursor DI DALAM teks sel aktif
      this._tableBoxes = [];       // kotak hit-test sel (diisi renderPage)
      // ==== STATE GAMBAR INLINE ====
      this._imageCache = new Map(); // src -> HTMLImageElement (atau null bila gagal)
      this._imageBoxes = [];        // kotak hit-test gambar (diisi renderPage)
      // ==== PENYIAPAN HALAMAN ====
      // Default: ukuran asli engine + margin 30px di semua sisi. Nilai ini
      // SENGAJA sama dengan konstanta lama sehingga dokumen lama tidak berubah.
      this.pageSetup = {
        paperSize: 'kix',
        orientation: 'portrait',
        marginTop: MARGIN,
        marginBottom: MARGIN,
        marginLeft: MARGIN,
        marginRight: MARGIN
      };
      this.initEvents();
      this.startCaretBlink();
      this.renderAllPages();
      if (typeof window !== 'undefined') {
        window.__kixEditor = this;
      }
    }

    setDocumentData(data) {
      if (data && Array.isArray(data.pages) && data.pages.length > 0) {
        this.pages = JSON.parse(JSON.stringify(data.pages));
        // Normalisasi nomor halaman: berkas lama tidak menyimpan pageNumber,
        // dan tanpa normalisasi di sini nomor halaman footer bisa kosong.
        this.pages.forEach((p, i) => { if (!p.pageNumber) p.pageNumber = i + 1; });
      }
      // Header/footer opsional. Berkas lama tanpa kunci ini dimuat sebagai
      // string kosong (bukan undefined) agar render tidak mencetak 'undefined'.
      const hf = (data && data.headerFooter) || {};
      this.headerText = typeof hf.header === 'string' ? hf.header : '';
      this.footerText = typeof hf.footer === 'string' ? hf.footer : '';
      this.activePageIdx = 0;
      this.activeLineIdx = 0;
      this.cursorCharIdx = 0;
      this.renderAllPages();
    }

    getDocumentData() {
      const out = { pages: this.pages };
      // Kunci headerFooter HANYA ditambahkan bila terisi, supaya dokumen lama
      // dan seed tetap identik (API vs disk EXACT MATCH tidak berubah).
      if (this.headerText || this.footerText) {
        out.headerFooter = { header: this.headerText || '', footer: this.footerText || '' };
      }
      return out;
    }

    startCaretBlink() {
      if (this.caretTimer) clearInterval(this.caretTimer);
      this.caretTimer = setInterval(() => {
        this.isCaretVisible = !this.isCaretVisible;
        this.renderPage(this.activePageIdx);
      }, 530); // Laju kedipan standar Google Docs (~530ms)
    }

    initEvents() {
      // ==== MOUSE: KLIK, DRAG-SELEKSI, DOUBLE-CLICK ====
      // `click` diganti `mousedown` karena seleksi butuh titik AWAL (anchor)
      // sebelum pointer bergerak. Seluruh perilaku klik lama (komentar, tautan,
      // kotak centang, fokus input) dipertahankan apa adanya.
      this.scrollBox.addEventListener('mousedown', (e) => {
        const canvas = e.target.closest('.kix-page')?.querySelector('canvas');
        if (canvas) {
          // Cegah DEFAULT ACTION mousedown memindahkan fokus ke #docsScrollBox
          // (div itu punya tabindex="0"). Tanpa ini, focus() kita ditimpa
          // browser SETELAH handler selesai -> activeElement jadi div, dan
          // SELURUH ketikan/Enter/Backspace tidak pernah sampai ke engine.
          // Ditempatkan DI DALAM cabang canvas: mousedown pada scrollbar
          // (target = div itu sendiri) tidak boleh ikut dibatalkan, kalau
          // tidak drag scrollbar mati.
          e.preventDefault();
          // Fokus dipasang di sini juga (bukan hanya di akhir handler) supaya
          // cabang yang return lebih awal — komentar, tautan, ceklis, sel
          // tabel — tetap meninggalkan kursor input di interceptor.
          if (this.hiddenInput) this.hiddenInput.focus();
          const pIdxRaw = parseInt(canvas.getAttribute('data-page') || '0', 10);
          // Halaman di luar jendela virtualisasi belum dicat, sehingga kotak
          // hit-test-nya belum ada. Cat dulu, kalau tidak klik mendarat di
          // baris yang salah (regresi senyap yang sulit dilacak).
          if (this._dirtyPages && !this._dirtyPages.has(pIdxRaw)) {
            this.renderPage(pIdxRaw);
            this._dirtyPages.add(pIdxRaw);
          }
          const rect = canvas.getBoundingClientRect();
          // Kompensasi zoom: rect mengembalikan ukuran SETELAH transform,
          // sedangkan koordinat gambar kanvas tetap 1:1 (PAGE_CANVAS_WIDTH).
          // Tanpa rasio ini, klik saat ter-zoom memilih baris yang salah.
          const zx = rect.width ? this.viewW() / rect.width : 1;
          const zy = rect.height ? this.viewH() / rect.height : 1;
          const clickXl = (e.clientX - rect.left) * zx;
          const clickYl = (e.clientY - rect.top) * zy;

          // Baris ditentukan dari geometri GAMBAR (measureLine), bukan dari
          // konstanta 24 — lihat catatan _lineTops().
          const lIdxRaw = this.lineIndexAtY(pIdxRaw, clickYl);
          const clamped = this.clampPoint(pIdxRaw, lIdxRaw, clickXl);
          this.activePageIdx = clamped.pIdx;
          this.activeLineIdx = clamped.lIdx;
          const pIdx = this.activePageIdx;

          const line = this.pages[pIdx]?.lines[this.activeLineIdx];

          // ==== KLIK GAMBAR ====
          // Baris gambar tidak punya line.text, jadi pemetaan karakter di
          // bawah menaruh kursor di offset 0 dan gambar TIDAK PERNAH bisa
          // dipilih. Tanpa cabang ini resizeActiveImage() dan
          // setActiveImageAlign() mustahil dipakai user.
          const imgHit = this.imageAt(pIdx, clickXl, clickYl);
          this._lastHitImage = imgHit || null;
          if (imgHit) {
            this.activePageIdx = pIdx;
            this.activeLineIdx = imgHit.lIdx;
            this.activeCell = null;
            this.selection = null;
            this._dragging = false;
            this.cursorCharIdx = 0;
            if (this.hiddenInput) this.hiddenInput.focus();
            this.isCaretVisible = true;
            this.emitActiveLine();
            this.renderAllPages();
            return;
          }

          // ==== KLIK HIGHLIGHT KOMENTAR ====
          // WAJIB diperiksa SEBELUM pemetaan karakter. Kalau tidak, klik pada
          // highlight kuning hanya memindahkan kursor dan popover komentar tak
          // pernah bisa dibuka dari kanvas.
          // Ctrl/Cmd+Klik SELALU milik tautan, bukan komentar. Tanpa pengecualian
          // ini, komentar yang menumpuk di atas tautan akan menelan Ctrl+Click
          // dan tautan jadi mustahil dibuka dari kanvas (regresi senyap: tes
          // tautan lama tetap hijau karena memanggil API, bukan klik nyata).
          const ctrlIntent = e.ctrlKey || e.metaKey;
          const cHit = ctrlIntent ? null : this.commentBoxAt(pIdx, clickXl, clickYl);
          this._lastHitComment = cHit || null;
          if (cHit) {
            this.activeLineIdx = cHit.lIdx;
            this.cursorCharIdx = cHit.comment.start;
            if (typeof this.onCommentClick === 'function') this.onCommentClick(cHit.comment, cHit);
            this.emitActiveLine();
            return;
          }

          // Kursor mendarat pada karakter yang DIKLIK, bukan selalu di akhir baris.
          // Sebelumnya `line.text.length` membuat Ctrl+K hanya mampu menggenggam
          // kata terakhir, sehingga tautan di tengah baris mustahil disunting.
          this.cursorCharIdx = line ? this.charIndexAtPoint(pIdx, this.activeLineIdx, clickXl) : 0;

          // ==== KLIK TAUTAN ====
          // Paritas Google Docs MODE EDIT: klik biasa = taruh kursor, hanya
          // Ctrl+Klik (Cmd+Klik di Mac) yang membuka tautan. Kalau klik biasa
          // langsung membuka, user tidak bisa menyunting teks di dalam tautan.
          const hit = this.linkBoxAt(pIdx, clickXl, clickYl);
          this._lastHitLink = hit || null;
          if (hit && (e.ctrlKey || e.metaKey)) {
            if (typeof this.onLinkClick === 'function') this.onLinkClick(hit.url, hit);
            else if (typeof window !== 'undefined' && typeof window.open === 'function') {
              window.open(hit.url, '_blank', 'noopener,noreferrer');
            }
            this.emitActiveLine();
            return;
          }

          // Klik pada KOTAK CENTANG = membalik status ceklis (ala Google Docs).
          // Kotak digambar sebagai penanda "☐ " di awal teks, jadi klik yang
          // mendarat tepat di area penanda itu diperlakukan sebagai klik ceklis
          // dan TIDAK memindahkan kursor.
          if (line && line.listType === 'checklist') {
            const clickX = (e.clientX - rect.left) * zx;
            const box = this.checklistBoxRect(pIdx, this.activeLineIdx);
            if (box && clickX >= box.left && clickX <= box.left + box.width) {
              this.toggleChecklistAt(pIdx, this.activeLineIdx);
              this.emitActiveLine();
              this.renderAllPages();
              return;
            }
          }

          // ==== KLIK SEL TABEL ====
          // WAJIB diperiksa sebelum pemetaan karakter baris: baris tabel tidak
          // punya line.text yang bisa dipetakan, jadi tanpa cabang ini klik
          // pada sel hanya akan menaruh kursor di baris tabel tanpa efek.
          const cellHit = this.tableCellAt(pIdx, clickXl, clickYl);
          if (cellHit) {
            this.activePageIdx = pIdx;
            this.activeLineIdx = cellHit.lIdx;
            this.activeCell = { r: cellHit.r, c: cellHit.c };
            const cl = this.pages[pIdx].lines[cellHit.lIdx];
            const cell = cl.table.rows[cellHit.r][cellHit.c] || { text: '' };
            // Kursor sel diletakkan di ujung teks sel (perilaku Docs saat klik sel).
            this.cellCaret = (cell.text || '').length;
            this.selection = null;
            this._dragging = false;
            if (this.hiddenInput) this.hiddenInput.focus();
            this.isCaretVisible = true;
            this.emitActiveLine();
            this.renderAllPages();
            return;
          }
          // Klik di luar tabel = keluar dari mode sunting sel.
          this.activeCell = null;

          // ==== PEMBENTUKAN SELEKSI ====
          const here = {
            pageIdx: this.activePageIdx,
            lineIdx: this.activeLineIdx,
            charIdx: this.cursorCharIdx
          };
          if (e.detail >= 3) {
            // Triple-click: seluruh baris.
            this.selection = {
              anchor: { pageIdx: here.pageIdx, lineIdx: here.lineIdx, charIdx: 0 },
              focus: { pageIdx: here.pageIdx, lineIdx: here.lineIdx, charIdx: (line ? (line.text || '').length : 0) }
            };
            this._dragging = false;
          } else if (e.detail === 2) {
            // Double-click: satu kata (paritas Docs).
            const w = this._wordRangeAt(pIdx, this.activeLineIdx, this.cursorCharIdx);
            this.selection = {
              anchor: { pageIdx: here.pageIdx, lineIdx: here.lineIdx, charIdx: w.start },
              focus: { pageIdx: here.pageIdx, lineIdx: here.lineIdx, charIdx: w.end }
            };
            this._dragging = false;
          } else if (e.shiftKey) {
            // Shift+klik: perpanjang seleksi dari anchor lama.
            const base = (this.selection && this.selection.anchor) ? this.selection.anchor : here;
            this.selection = { anchor: base, focus: here };
            this._dragging = false;
          } else {
            this.selection = { anchor: here, focus: here };
            this._dragging = true;   // mulai drag; focus mengikuti mousemove
          }
        }
        if (this.hiddenInput) this.hiddenInput.focus();
        this.isCaretVisible = true;
        this.emitActiveLine();   // toolbar harus memantulkan format baris yang diklik
        this.renderAllPages();
      });

      // Tangkap input keyboard via hidden textarea (arsitektur docs-texteventtarget-iframe)
      if (this.hiddenInput) {
        this.hiddenInput.addEventListener('keydown', (e) => {
          if (window.currentApp !== 'docs') return;
          this.handleKey(e);
        });
      }

      // ==== DRAG GLOBAL ====
      // Dipasang di window (bukan kanvas) supaya drag yang keluar dari tepi
      // halaman — termasuk melintasi halaman lain — tetap terlacak.
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('mousemove', (e) => {
          if (!this._dragging || !this.selection) return;
          const pt = this._pointFromClient(e.clientX, e.clientY);
          if (!pt) return;
          this.selection.focus = pt;
          this.activePageIdx = pt.pageIdx;
          this.activeLineIdx = pt.lineIdx;
          this.cursorCharIdx = pt.charIdx;
          this.isCaretVisible = true;
          this.renderAllPages();
        });
        window.addEventListener('mouseup', () => {
          if (!this._dragging) return;
          this._dragging = false;
          // Seleksi kosong (klik tanpa geser) = bukan seleksi.
          if (!this.hasSelection()) this.selection = null;
          this.emitActiveLine();
          this.renderAllPages();
        });
      }

      // ==== PASTE ====
      // Ctrl+V sengaja TIDAK di-preventDefault di handleKey supaya browser
      // memicu event `paste` pada textarea tersembunyi; di sinilah isi
      // clipboard asli dibaca lalu disisipkan ke model teks kanvas.
      if (this.hiddenInput) {
        this.hiddenInput.addEventListener('paste', (e) => {
          if (window.currentApp !== 'docs') return;
          const t = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
          e.preventDefault();
          if (t) this.insertText(t);
        });
      }

      // Deteksi scroll untuk update status bar. Indikator mengikuti halaman
      // yang BENAR-BENAR mengisi viewport (lihat pageIndexAtViewportTop).
      this.scrollBox.addEventListener('scroll', () => {
        const curPage = this.pageIndexAtViewportTop() + 1;
        // Geser jendela render mengikuti halaman yang mengisi viewport.
        this.updateRenderWindow(false, curPage - 1);
        if (typeof this.onPageChange === 'function') {
          this.onPageChange(curPage, this.pages.length, this.calculateWordCount());
        }
      });
    }

    // Indeks halaman (0-based) yang mengisi tepi atas viewport.
    //
    // Sumber kebenaran = GEOMETRI TILE NYATA, bukan PAGE_CANVAS_HEIGHT.
    // `PAGE_CANVAS_HEIGHT` (850) adalah tinggi koordinat INTERNAL kanvas,
    // sedangkan tinggi tile di DOM = min-height 1056px + margin-bottom 24px
    // (lihat .kix-page di dashboard.html). Dulu indikator memakai
    // Math.floor(scrollTop / 850) + 1, sehingga halaman ke-2 baru dianggap
    // aktif setelah scrollTop 850 — padahal puncaknya sudah lewat jauh
    // sebelumnya. Akibatnya status bar tertinggal satu halaman.
    pageIndexAtViewportTop() {
      const total = this.pages.length;
      if (total <= 1) return 0;
      const box = this.scrollBox;
      if (!box || typeof box.getBoundingClientRect !== 'function') {
        return Math.max(0, Math.min(total - 1, this.activePageIdx));
      }
      const boxRect = box.getBoundingClientRect();
      // Titik uji sedikit di bawah tepi atas viewport: cukup dalam agar tile
      // halaman berikutnya yang baru menyembul belum dianggap halaman aktif.
      const probeY = boxRect.top + Math.min(120, Math.max(1, boxRect.height / 2));
      for (let i = 0; i < total; i++) {
        const el = document.getElementById(`kixPage${i + 1}`);
        if (!el || typeof el.getBoundingClientRect !== 'function') continue;
        const r = el.getBoundingClientRect();
        if (r.top <= probeY && r.bottom > probeY) return i;
      }
      // Tak ada tile yang memuat titik uji (mis. tepat di celah antar-halaman):
      // pakai halaman kursor supaya indikator tidak melompat liar.
      return Math.max(0, Math.min(total - 1, this.activePageIdx));
    }

    // Bawa halaman tertentu ke tepi atas viewport. Dipakai setelah kursor
    // DIPINDAHKAN ke halaman lain (pemisah halaman / halaman baru): tanpa ini
    // model dan kursor sudah pindah tetapi layar tetap menampilkan halaman
    // lama, sehingga status bar tampak berbohong.
    scrollPageIntoView(pIdx) {
      const el = document.getElementById(`kixPage${pIdx + 1}`);
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'start' });
      }
      // Sinkronkan indikator tanpa menunggu event scroll — sebagian browser
      // tidak memicu scroll bila posisi viewport sudah tepat.
      if (typeof this.onPageChange === 'function') {
        this.onPageChange(pIdx + 1, this.pages.length, this.calculateWordCount());
      }
    }

    handleKey(e) {
      const page = this.pages[this.activePageIdx];
      if (!page) return;
      let line = page.lines[this.activeLineIdx];
      if (!line) {
        line = {
          text: '',
          bold: this.currentStyle.bold,
          italic: this.currentStyle.italic,
          size: this.currentStyle.size,
          color: this.currentStyle.color
        };
        page.lines[this.activeLineIdx] = line;
      }

      let modified = false;
      const mod = e.ctrlKey || e.metaKey;

      // ==== JALUR SUNTING SEL TABEL ====
      // Ditaruh paling awal: seluruh tombol bermakna berbeda saat fokus berada
      // di dalam sel (Tab pindah sel, Enter pindah baris, dsb). Tanpa cabang
      // ini, Tab akan memindahkan fokus DOM dan isi sel tak pernah bisa diisi.
      if (line && line.type === 'table' && this.activeCell) {
        if (this._handleTableKey(e, line)) return;
      }

      // ==== PINTASAN SELEKSI & CLIPBOARD ====
      // Ctrl+A / Ctrl+C / Ctrl+X ditangani di sini; Ctrl+V TIDAK (dibiarkan
      // lolos ke event `paste` textarea supaya clipboard asli terbaca).
      if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        this.selectAll();
        return;
      }
      if (mod && (e.key === 'c' || e.key === 'C')) {
        if (this.hasSelection()) {
          e.preventDefault();
          this.copySelection();
          return;
        }
      }
      if (mod && (e.key === 'x' || e.key === 'X')) {
        if (this.hasSelection()) {
          e.preventDefault();
          this.cutSelection();
          return;
        }
      }

      if (e.key === 'Backspace') {
        e.preventDefault();
        // Seleksi aktif: Backspace menghapus SELURUH rentang, bukan 1 karakter.
        if (this.hasSelection()) { this.deleteSelection(); return; }
        if (this.cursorCharIdx > 0) {
          line.text = line.text.slice(0, this.cursorCharIdx - 1) + line.text.slice(this.cursorCharIdx);
          this._editRuns(line, this.cursorCharIdx - 1, 1, '');
          this._shiftLinks(line, this.cursorCharIdx - 1, -1);
          // Komentar WAJIB ikut bergeser di sini. Delete sudah memanggil
          // _shiftComments, tetapi Backspace di tengah baris adalah jalur
          // BERBEDA; tanpa baris ini offset komentar melenceng satu karakter
          // setiap kali user menghapus ke belakang (cacat senyap: highlight
          // bergeser pelan-pelan dan tes offset lain tetap hijau).
          this._shiftComments(line, this.cursorCharIdx - 1, -1);
          this.cursorCharIdx--;
          modified = true;
        } else if (this.cursorCharIdx === 0 && ((line.indent || 0) > 0 || line.listType || (line.heading && line.heading !== 'normal'))) {
          // ==== PARITAS GOOGLE DOCS: BACKSPACE PADA COL 0 ====
          // 1. Baris list ber-indentasi: outdent (indent--)
          // 2. Baris list di margin (indent 0): lepas dari format list
          // 3. Baris heading: reset ke normal text
          // Teks baris TETAP dipertahankan (bukan dihapus/digabung).
          if ((line.indent || 0) > 0) {
            line.indent = Math.max(0, line.indent - 1);
          } else if (line.listType) {
            delete line.listType;
            delete line.indent;
            delete line.checked;
          } else if (line.heading && line.heading !== 'normal') {
            line.heading = 'normal';
            line.size = 13;
            line.bold = false;
          }
          modified = true;
        } else if (this.activeLineIdx > 0) {
          const prevLine = page.lines[this.activeLineIdx - 1];
          // Tautan baris yang digabung ikut pindah, digeser sepanjang teks baris
          // sebelumnya. Tanpa ini tautan menempel ke karakter yang salah.
          if (Array.isArray(line.links) && line.links.length) {
            const joinAt = prevLine.text.length;
            const moved = line.links.map(L => ({ start: L.start + joinAt, end: L.end + joinAt, url: L.url }));
            prevLine.links = (Array.isArray(prevLine.links) ? prevLine.links : [])
              .concat(moved).sort((a, b) => a.start - b.start);
            delete line.links;
          }
          // Komentar baris yang digabung ikut pindah, digeser sepanjang teks
          // baris sebelumnya. Objek di-spread agar id/author/text/replies utuh.
          if (Array.isArray(line.comments) && line.comments.length) {
            const joinAt = prevLine.text.length;
            const movedC = line.comments.map(C => ({ ...C, start: C.start + joinAt, end: C.end + joinAt }));
            prevLine.comments = (Array.isArray(prevLine.comments) ? prevLine.comments : []).concat(movedC);
            delete line.comments;
          }
          this.cursorCharIdx = prevLine.text.length;
          prevLine.text += line.text;
          page.lines.splice(this.activeLineIdx, 1);
          this.activeLineIdx--;
          modified = true;
        }
      } else if (e.key === 'Delete') {
        e.preventDefault();
        if (this.hasSelection()) { this.deleteSelection(); return; }
        if (this.cursorCharIdx < line.text.length) {
          line.text = line.text.slice(0, this.cursorCharIdx) + line.text.slice(this.cursorCharIdx + 1);
          this._editRuns(line, this.cursorCharIdx, 1, '');
          this._shiftLinks(line, this.cursorCharIdx, -1);
          this._shiftComments(line, this.cursorCharIdx, -1);
          modified = true;
        }
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        // Pemisah halaman manual (paritas Google Docs: Ctrl+Enter).
        // WAJIB dicek SEBELUM cabang Enter biasa di bawah — kalau tidak,
        // baris terpecah dua kali (sekali jadi baris baru, sekali jadi halaman).
        e.preventDefault();
        this.insertPageBreak();
        return;   // insertPageBreak() sudah melakukan reflow+render+emit+onChange
      } else if (e.key === 'Enter') {
        e.preventDefault();
        // ==== PARITAS GOOGLE DOCS: ENTER PADA BUTIR DAFTAR KOSONG ====
        // Tekan Enter pada baris list kosong (teks kosong atau hanya whitespace):
        // - Bila ber-indentasi (indent > 0): kurangi indent (outdent)
        // - Bila tanpa indentasi (indent === 0): keluar dari format list (listType = null)
        // Keduanya TIDAK membuat baris baru dan mempertahankan kursor di baris ini.
        if (line.listType && (!line.text || line.text.trim() === '')) {
          if ((line.indent || 0) > 0) {
            line.indent = Math.max(0, line.indent - 1);
          } else {
            delete line.listType;
            delete line.indent;
            delete line.checked;
          }
          this.cursorCharIdx = 0;
          this.reflowPages();
          this.renderAllPages();
          this.emitActiveLine();
          this.notifyChange();
          return;
        }
        const textAfter = line.text.slice(this.cursorCharIdx);
        line.text = line.text.slice(0, this.cursorCharIdx);
        // ==== TAUTAN SAAT PECAH BARIS ====
        // Tautan yang seluruhnya berada SESUDAH kursor pindah ke baris baru
        // (offset digeser sepanjang potongan atas). Tautan yang MELINTASI titik
        // pecah dibelah dua: bagian kiri tetap di baris ini, bagian kanan ikut
        // ke baris baru. Kalau hanya bagian kiri yang dipertahankan, sisa teks
        // yang pindah baris kehilangan tautannya (dan offset-nya jadi stale).
        let movedLinks = null;
        if (Array.isArray(line.links) && line.links.length) {
          const cut = this.cursorCharIdx;
          const keep = [], move = [];
          for (const L of line.links) {
            if (L.start >= cut) move.push({ start: L.start - cut, end: L.end - cut, url: L.url });
            else if (L.end > cut) {
              keep.push({ start: L.start, end: cut, url: L.url });      // bagian kiri
              move.push({ start: 0, end: L.end - cut, url: L.url });    // bagian kanan
            } else keep.push(L);
          }
          if (keep.length) line.links = keep; else delete line.links;
          if (move.length) movedLinks = move;
        }
        // ==== KOMENTAR SAAT PECAH BARIS (Opsi A) ====
        // Thread TIDAK dibelah: komentar yang melintasi titik potong tetap di
        // baris kiri dengan rentang dipangkas (end = cut). Percakapan yang
        // terbelah dua membingungkan pembaca, dan id yang sama di dua baris
        // akan membuat removeComment() menghapus dua tempat sekaligus.
        let movedComments = null;
        {
          const split = this._splitCommentsAt(line, this.cursorCharIdx);
          if (split) {
            if (split.keep.length) line.comments = split.keep; else delete line.comments;
            if (split.move.length) movedComments = split.move;
          }
        }
        // Warisi SELURUH properti gaya (termasuk underline/strike/heading/list),
        // bukan hanya bold/italic — kalau tidak, format user hilang tiap Enter.
        const newLine = { text: textAfter };
        if (movedLinks) newLine.links = movedLinks;
        if (movedComments) newLine.comments = movedComments;
        for (const k of LINE_STYLE_KEYS) {
          if (line[k] !== undefined) newLine[k] = line[k];
          else if (this.currentStyle[k] !== undefined) newLine[k] = this.currentStyle[k];
        }
        // Enter pada butir daftar kosong = keluar dari daftar.
        if (line.listType && !line.text) {
          delete newLine.listType;
          delete newLine.checked;
        } else if (newLine.listType === 'checklist') {
          // Butir ceklis baru selalu mulai TANPA centang (ala Google Docs).
          newLine.checked = false;
        }
        page.lines.splice(this.activeLineIdx + 1, 0, newLine);
        this.activeLineIdx++;
        this.cursorCharIdx = 0;
        modified = true;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
                 e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        // Tanpa Shift + ada seleksi = RUNTUHKAN ke sisi sesuai arah panah
        // (paritas Docs: panah tidak melompat satu karakter, hanya menutup seleksi).
        if (!e.shiftKey && this.hasSelection()) {
          const r = this.getSelectionRange();
          const to = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? r.start : r.end;
          this.selection = null;
          this.activePageIdx = to.pageIdx;
          this.activeLineIdx = to.lineIdx;
          this.cursorCharIdx = to.charIdx;
          this.renderAllPages();
          this.emitActiveLine();
          return;
        }
        // Titik jangkar: bila sudah ada seleksi, anchor lama DIPERTAHANKAN
        // sehingga Shift+panah berikutnya memperluas/mempersempit rentang.
        const anchorPt = (e.shiftKey && this.selection && this.selection.anchor)
          ? this.selection.anchor
          : this._pointOf(this.activePageIdx, this.activeLineIdx, this.cursorCharIdx);

        const curPage = this.pages[this.activePageIdx];
        const curLine = curPage && curPage.lines[this.activeLineIdx];
        const curLen = curLine ? (curLine.text || '').length : 0;
        if (e.key === 'ArrowLeft') {
          if (this.cursorCharIdx > 0) this.cursorCharIdx--;
          else if (this.activeLineIdx > 0) {
            this.activeLineIdx--;
            this.cursorCharIdx = (curPage.lines[this.activeLineIdx].text || '').length;
          } else if (this.activePageIdx > 0) {
            // Mundur ke halaman sebelumnya: baris terakhir halaman itu.
            this.activePageIdx--;
            const prevPage = this.pages[this.activePageIdx];
            this.activeLineIdx = Math.max(0, prevPage.lines.length - 1);
            const pl = prevPage.lines[this.activeLineIdx];
            this.cursorCharIdx = pl ? (pl.text || '').length : 0;
          }
        } else if (e.key === 'ArrowRight') {
          if (this.cursorCharIdx < curLen) this.cursorCharIdx++;
          else if (this.activeLineIdx < curPage.lines.length - 1) {
            this.activeLineIdx++;
            this.cursorCharIdx = 0;
          } else if (this.activePageIdx < this.pages.length - 1) {
            // Maju ke halaman berikutnya: baris pertama halaman itu.
            this.activePageIdx++;
            this.activeLineIdx = 0;
            this.cursorCharIdx = 0;
          }
        } else if (e.key === 'ArrowUp') {
          if (this.activeLineIdx > 0) {
            this.activeLineIdx--;
            this.cursorCharIdx = Math.min(this.cursorCharIdx, (curPage.lines[this.activeLineIdx].text || '').length);
          } else if (this.activePageIdx > 0) {
            this.activePageIdx--;
            const prevPage = this.pages[this.activePageIdx];
            this.activeLineIdx = Math.max(0, prevPage.lines.length - 1);
            const pl = prevPage.lines[this.activeLineIdx];
            this.cursorCharIdx = Math.min(this.cursorCharIdx, pl ? (pl.text || '').length : 0);
          }
        } else if (e.key === 'ArrowDown') {
          if (this.activeLineIdx < curPage.lines.length - 1) {
            this.activeLineIdx++;
            this.cursorCharIdx = Math.min(this.cursorCharIdx, (curPage.lines[this.activeLineIdx].text || '').length);
          } else if (this.activePageIdx < this.pages.length - 1) {
            this.activePageIdx++;
            this.activeLineIdx = 0;
            this.cursorCharIdx = 0;
          }
        }

        if (e.shiftKey) {
          this.selection = {
            anchor: anchorPt,
            focus: this._pointOf(this.activePageIdx, this.activeLineIdx, this.cursorCharIdx)
          };
          this.renderAllPages();
        } else {
          this.selection = null;
        }
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        // Mengetik saat ada seleksi = TIMPA rentang (paritas Docs).
        if (this.hasSelection()) {
          this.deleteSelection();
          // deleteSelection() sudah me-reflow; ambil ulang referensi baris
          // karena objek `line` lama bisa sudah tidak dipakai lagi.
          const np = this.pages[this.activePageIdx];
          line = np && np.lines[this.activeLineIdx];
          if (!line) return;
        }
        line.text = line.text.slice(0, this.cursorCharIdx) + e.key + line.text.slice(this.cursorCharIdx);
        // Sisip 1 karakter: batas run, tautan & komentar ikut bergeser.
        this._editRuns(line, this.cursorCharIdx, 0, e.key);
        this._shiftLinks(line, this.cursorCharIdx, 1);
        this._shiftComments(line, this.cursorCharIdx, 1);
        this.cursorCharIdx++;
        modified = true;
      }

      this.isCaretVisible = true;
      if (modified) {
        this.reflowPages();     // paginasi dinamis: baris meluber -> halaman baru
        this.renderAllPages();  // rebuild seluruh tile agar jumlah halaman ikut berubah
      } else {
        this.renderPage(this.activePageIdx);
      }
      this.emitActiveLine();

      if (modified && typeof this.onChange === 'function') {
        this.onChange(this.getDocumentData());
      }
    }

    // ==== FORMATTING ====
    // prop: bold | italic | underline | strike | size | color | align | fontFamily
    applyFormatting(prop, val) {
      this.currentStyle[prop] = val;
      const page = this.pages[this.activePageIdx];
      const line = page && page.lines[this.activeLineIdx];
      if (line) {
        line[prop] = val;
        this.reflowPages();
        this.renderAllPages();
        this.emitActiveLine();
        if (typeof this.onChange === 'function') {
          this.onChange(this.getDocumentData());
        }
      }
    }

    toggleFormatting(prop) {
      // Toggle berdasar nilai BARIS AKTIF, bukan currentStyle — kalau currentStyle
      // dipakai, baris yang sudah bold akan "di-toggle" menjadi bold lagi (tidak
      // ada perubahan yang terlihat oleh user).
      const page = this.pages[this.activePageIdx];
      const line = page && page.lines[this.activeLineIdx];
      const cur = line ? !!line[prop] : !!this.currentStyle[prop];
      this.applyFormatting(prop, !cur);
    }

    // ==== GEOMETRI HALAMAN (satu sumber kebenaran) ====
    // Semua posisi memakai helper ini, BUKAN konstanta langsung, supaya
    // penyiapan halaman (ukuran kertas/margin/orientasi) benar-benar berlaku.
    // Nilai default SENGAJA identik dengan konstanta lama (636x850, margin 30,
    // teks mulai y=60, batas bawah 770) sehingga dokumen seed tidak berubah.
    pageWidth() {
      const ps = this.pageSetup || {};
      const preset = PAPER_PRESETS[ps.paperSize] || PAPER_PRESETS.kix;
      return (ps.orientation === 'landscape') ? preset.height : preset.width;
    }

    pageHeight() {
      const ps = this.pageSetup || {};
      const preset = PAPER_PRESETS[ps.paperSize] || PAPER_PRESETS.kix;
      return (ps.orientation === 'landscape') ? preset.width : preset.height;
    }

    marginLeft()  { return (this.pageSetup && this.pageSetup.marginLeft  != null) ? this.pageSetup.marginLeft  : MARGIN; }
    marginRight() { return (this.pageSetup && this.pageSetup.marginRight != null) ? this.pageSetup.marginRight : MARGIN; }
    marginTop()   { return (this.pageSetup && this.pageSetup.marginTop   != null) ? this.pageSetup.marginTop   : MARGIN; }
    marginBottom(){ return (this.pageSetup && this.pageSetup.marginBottom!= null) ? this.pageSetup.marginBottom: MARGIN; }

    // Y tempat baris pertama dimulai. Default 60 (= LINE_TOP_OFFSET lama).
    textTop() {
      return LINE_TOP_OFFSET + (this.marginTop() - MARGIN);
    }

    // Batas bawah area teks. Default 770 (= MAX_TEXT_Y lama).
    maxTextY() {
      return this.pageHeight() - 80 + (this.marginBottom() - MARGIN);
    }

    getPageSetup() {
      return {
        paperSize: this.pageSetup.paperSize,
        orientation: this.pageSetup.orientation,
        marginTop: this.marginTop(),
        marginBottom: this.marginBottom(),
        marginLeft: this.marginLeft(),
        marginRight: this.marginRight(),
        width: this.pageWidth(),
        height: this.pageHeight()
      };
    }

    // Terapkan penyiapan halaman. Nilai tak dikenal diabaikan (bukan di-throw)
    // supaya pemanggil dari UI/menu tidak bisa merusak dokumen.
    setPageSetup(opts) {
      const o = opts || {};
      const ps = this.pageSetup;
      if (o.paperSize && PAPER_PRESETS[o.paperSize]) ps.paperSize = o.paperSize;
      if (o.orientation === 'portrait' || o.orientation === 'landscape') ps.orientation = o.orientation;
      const clampM = (v, fallback) => {
        const n = Number(v);
        if (!isFinite(n)) return fallback;
        // Margin dibatasi agar area teks tidak pernah kosong/negatif.
        return Math.max(0, Math.min(200, Math.round(n)));
      };
      if (o.marginTop !== undefined)    ps.marginTop = clampM(o.marginTop, ps.marginTop);
      if (o.marginBottom !== undefined) ps.marginBottom = clampM(o.marginBottom, ps.marginBottom);
      if (o.marginLeft !== undefined)   ps.marginLeft = clampM(o.marginLeft, ps.marginLeft);
      if (o.marginRight !== undefined)  ps.marginRight = clampM(o.marginRight, ps.marginRight);
      this.reflowPages();
      this.renderAllPages();
      this.notifyChange();
      return this.getPageSetup();
    }

    // ==== TABEL KANVAS (paritas Google Docs: Sisipkan > Tabel) ====
    // Lebar kolom & tinggi baris adalah SATU SUMBER KEBENARAN yang dipakai
    // bersama oleh render, hit-test, dan paginasi. Kalau masing-masing
    // menghitung sendiri, klik pada sel bisa mendarat di sel tetangga.
    tableColWidths(line) {
      const t = line && line.table;
      if (!t) return [];
      const nCols = (t.rows && t.rows[0]) ? t.rows[0].length : 0;
      if (Array.isArray(t.colWidths) && t.colWidths.length === nCols) return t.colWidths;
      const total = this.pageWidth() - this.marginLeft() - this.marginRight();
      return new Array(nCols).fill(nCols ? total / nCols : 0);
    }

    tableRowHeight(line) {
      return (line && line.table && line.table.rowHeight) || 30;
    }

    // Tinggi total blok tabel (dipakai measureLine sehingga paginasi otomatis benar).
    tableHeight(line) {
      const t = line && line.table;
      if (!t || !Array.isArray(t.rows)) return this.tableRowHeight(line);
      return Math.max(1, t.rows.length) * this.tableRowHeight(line);
    }

    // Y puncak sebuah baris di kanvas — dihitung dengan rumus yang SAMA dengan
    // renderPage (akumulasi measureLine), jadi tabel tidak pernah "melayang".
    lineTopY(pIdx, lIdx) {
      // Delegasi ke _lineTops supaya hanya ada SATU rumus tinggi baris di
      // seluruh engine (tabel, ceklis, hit-test, dan pengujian).
      const tops = this._lineTops(pIdx);
      const n = Math.max(0, tops.length - 1);
      return tops[Math.max(0, Math.min(n, lIdx))];
    }

    tableCellRect(pIdx, lIdx, r, c) {
      const line = this.pages[pIdx] && this.pages[pIdx].lines[lIdx];
      const t = line && line.table;
      if (!t || !Array.isArray(t.rows) || !t.rows[r] || !t.rows[r][c]) return null;
      const widths = this.tableColWidths(line);
      const rh = this.tableRowHeight(line);
      const yTop = this.lineTopY(pIdx, lIdx);
      let x = this.marginLeft();
      for (let i = 0; i < c; i++) x += widths[i];
      return { x, y: yTop + r * rh, w: widths[c], h: rh };
    }

    tableCellAt(pIdx, x, y) {
      for (const b of this._tableBoxes) {
        if (b.pIdx !== pIdx) continue;
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
      }
      return null;
    }

    // Sisipkan tabel baru (rows x cols) SETELAH baris aktif. Baris pertama
    // selalu kosong (bukan menyalin teks baris aktif) — paritas Docs.
    insertTable(rows, cols) {
      const nR = Math.max(1, Math.min(50, rows || 2));
      const nC = Math.max(1, Math.min(12, cols || 2));
      const grid = [];
      for (let r = 0; r < nR; r++) {
        const row = [];
        for (let c = 0; c < nC; c++) row.push({ text: '' });
        grid.push(row);
      }
      const line = {
        type: 'table',
        text: '',
        table: { rows: grid, rowHeight: 30 }
      };
      const page = this.pages[this.activePageIdx];
      if (!page) return false;
      const at = Math.min(page.lines.length, this.activeLineIdx + 1);
      page.lines.splice(at, 0, line);
      this.activeLineIdx = at;
      this.activeCell = { r: 0, c: 0 };
      this.reflowPages();
      this.renderAllPages();
      this.emitActiveLine();
      this.notifyChange();
      return true;
    }

    // Baris aktif adalah tabel?
    activeTableLine() {
      const page = this.pages[this.activePageIdx];
      const line = page && page.lines[this.activeLineIdx];
      return (line && line.type === 'table') ? line : null;
    }

    // Navigasi sel. `wrap` = kembali ke kolom 0 baris berikutnya; bila sudah di
    // sel terakhir, TAMBAH baris baru (paritas Docs: Tab di ujung tabel).
    moveCell(dr, dc) {
      const line = this.activeTableLine();
      if (!line || !this.activeCell) return false;
      const t = line.table;
      const nR = t.rows.length;
      const nC = (t.rows[0] || []).length;
      let { r, c } = this.activeCell;
      if (dc) {
        c += dc;
        if (c >= nC) {
          if (r === nR - 1) {
            const row = [];
            for (let i = 0; i < nC; i++) row.push({ text: '' });
            t.rows.push(row);
          }
          r++; c = 0;
        } else if (c < 0) {
          if (r === 0) { c = 0; }
          else { r--; c = nC - 1; }
        }
      }
      if (dr) {
        r += dr;
        if (r >= nR) r = nR - 1;
        if (r < 0) r = 0;
        if (c >= nC) c = nC - 1;
      }
      this.activeCell = { r, c };
      // Caret pindah ke UJUNG teks sel tujuan. Tanpa ini caret bisa menunjuk
      // offset melewati panjang teks sel baru (sel lama 20 huruf -> sel baru
      // 3 huruf), dan ketikan berikutnya tampak "hilang".
      const newRow = t.rows[r];
      const newCell = newRow ? newRow[c] : null;
      this.cellCaret = newCell ? (newCell.text || '').length : 0;
      this.renderAllPages();
      this.emitActiveLine();
      return true;
    }

    // ==== STRUKTUR TABEL: TAMBAH / HAPUS BARIS & KOLOM ====
    // Paritas Docs: operasi berlaku pada baris/kolom tempat sel aktif berada.
    // Tanpa ini tabel hanya bisa dibuat, tidak bisa diubah setelahnya.
    insertTableRow(where) {
      const line = this.activeTableLine();
      if (!line || !this.activeCell) return false;
      const t = line.table;
      const nC = (t.rows[0] || []).length;
      const row = [];
      for (let i = 0; i < nC; i++) row.push({ text: '' });
      const at = (where === 'above') ? this.activeCell.r : this.activeCell.r + 1;
      t.rows.splice(at, 0, row);
      this.activeCell = { r: at, c: this.activeCell.c };
      this.cellCaret = 0;
      this.reflowPages();
      this.renderAllPages();
      this.emitActiveLine();
      this.notifyChange();
      return true;
    }

    deleteTableRow() {
      const line = this.activeTableLine();
      if (!line || !this.activeCell) return false;
      const t = line.table;
      // Tabel minimal harus punya satu baris; menghapus baris terakhir
      // akan menyisakan struktur tanpa sel yang membuat render pecah.
      if (t.rows.length <= 1) return false;
      const r = Math.max(0, Math.min(t.rows.length - 1, this.activeCell.r));
      t.rows.splice(r, 1);
      this.activeCell = { r: Math.min(r, t.rows.length - 1), c: this.activeCell.c };
      this.cellCaret = 0;
      this.reflowPages();
      this.renderAllPages();
      this.emitActiveLine();
      this.notifyChange();
      return true;
    }

    insertTableColumn(where) {
      const line = this.activeTableLine();
      if (!line || !this.activeCell) return false;
      const t = line.table;
      const at = (where === 'left') ? this.activeCell.c : this.activeCell.c + 1;
      for (const row of t.rows) row.splice(at, 0, { text: '' });
      this.activeCell = { r: this.activeCell.r, c: at };
      this.cellCaret = 0;
      this.reflowPages();
      this.renderAllPages();
      this.emitActiveLine();
      this.notifyChange();
      return true;
    }

    deleteTableColumn() {
      const line = this.activeTableLine();
      if (!line || !this.activeCell) return false;
      const t = line.table;
      const nC = (t.rows[0] || []).length;
      // Sama seperti baris: minimal satu kolom harus tersisa.
      if (nC <= 1) return false;
      const c = Math.max(0, Math.min(nC - 1, this.activeCell.c));
      for (const row of t.rows) row.splice(c, 1);
      this.activeCell = { r: this.activeCell.r, c: Math.min(c, nC - 2) };
      this.cellCaret = 0;
      this.reflowPages();
      this.renderAllPages();
      this.emitActiveLine();
      this.notifyChange();
      return true;
    }

    // Teks sel aktif (dipakai handleTableKey).
    _cell() {
      const line = this.activeTableLine();
      if (!line || !this.activeCell) return null;
      const row = line.table.rows[this.activeCell.r];
      return row ? row[this.activeCell.c] : null;
    }

    // ==== MODEL SELEKSI RENTANG ====
    // Semua posisi memakai bentuk seragam { pageIdx, lineIdx, charIdx } dan
    // charIdx SELALU berada pada basis line.text (tanpa penanda butir), sama
    // seperti cursorCharIdx — sehingga seleksi, caret, tautan, dan komentar
    // memakai satu sistem koordinat yang sama.
    _pointOf(pageIdx, lineIdx, charIdx) {
      return { pageIdx: pageIdx || 0, lineIdx: lineIdx || 0, charIdx: charIdx || 0 };
    }

    _comparePoints(a, b) {
      if (!a || !b) return 0;
      if (a.pageIdx !== b.pageIdx) return a.pageIdx - b.pageIdx;
      if (a.lineIdx !== b.lineIdx) return a.lineIdx - b.lineIdx;
      return a.charIdx - b.charIdx;
    }

    _isSamePos(a, b) {
      return this._comparePoints(a, b) === 0;
    }

    hasSelection() {
      return !!(this.selection && this.selection.anchor && this.selection.focus &&
                !this._isSamePos(this.selection.anchor, this.selection.focus));
    }

    // Selalu mengembalikan rentang TERURUT. Arah seleksi (maju/mundur) tidak
    // pernah perlu diperiksa pemanggil — ini mencegah pemotongan teks salah sisi
    // saat user men-drag dari kanan ke kiri.
    getSelectionRange() {
      if (!this.hasSelection()) return null;
      const a = this.selection.anchor, f = this.selection.focus;
      const backward = this._comparePoints(a, f) > 0;
      return {
        start: backward ? f : a,
        end: backward ? a : f,
        backward
      };
    }

    selectAll() {
      const lastP = this.pages.length - 1;
      if (lastP < 0) return;
      const lastL = Math.max(0, this.pages[lastP].lines.length - 1);
      const lastLine = this.pages[lastP].lines[lastL];
      this.selection = {
        anchor: this._pointOf(0, 0, 0),
        focus: this._pointOf(lastP, lastL, lastLine ? (lastLine.text || '').length : 0)
      };
      this.activePageIdx = lastP;
      this.activeLineIdx = lastL;
      this.cursorCharIdx = lastLine ? (lastLine.text || '').length : 0;
      this.renderAllPages();
      this.emitActiveLine();
    }


    // API publik: menetapkan seleksi rentang secara programatik (paritas Docs).
    // Dua alasan kenapa ini ada, bukan sekadar seleksi via mouse:
    //   1) UI membutuhkannya untuk memilih hasil Find & Replace / tautan;
    //   2) pengujian otomatis tidak bisa mensimulasikan drag mouse di kanvas,
    //      jadi tanpa jalur ini seluruh perilaku seleksi mustahil diverifikasi.
    // Titik masukan dinormalkan lewat _pointOf() supaya indeks liar (mis. charIdx
    // melebihi panjang baris) tidak pernah merusak render.
    setSelectionRange(anchor, focus) {
      if (!anchor || !focus) { this.selection = null; return null; }
      const a = this._pointOf(anchor.pageIdx, anchor.lineIdx, anchor.charIdx);
      const f = this._pointOf(focus.pageIdx, focus.lineIdx, focus.charIdx);
      this.selection = { anchor: a, focus: f };
      this.activePageIdx = f.pageIdx;
      this.activeLineIdx = f.lineIdx;
      this.cursorCharIdx = f.charIdx;
      this.renderAllPages();
      this.emitActiveLine();
      return this.getSelectionRange();
    }
    collapseSelection(to) {
      const r = this.getSelectionRange();
      if (!r) { this.selection = null; return null; }
      const pt = (to === 'start') ? r.start : r.end;
      this.selection = null;
      this.activePageIdx = pt.pageIdx;
      this.activeLineIdx = pt.lineIdx;
      this.cursorCharIdx = pt.charIdx;
      return pt;
    }

    // Batas kata di sekitar `charIdx` (paritas double-click Docs).
    _wordRangeAt(pIdx, lIdx, charIdx) {
      const line = this.pages[pIdx] && this.pages[pIdx].lines[lIdx];
      const text = line ? (line.text || '') : '';
      if (!text) return { start: 0, end: 0 };
      const isWord = (ch) => /[A-Za-z0-9_\u00C0-\u024F]/.test(ch);
      let s = Math.max(0, Math.min(text.length, charIdx));
      let e = s;
      while (s > 0 && isWord(text[s - 1])) s--;
      while (e < text.length && isWord(text[e])) e++;
      // Klik tepat di atas spasi/tanda baca: ambil kata di sebelah kanan.
      if (s === e) {
        let k = e;
        while (k < text.length && !isWord(text[k])) k++;
        let m = k;
        while (m < text.length && isWord(text[m])) m++;
        if (m > k) return { start: k, end: m };
      }
      return { start: s, end: e };
    }

    // Koordinat klien -> titik dokumen, dengan kompensasi zoom (rasio
    // canvas.width / rect.width) supaya seleksi tetap akurat saat di-zoom.
    _pointFromClient(clientX, clientY) {
      if (typeof document === 'undefined') return null;
      const el = document.elementFromPoint ? document.elementFromPoint(clientX, clientY) : null;
      const host = el && el.closest ? el.closest('.kix-page') : null;
      if (!host) return null;
      const canvas = host.querySelector('canvas');
      if (!canvas) return null;
      const pIdxRaw = parseInt(canvas.getAttribute('data-page') || '0', 10);
      const rect = canvas.getBoundingClientRect();
      const zx = rect.width ? this.viewW() / rect.width : 1;
      const zy = rect.height ? this.viewH() / rect.height : 1;
      const lx = (clientX - rect.left) * zx;
      const ly = (clientY - rect.top) * zy;
      const lIdxRaw = this.lineIndexAtY(pIdxRaw, ly);
      const clamped = this.clampPoint(pIdxRaw, lIdxRaw, lx);
      const charIdx = this.charIndexAtPoint(clamped.pIdx, clamped.lIdx, lx);
      return this._pointOf(clamped.pIdx, clamped.lIdx, charIdx);
    }

    // Teks murni dari rentang terpilih; baris digabung dengan newline.
    getSelectedText() {
      const r = this.getSelectionRange();
      if (!r) return '';
      const out = [];
      for (let p = r.start.pageIdx; p <= r.end.pageIdx; p++) {
        const page = this.pages[p];
        if (!page) continue;
        const from = (p === r.start.pageIdx) ? r.start.lineIdx : 0;
        const to = (p === r.end.pageIdx) ? r.end.lineIdx : page.lines.length - 1;
        for (let l = from; l <= to; l++) {
          const line = page.lines[l];
          if (!line) continue;
          const t = line.text || '';
          const a = (p === r.start.pageIdx && l === r.start.lineIdx) ? r.start.charIdx : 0;
          const b = (p === r.end.pageIdx && l === r.end.lineIdx) ? r.end.charIdx : t.length;
          out.push(t.slice(Math.max(0, a), Math.max(a, b)));
        }
      }
      return out.join('\n');
    }

    // Salin rentang terpilih ke clipboard sistem. `_clipboard` internal dipakai
    // sebagai cadangan karena navigator.clipboard butuh konteks aman (https /
    // localhost) dan izin — tanpa cadangan ini Ctrl+C diam-diam gagal.
    copySelection() {
      const text = this.getSelectedText();
      if (!text) return false;
      this._clipboard = text;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard &&
            typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).catch(() => {});
        }
      } catch (_) { /* clipboard ditolak: cadangan internal tetap terisi */ }
      if (typeof this.onCopy === 'function') this.onCopy(text);
      return true;
    }

    cutSelection() {
      if (!this.hasSelection()) return false;
      const text = this.getSelectedText();
      this.copySelection();
      this.deleteSelection();
      return !!text;
    }

    // Hapus seluruh isi rentang terpilih dan runtuhkan kursor ke awal rentang.
    // Baris perantara dihapus; baris awal & akhir disambung. Offset tautan dan
    // komentar pada baris akhir digeser agar tidak menunjuk karakter yang salah.
    deleteSelection() {
      const r = this.getSelectionRange();
      if (!r) return false;
      const { start, end } = r;
      const sp = this.pages[start.pageIdx], ep = this.pages[end.pageIdx];
      if (!sp || !ep) { this.selection = null; return false; }

      if (start.pageIdx === end.pageIdx && start.lineIdx === end.lineIdx) {
        const line = sp.lines[start.lineIdx];
        if (!line) { this.selection = null; return false; }
        const a = Math.max(0, Math.min((line.text || '').length, start.charIdx));
        const b = Math.max(a, Math.min((line.text || '').length, end.charIdx));
        if (b > a) {
          line.text = (line.text || '').slice(0, a) + (line.text || '').slice(b);
          this._editRuns(line, a, b - a, '');
          this._shiftLinks(line, a, -(b - a));
          this._shiftComments(line, a, -(b - a));
        }
        this.selection = null;
        this.activePageIdx = start.pageIdx;
        this.activeLineIdx = start.lineIdx;
        this.cursorCharIdx = a;
        this.reflowPages();
        this.renderAllPages();
        this.emitActiveLine();
        this.notifyChange();
        return true;
      }

      // ==== RENTANG LINTAS BARIS / HALAMAN ====
      const startLine = sp.lines[start.lineIdx];
      const endLine = ep.lines[end.lineIdx];
      if (!startLine || !endLine) { this.selection = null; return false; }
      const a = Math.max(0, Math.min((startLine.text || '').length, start.charIdx));
      const b = Math.max(0, Math.min((endLine.text || '').length, end.charIdx));
      const head = (startLine.text || '').slice(0, a);
      const tail = (endLine.text || '').slice(b);
      startLine.text = head + tail;

      // Gaya baris akhir dilebur: runs & tautan baris akhir digeser sepanjang `head`.
      if (Array.isArray(endLine.runs) && endLine.runs.length) {
        const shifted = endLine.runs
          .map(r => ({ ...r, text: r.text }))
          .filter(Boolean);
        // Bangun ulang runs hasil sambungan: runs baris awal (dipotong di a)
        // diikuti runs baris akhir (dipotong di b, digeser).
        const keepRuns = (Array.isArray(startLine.runs) && startLine.runs.length)
          ? startLine.runs : null;
        const mergedRuns = [];
        if (keepRuns) {
          let pos = 0;
          for (const r of keepRuns) {
            const len = r.text.length;
            if (pos >= a) break;
            const take = Math.min(len, a - pos);
            if (take > 0) mergedRuns.push({ ...r, text: r.text.slice(0, take) });
            pos += len;
          }
        }
        let pos2 = 0;
        for (const r of shifted) {
          const len = r.text.length;
          if (pos2 + len > b) {
            const cut = Math.max(0, b - pos2);
            const rest = r.text.slice(cut);
            if (rest) mergedRuns.push({ ...r, text: rest });
          }
          pos2 += len;
        }
        if (mergedRuns.length) {
          startLine.runs = mergedRuns;
        } else {
          delete startLine.runs;
        }
      }
      if (Array.isArray(endLine.links) && endLine.links.length) {
        const moved = endLine.links
          .filter(L => L.end > b)
          .map(L => ({ start: Math.max(a, L.start - b + a), end: L.end - b + a, url: L.url }));
        startLine.links = (Array.isArray(startLine.links) ? startLine.links : []).concat(moved);
        delete endLine.links;
      }
      if (Array.isArray(endLine.comments) && endLine.comments.length) {
        const movedC = endLine.comments
          .filter(C => C.end > b)
          .map(C => ({ ...C, start: Math.max(a, C.start - b + a), end: C.end - b + a }));
        startLine.comments = (Array.isArray(startLine.comments) ? startLine.comments : []).concat(movedC);
        delete endLine.comments;
      }

      // Hapus baris di antara start dan end (termasuk baris akhir), lalu sisakan baris awal.
      if (start.pageIdx === end.pageIdx) {
        sp.lines.splice(start.lineIdx + 1, end.lineIdx - start.lineIdx);
      } else {
        sp.lines.splice(start.lineIdx + 1, sp.lines.length - start.lineIdx - 1);
        for (let p = start.pageIdx + 1; p < end.pageIdx; p++) this.pages[p].lines = [];
        ep.lines.splice(0, end.lineIdx + 1);
      }
      this.selection = null;
      this.activePageIdx = start.pageIdx;
      this.activeLineIdx = start.lineIdx;
      this.cursorCharIdx = a;
      this.reflowPages();
      this.renderAllPages();
      this.emitActiveLine();
      this.notifyChange();
      return true;
    }

    // Sisip teks pada kursor (dipakai paste & jalur ketik multi-karakter).
    insertText(text) {
      if (!text) return false;
      if (this.hasSelection()) this.deleteSelection();
      const page = this.pages[this.activePageIdx];
      const line = page && page.lines[this.activeLineIdx];
      if (!line) return false;
      const t = String(text).replace(/\r\n/g, '\n');
      const parts = t.split('\n');
      const at = this.cursorCharIdx;
      const head = (line.text || '').slice(0, at);
      const tail = (line.text || '').slice(at);
      line.text = head + parts[0];
      this._editRuns(line, at, 0, parts[0]);
      this._shiftLinks(line, at, parts[0].length);
      this._shiftComments(line, at, parts[0].length);
      this.cursorCharIdx = (head + parts[0]).length;
      if (parts.length > 1) {
        // Multi-baris: sisa bagian menjadi baris-baris baru setelah baris aktif.
        let insertAt = this.activeLineIdx + 1;
        for (let i = 1; i < parts.length; i++) {
          const isLast = (i === parts.length - 1);
          const nl = { text: isLast ? parts[i] + tail : parts[i] };
          for (const k of LINE_STYLE_KEYS) {
            if (line[k] !== undefined) nl[k] = line[k];
          }
          if (nl.listType) delete nl.checked;
          page.lines.splice(insertAt, 0, nl);
          insertAt++;
        }
        this.activeLineIdx = insertAt - 1;
        this.cursorCharIdx = parts[parts.length - 1].length;
      }
      this.reflowPages();
      this.renderAllPages();
      this.emitActiveLine();
      this.notifyChange();
      return true;
    }

    // Terapkan gaya run-level ke SELURUH rentang seleksi, lintas baris & halaman.
    applyFormatToSelection(prop, value) {
      const r = this.getSelectionRange();
      if (!r) return false;
      for (let p = r.start.pageIdx; p <= r.end.pageIdx; p++) {
        const page = this.pages[p];
        if (!page) continue;
        const from = (p === r.start.pageIdx) ? r.start.lineIdx : 0;
        const to = (p === r.end.pageIdx) ? r.end.lineIdx : page.lines.length - 1;
        for (let l = from; l <= to; l++) {
          const line = page.lines[l];
          if (!line) continue;
          const len = (line.text || '').length;
          const a = (p === r.start.pageIdx && l === r.start.lineIdx) ? r.start.charIdx : 0;
          const b = (p === r.end.pageIdx && l === r.end.lineIdx) ? r.end.charIdx : len;
          if (b <= a) continue;
          // applyInlineFormat bekerja pada baris AKTIF, jadi arahkan dulu.
          this.activePageIdx = p;
          this.activeLineIdx = l;
          this.applyInlineFormat(a, b, { [prop]: value });
        }
      }
      // Kembalikan fokus ke ujung seleksi agar caret tidak melompat.
      this.activePageIdx = r.end.pageIdx;
      this.activeLineIdx = r.end.lineIdx;
      this.cursorCharIdx = r.end.charIdx;
      this.renderAllPages();
      this.emitActiveLine();
      this.notifyChange();
      return true;
    }

    emitActiveLine() {
      if (typeof this.onActiveLineChange === 'function') {
        const page = this.pages[this.activePageIdx];
        const line = page ? page.lines[this.activeLineIdx] : null;
        this.onActiveLineChange(line, this.currentStyle, this.getActiveFormatting());
      }
    }

    // ==== SINKRONISASI `runs` TERHADAP EDIT TEKS ====
    // `line.text` adalah sumber kebenaran; `line.runs` hanyalah tampilan
    // terperincinya. Setiap operasi teks WAJIB memindahkan batas run dengan
    // jumlah yang sama, kalau tidak offset run melenceng satu karakter setiap
    // kali user mengetik/menghapus — cacat senyap: teks di kanvas tetap
    // "terlihat benar" karena `line.text` masih utuh, sementara pewarnaan dan
    // ketebalan run perlahan menempel ke huruf yang salah.
    //
    // Kontrak: setelah fungsi ini, concat(runs.text) HARUS === line.text.
    // Bila tidak dapat dijamin, runs dibuang (fallback ke gaya baris datar)
    // supaya tampilan tidak pernah lebih buruk daripada sebelum ada runs.
    _editRuns(line, at, delCount, insText) {
      if (!Array.isArray(line.runs) || !line.runs.length) return;
      const runs = line.runs.map(r => ({ ...r }));
      const ins = insText || '';
      // 1) Hapus `delCount` karakter mulai offset `at`.
      if (delCount > 0) {
        let pos = 0;
        for (let i = 0; i < runs.length; i++) {
          const len = (runs[i].text || '').length;
          const s = pos, e = pos + len;
          pos = e;
          if (e <= at || s >= at + delCount) continue;
          const cutStart = Math.max(0, at - s);
          const cutEnd = Math.min(len, at + delCount - s);
          runs[i].text = runs[i].text.slice(0, cutStart) + runs[i].text.slice(cutEnd);
        }
      }
      // 2) Sisipkan `ins` pada offset `at`, mewarisi gaya run yang menaungi `at`.
      if (ins) {
        let pos = 0, placed = false;
        for (let i = 0; i < runs.length; i++) {
          const len = (runs[i].text || '').length;
          const s = pos, e = pos + len;
          pos = e;
          if (at > s && at < e) {
            const cut = at - s;
            const left = runs[i].text.slice(0, cut);
            const right = runs[i].text.slice(cut);
            runs.splice(i, 1, { ...runs[i], text: left }, { ...runs[i], text: ins + right });
            placed = true;
            break;
          }
        }
        if (!placed) {
          // `at` jatuh tepat di batas run: warisi run SEBELUMNYA bila ada
          // (perilaku Google Docs — mengetik di ujung kata tebal melanjutkan tebal).
          let pos2 = 0, target = -1;
          for (let i = 0; i < runs.length; i++) {
            const len = (runs[i].text || '').length;
            if (at <= pos2 + len) { target = i; break; }
            pos2 += len;
          }
          if (target < 0) target = runs.length - 1;
          if (target >= 0) {
            const r = runs[target];
            const cut = Math.max(0, Math.min((r.text || '').length, at - pos2));
            runs[target] = { ...r, text: r.text.slice(0, cut) + ins + r.text.slice(cut) };
          }
        }
      }
      // 3) Buang run kosong + gabungkan run berdampingan bergaya identik.
      const merged = [];
      for (const r of runs) {
        if (!r.text) continue;
        const p = merged[merged.length - 1];
        if (p && p.bold === r.bold && p.italic === r.italic && p.underline === r.underline &&
            p.strike === r.strike && p.size === r.size && p.color === r.color &&
            p.fontFamily === r.fontFamily) {
          p.text += r.text;
        } else {
          merged.push(r);
        }
      }
      // 4) Verifikasi akhir: runs WAJIB mereproduksi line.text persis.
      const joined = merged.map(r => r.text).join('');
      if (joined !== (line.text || '')) {
        delete line.runs;           // fallback aman: gaya baris datar
        return;
      }
      // Satu run sisa = tidak ada informasi gaya tambahan; simpan sebagai
      // baris datar agar jalur render cepat (dan paginasi lama) tetap dipakai.
      if (merged.length <= 1) {
        delete line.runs;
        return;
      }
      line.runs = merged;
    }

    notifyChange() {
      if (typeof this.onChange === 'function') {
        this.onChange(this.getDocumentData());
      }
    }

    getActiveFormatting() {
      const page = this.pages[this.activePageIdx];
      const line = page ? page.lines[this.activeLineIdx] : null;
      const st = line || this.currentStyle || {};
      return {
        bold: !!st.bold,
        italic: !!st.italic,
        underline: !!st.underline,
        strike: !!st.strike,
        size: st.size || 13,
        color: st.color || '#202124',
        align: st.align || 'left',
        heading: st.heading || 'normal',
        listType: st.listType || null,
        indent: st.indent || 0,
        fontFamily: st.fontFamily || 'Arial'
      };
    }

    clampPoint(pIdx, lIdx, x) {
      const safeP = Math.max(0, Math.min(this.pages.length - 1, pIdx || 0));
      const page = this.pages[safeP];
      const maxL = Math.max(0, (page && page.lines ? page.lines.length : 1) - 1);
      const safeL = Math.max(0, Math.min(maxL, lIdx || 0));
      const mL = this.marginLeft();
      const safeX = Math.max(mL, Math.min(this.pageWidth() - this.marginRight(), x || mL));
      return { pIdx: safeP, lIdx: safeL, x: safeX };
    }

    getStatistics() {
      let words = 0, chars = 0, charsNoSpaces = 0;
      for (const p of this.pages) {
        for (const l of p.lines) {
          const t = l.text || '';
          chars += t.length;
          charsNoSpaces += t.replace(/\s/g, '').length;
          const w = t.trim().split(/\s+/).filter(Boolean).length;
          words += w;
        }
      }
      return {
        pages: this.pages.length,
        words,
        characters: chars,
        charactersNoSpaces: charsNoSpaces
      };
    }

    // ==== HEADER & FOOTER TEKS (paritas Docs) ====
    // Mengembalikan nilai EFEKTIF setelah perubahan, sehingga pemanggil dan
    // tes bisa membuktikan hasilnya tanpa membaca state internal.
    setHeaderFooter(opts) {
      const o = opts || {};
      const has = (k) => Object.prototype.hasOwnProperty.call(o, k);
      if (has('header')) this.headerText = (o.header === null || o.header === undefined) ? '' : String(o.header);
      if (has('footer')) this.footerText = (o.footer === null || o.footer === undefined) ? '' : String(o.footer);
      this.renderAllPages();
      this.notifyChange();
      return { header: this.headerText, footer: this.footerText };
    }

    getHeaderFooter() {
      return { header: this.headerText || '', footer: this.footerText || '' };
    }

    clearHeaderFooter() {
      return this.setHeaderFooter({ header: '', footer: '' });
    }

    // Digambar di AREA MARGIN, di luar alur teks, sehingga measureLine() dan
    // reflowPages() tidak terpengaruh: header/footer tidak menggeser paginasi.
    _drawHeaderFooter(ctx) {
      if (this.headerText) {
        ctx.save();
        ctx.font = '11px Arial, sans-serif';
        ctx.fillStyle = '#5f6368';
        ctx.textAlign = 'left';
        ctx.fillText(String(this.headerText), this.marginLeft(), this.marginTop() + 14);
        ctx.restore();
      }
      if (this.footerText) {
        ctx.save();
        ctx.font = '11px Arial, sans-serif';
        ctx.fillStyle = '#5f6368';
        ctx.textAlign = 'left';
        ctx.fillText(String(this.footerText), this.marginLeft(), this.pageHeight() - 38);
        ctx.restore();
      }
    }

    setPageNumbers(show) {
      this.showPageNumbers = !!show;
      this.renderAllPages();
    }

    togglePageNumbers() {
      this.setPageNumbers(!this.showPageNumbers);
    }

    applyInlineFormat(start, end, patch) {
      const page = this.pages[this.activePageIdx];
      const line = page && page.lines[this.activeLineIdx];
      if (!line || typeof start !== 'number' || typeof end !== 'number' || start >= end) return;
      const fullText = line.text || '';
      const s = Math.max(0, Math.min(fullText.length, start));
      const e = Math.max(s, Math.min(fullText.length, end));
      if (s === e) return;

      // Inisialisasi runs bila belum ada
      if (!Array.isArray(line.runs) || !line.runs.length) {
        line.runs = [{
          text: fullText,
          bold: !!line.bold,
          italic: !!line.italic,
          underline: !!line.underline,
          strike: !!line.strike,
          size: line.size || 13,
          color: line.color || '#202124',
          fontFamily: line.fontFamily || 'Arial'
        }];
      }

      // Potong runs pada offset s dan e
      const splitAt = (runs, offset) => {
        const out = [];
        let pos = 0;
        for (const r of runs) {
          const rLen = r.text.length;
          if (pos < offset && pos + rLen > offset) {
            const cut = offset - pos;
            out.push({ ...r, text: r.text.slice(0, cut) });
            out.push({ ...r, text: r.text.slice(cut) });
          } else {
            out.push({ ...r });
          }
          pos += rLen;
        }
        return out;
      };

      let newRuns = splitAt(line.runs, s);
      newRuns = splitAt(newRuns, e);

      // Terapkan patch pada rentang [s, e]
      let curPos = 0;
      for (const r of newRuns) {
        const rLen = r.text.length;
        if (curPos >= s && curPos + rLen <= e) {
          Object.assign(r, patch);
        }
        curPos += rLen;
      }

      // Gabungkan runs berdampingan dengan style identik
      const merged = [];
      for (const r of newRuns) {
        if (!r.text) continue;
        const prev = merged[merged.length - 1];
        if (prev && prev.bold === r.bold && prev.italic === r.italic &&
            prev.underline === r.underline && prev.strike === r.strike &&
            prev.size === r.size && prev.color === r.color &&
            prev.fontFamily === r.fontFamily) {
          prev.text += r.text;
        } else {
          merged.push(r);
        }
      }
      line.runs = merged.length ? merged : [{ text: fullText }];
      this.reflowPages();
      this.renderAllPages();
      this.emitActiveLine();
      this.notifyChange();
    }

    activeLineRef() {
      const page = this.pages[this.activePageIdx];
      return page ? page.lines[this.activeLineIdx] : null;
    }

    // Gaya paragraf ala Google Docs: Normal text / Title / Heading 1-3.
    applyParagraphStyle(styleKey) {
      const preset = PARAGRAPH_PRESETS[styleKey];
      const line = this.activeLineRef();
      if (!preset || !line) return;
      line.heading = styleKey === 'normal' ? null : styleKey;
      if (!line.heading) delete line.heading;
      line.size = preset.size;
      line.bold = preset.bold;
      this.currentStyle.size = preset.size;
      this.currentStyle.bold = preset.bold;
      this.reflowPages();
      this.renderAllPages();
      this.emitActiveLine();
      if (typeof this.onChange === 'function') this.onChange(this.getDocumentData());
    }

    // listType: 'bullet' | 'numbered' | 'checklist'. Tipe sama = lepas daftar.
    applyList(listType) {
      const line = this.activeLineRef();
      if (!line) return;
      if (line.listType === listType) {
        delete line.listType;
        delete line.checked;
      } else {
        line.listType = listType;
        if (listType === 'checklist') line.checked = false;
        else delete line.checked;
      }
      this.reflowPages();
      this.renderAllPages();
      this.emitActiveLine();
      if (typeof this.onChange === 'function') this.onChange(this.getDocumentData());
    }

    // Ceklis: dibalik saat pengguna MENGKLIK kotak centangnya di halaman.
    // Mengembalikan true bila ada baris yang berubah (agar pemanggil bisa
    // menandai bahwa ini klik-ceklis, bukan klik pemindah kursor biasa).
    toggleChecklistAt(pageIdx, lineIdx) {
      const page = this.pages[pageIdx];
      const line = page && page.lines[lineIdx];
      if (!line || line.listType !== 'checklist') return false;
      line.checked = !line.checked;
      this.renderAllPages();
      if (typeof this.onChange === 'function') this.onChange(this.getDocumentData());
      return true;
    }

    // Terapkan paritas "List Options" ala Google Docs pada baris bertipe
    // checklist: centang semua atau kosongkan semua.
    setAllChecked(checked) {
      const page = this.pages[this.activePageIdx];
      if (!page) return 0;
      let n = 0;
      for (const line of page.lines) {
        if (line.listType === 'checklist') { line.checked = !!checked; n++; }
      }
      if (n) {
        this.renderAllPages();
        if (typeof this.onChange === 'function') this.onChange(this.getDocumentData());
      }
      return n;
    }

    changeIndent(delta) {
      const line = this.activeLineRef();
      if (!line) return;
      const next = Math.max(0, Math.min(5, (line.indent || 0) + delta));
      if (next === 0) delete line.indent;
      else line.indent = next;
      this.reflowPages();
      this.renderAllPages();
      this.emitActiveLine();
      if (typeof this.onChange === 'function') this.onChange(this.getDocumentData());
    }

    changeSpacing(v) {
      const line = this.activeLineRef();
      if (!line) return;
      line.spacing = v;
      this.reflowPages();
      this.renderAllPages();
      this.emitActiveLine();
      if (typeof this.onChange === 'function') this.onChange(this.getDocumentData());
    }

    clearFormatting() {
      const line = this.activeLineRef();
      if (!line) return;
      for (const k of ['bold', 'italic', 'underline', 'strike', 'heading', 'listType', 'indent', 'spacing', 'checked']) {
        delete line[k];
      }
      line.size = 13;
      line.color = '#202124';
      line.align = 'left';
      line.fontFamily = 'Arial';
      this.currentStyle = {
        bold: false, italic: false, underline: false, strike: false,
        size: 13, color: '#202124', align: 'left', fontFamily: 'Arial'
      };
      this.reflowPages();
      this.renderAllPages();
      this.emitActiveLine();
      if (typeof this.onChange === 'function') this.onChange(this.getDocumentData());
    }

    // ==== PEMISAH HALAMAN MANUAL (paritas Google Docs: Ctrl+Enter) ====
    // Memotong dokumen di posisi kursor: teks SESUDAH kursor pindah ke halaman
    // baru, teks SEBELUM tetap di halaman lama.
    //
    // Tidak perlu flag "manualBreak" untuk mempertahankannya: reflowPages()
    // mengiterasi `for (const page of this.pages)` dan hanya MEMECAH halaman
    // yang meluber, tidak pernah MENGGABUNG dua halaman. Jadi objek halaman
    // baru di sini otomatis bertahan melewati paginasi berikutnya.
    insertPageBreak() {
      const pIdx = this.activePageIdx;
      const page = this.pages[pIdx];
      if (!page) return false;
      const lIdx = this.activeLineIdx;
      const line = page.lines[lIdx];
      if (!line) return false;

      const text = line.text || '';
      const cut = Math.max(0, Math.min(this.cursorCharIdx, text.length));

      // Tautan yang melintasi titik potong DIBELAH dua, bukan dibuang:
      // bagian kiri tetap di halaman lama, bagian kanan ikut ke halaman baru
      // dengan offset yang sudah dinormalkan (dikurangi cut).
      let movedLinks = null;
      if (Array.isArray(line.links) && line.links.length) {
        const keep = [], move = [];
        for (const L of line.links) {
          if (L.start >= cut) move.push({ start: L.start - cut, end: L.end - cut, url: L.url });
          else if (L.end > cut) {
            keep.push({ start: L.start, end: cut, url: L.url });
            move.push({ start: 0, end: L.end - cut, url: L.url });
          } else keep.push(L);
        }
        if (keep.length) line.links = keep; else delete line.links;
        if (move.length) movedLinks = move;
      }

      // ==== KOMENTAR SAAT PECAH HALAMAN (Opsi A) ====
      // Aturan sama dengan Enter: thread tidak dibelah. Komentar yang melintasi
      // titik potong tetap di halaman lama dengan end dipangkas ke cut.
      let movedComments = null;
      {
        const split = this._splitCommentsAt(line, cut);
        if (split) {
          if (split.keep.length) line.comments = split.keep; else delete line.comments;
          if (split.move.length) movedComments = split.move;
        }
      }

      const tailText = text.slice(cut);
      line.text = text.slice(0, cut);

      // Baris ekor mewarisi gaya baris asal supaya format user tidak hilang
      // tepat di titik pemisah halaman.
      const tailLine = { text: tailText };
      if (movedLinks) tailLine.links = movedLinks;
      if (movedComments) tailLine.comments = movedComments;
      for (const k of LINE_STYLE_KEYS) {
        if (line[k] !== undefined) tailLine[k] = line[k];
        else if (this.currentStyle[k] !== undefined) tailLine[k] = this.currentStyle[k];
      }

      const movedLines = [tailLine].concat(page.lines.slice(lIdx + 1));
      page.lines = page.lines.slice(0, lIdx + 1);

      this.pages.splice(pIdx + 1, 0, {
        pageNumber: this.pages.length + 1,
        lines: movedLines
      });

      this.activePageIdx = pIdx + 1;
      this.activeLineIdx = 0;
      this.cursorCharIdx = 0;
      this.isCaretVisible = true;

      // reflowPages() melacak baris aktif lewat IDENTITAS objek (tailLine),
      // jadi posisi kursor tetap benar walau halaman dipecah ulang di sini.
      this.reflowPages();
      this.renderAllPages();
      this.emitActiveLine();
      // Model dan kursor sudah pindah ke halaman baru, jadi VIEWPORT wajib ikut.
      // Tanpa ini layar tetap menampilkan halaman lama sementara status bar
      // menyebut halaman baru — indikator tampak berbohong.
      this.scrollPageIntoView(this.activePageIdx);
      if (typeof this.onChange === 'function') this.onChange(this.getDocumentData());
      return true;
    }

    insertNewPage() {
      const newPageNum = this.pages.length + 1;
      this.pages.push({
        pageNumber: newPageNum,
        lines: [
          { text: `Halaman Dokumen ${newPageNum}`, bold: true, size: 16, color: '#1a73e8' },
          { text: 'Ketik teks baru di halaman ini...', bold: false, size: 13, color: '#5f6368' }
        ]
      });
      this.activePageIdx = this.pages.length - 1;
      this.activeLineIdx = 0;
      this.cursorCharIdx = 0;
      this.renderAllPages();
      this.scrollPageIntoView(this.activePageIdx);
      if (typeof this.onChange === 'function') {
        this.onChange(this.getDocumentData());
      }
    }

    // Ekspor teks polos (untuk unduhan .txt)
    // ==== FIND & REPLACE ====
    // Semua pencarian bekerja pada MODEL TEKS (line.text), bukan DOM, karena
    // dokumen digambar ke kanvas. Offset = indeks karakter pada line.text TANPA
    // penanda butir daftar — basis yang sama dengan cursorCharIdx, sehingga
    // highlight dan caret tidak pernah meleset satu sama lain.
    setFindQuery(query, opts) {
      this.findQuery = query || '';
      this.findMatchCase = !!(opts && opts.matchCase);
      this.findMatches = [];
      this.findActiveIdx = -1;
      if (!this.findQuery) { this.renderAllPages(); return 0; }

      const needle = this.findMatchCase ? this.findQuery : this.findQuery.toLowerCase();
      for (let p = 0; p < this.pages.length; p++) {
        const lines = this.pages[p].lines || [];
        for (let l = 0; l < lines.length; l++) {
          const raw = lines[l].text || '';
          if (!raw) continue;
          const hay = this.findMatchCase ? raw : raw.toLowerCase();
          let from = 0;
          while (from <= hay.length - needle.length) {
            const at = hay.indexOf(needle, from);
            if (at === -1) break;
            this.findMatches.push({ pIdx: p, lIdx: l, start: at, len: needle.length });
            from = at + Math.max(1, needle.length); // hindari loop tak berujung bila needle ''
          }
        }
      }
      if (this.findMatches.length) this.findActiveIdx = 0;
      this.renderAllPages();
      return this.findMatches.length;
    }

    clearFind() {
      this.findQuery = '';
      this.findMatches = [];
      this.findActiveIdx = -1;
      this.renderAllPages();
    }

    findNext() {
      if (!this.findMatches.length) return -1;
      this.findActiveIdx = (this.findActiveIdx + 1) % this.findMatches.length;
      this._focusActiveMatch();
      return this.findActiveIdx;
    }

    findPrev() {
      if (!this.findMatches.length) return -1;
      this.findActiveIdx = (this.findActiveIdx - 1 + this.findMatches.length) % this.findMatches.length;
      this._focusActiveMatch();
      return this.findActiveIdx;
    }

    // Pindahkan kursor ke match aktif + gulir halaman pemuatnya ke tampilan.
    _focusActiveMatch() {
      const fm = this.findMatches[this.findActiveIdx];
      if (!fm) return;
      this.activePageIdx = fm.pIdx;
      this.activeLineIdx = fm.lIdx;
      this.cursorCharIdx = fm.start;
      this.isCaretVisible = true;
      this.renderAllPages();
      this.emitActiveLine();
      const el = document.getElementById(`kixPage${fm.pIdx + 1}`);
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    }

    replaceCurrent(replacement) {
      const fm = this.findMatches[this.findActiveIdx];
      if (!fm) return 0;
      const line = this.pages[fm.pIdx].lines[fm.lIdx];
      const text = line.text || '';
      line.text = text.slice(0, fm.start) + replacement + text.slice(fm.start + fm.len);
      // Ganti teks = hapus fm.len lalu sisip replacement.length. Offset tautan
      // di baris ini wajib ikut bergeser, kalau tidak tautan menunjuk karakter
      // yang salah setelah Find & Replace.
      this._shiftLinks(line, fm.start, -fm.len);
      this._shiftLinks(line, fm.start, replacement.length);
      const keepP = fm.pIdx, keepL = fm.lIdx, nextAt = fm.start + replacement.length;

      this.reflowPages(); // panjang teks berubah -> paginasi bisa bergeser
      const n = this.setFindQuery(this.findQuery, { matchCase: this.findMatchCase });
      if (n) {
        let idx = this.findMatches.findIndex(m => m.pIdx === keepP && m.lIdx === keepL && m.start >= nextAt);
        if (idx === -1) idx = 0;
        this.findActiveIdx = idx;
        this.renderAllPages();
      }
      this._afterReplace();
      return 1;
    }

    replaceAll(replacement) {
      if (!this.findMatches.length) return 0;

      // Kelompokkan per baris, lalu ganti dari BELAKANG tiap baris supaya offset
      // match lain tidak bergeser oleh penggantian sebelumnya.
      const groups = new Map();
      for (const m of this.findMatches) {
        const key = m.pIdx + ':' + m.lIdx;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m);
      }

      let count = 0;
      for (const [key, list] of groups) {
        const parts = key.split(':');
        const p = Number(parts[0]), l = Number(parts[1]);
        const line = this.pages[p] && this.pages[p].lines[l];
        if (!line) continue;
        let text = line.text || '';
        for (let i = list.length - 1; i >= 0; i--) {
          const m = list[i];
          text = text.slice(0, m.start) + replacement + text.slice(m.start + m.len);
          count++;
        }
        line.text = text;
      }

      this.reflowPages();
      this.setFindQuery(this.findQuery, { matchCase: this.findMatchCase });
      this._afterReplace();
      return count;
    }

    _afterReplace() {
      if (typeof this.onChange === 'function') this.onChange(this.getDocumentData());
    }

    // ==== HYPERLINK: MESIN ====
    // Tautan hidup sebagai rentang pada line.text: line.links = [{start,end,url}].
    // Tidak ada struktur segmen baru, jadi paginasi (reflowPages) TIDAK tersentuh.
    _linksOf(line) {
      if (!line) return [];
      if (!Array.isArray(line.links)) line.links = [];
      return line.links;
    }

    // Jaga offset tautan saat teks berubah (sisip/hapus). Tanpa ini tautan akan
    // menunjuk karakter yang salah setelah user mengetik di depannya.
    // at = indeks mutasi, delta = +n (sisip) / -n (hapus).
    _shiftLinks(line, at, delta) {
      const links = this._linksOf(line);
      if (!links.length || !delta) return;
      const out = [];
      for (const L of links) {
        let s = L.start, e = L.end;
        if (delta > 0) {
          if (at <= s) { s += delta; e += delta; }
          else if (at < e) { e += delta; }        // sisip di tengah tautan
        } else {
          const d = -delta;
          if (at + d <= s) { s -= d; e -= d; }
          else if (at < e) {                      // hapus beririsan
            const cutStart = Math.max(s, at);
            const cutEnd = Math.min(e, at + d);
            e -= (cutEnd - cutStart);
            if (at < s) s = at;
          }
        }
        if (e > s) out.push({ start: s, end: e, url: L.url });
      }
      if (out.length) line.links = out; else delete line.links;
    }

    // Hanya skema aman yang boleh disimpan/dibuka. Tanpa ini, URL
    // "javascript:..." yang ditempel user menjadi vektor eksekusi skrip
    // lewat window.open — bukan sekadar tampilan aneh.
    sanitizeUrl(url) {
      const raw = String(url == null ? '' : url).trim();
      if (!raw) return null;
      if (/^(javascript|data|vbscript|file):/i.test(raw)) return null;
      if (/^(https?|mailto|tel):/i.test(raw)) return raw;
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // skema asing ditolak
      return 'https://' + raw; // domain telanjang -> https
    }

    setLinkRange(pIdx, lIdx, start, end, url) {
      const page = this.pages[pIdx];
      const line = page && page.lines[lIdx];
      if (!line) return false;
      const safe = this.sanitizeUrl(url);
      if (!safe) return false;
      const len = (line.text || '').length;
      const s = Math.max(0, Math.min(start, len));
      const e = Math.max(0, Math.min(end, len));
      if (e <= s) return false;
      // Rentang baru MENIMPA bagian yang beririsan, tetapi sisa kiri/kanan
      // tautan lama DIPERTAHANKAN sebagai tautan terpisah (paritas Google Docs):
      // menautkan sebagian teks yang sudah bertaut tidak boleh menghapus tautan
      // di sisa kalimat. Versi sebelumnya membuang seluruh tautan lama.
      const kept = [];
      for (const L of this._linksOf(line)) {
        if (L.end <= s || L.start >= e) { kept.push(L); continue; }
        if (L.start < s) kept.push({ start: L.start, end: s, url: L.url });
        if (L.end > e) kept.push({ start: e, end: L.end, url: L.url });
      }
      const links = kept;
      links.push({ start: s, end: e, url: safe });
      links.sort((a, b) => a.start - b.start);
      line.links = links;
      this.renderAllPages();
      if (typeof this.onChange === 'function') this.onChange(this.getDocumentData());
      return true;
    }

    getLinkAt(pIdx, lIdx, charIdx) {
      const page = this.pages[pIdx];
      const line = page && page.lines[lIdx];
      if (!line) return null;
      return this._linksOf(line).find(L => charIdx >= L.start && charIdx < L.end) || null;
    }

    // Tautan yang sedang "dipegang" kursor — dipakai modal untuk prefill URL/teks
    // sekaligus memunculkan tombol "Hapus Tautan".
    //
    // Semantik KETAT (paritas Google Docs): tautan hanya dianggap aktif bila
    // kursor benar-benar berada di dalam atau menyentuh batasnya
    // (start <= at <= end, INKLUSIF di end). Versi lama punya fallback
    // "tautan mana pun di baris ini" (links[links.length-1]), sehingga kursor di
    // kata LAIN pada baris yang sama tetap membuka tautan lama: user yang hendak
    // menautkan kata baru malah disuguhi edit tautan yang tak dimaksud, lengkap
    // dengan tombol Hapus yang berbahaya.
    //
    // Prasyarat semantik ini adalah kursor yang presisi — klik kanvas kini
    // memetakan x -> offset lewat charIndexAtPoint(), bukan lagi selalu
    // menaruh kursor di akhir baris. Tanpa perbaikan itu, menghapus fallback
    // justru mematikan jalur edit tautan lewat Ctrl+K.
    getLinkNearCursor() {
      const line = this.activeLineRef();
      if (!line) return null;
      const links = this._linksOf(line);
      if (!links.length) return null;
      const text = line.text || '';
      const at = Math.max(0, Math.min(this.cursorCharIdx, text.length));
      return links.find(L => at >= L.start && at <= L.end) || null;
    }

    removeLinkRange(pIdx, lIdx, start, end) {
      const page = this.pages[pIdx];
      const line = page && page.lines[lIdx];
      if (!line || !Array.isArray(line.links)) return false;
      const before = line.links.length;
      line.links = line.links.filter(L => L.end <= start || L.start >= end);
      if (line.links.length === before) return false;
      if (!line.links.length) delete line.links;
      this.renderAllPages();
      if (typeof this.onChange === 'function') this.onChange(this.getDocumentData());
      return true;
    }

    // ==== KOMENTAR: MESIN ====
    // Komentar hidup sebagai rentang pada line.text: line.comments = [{id,start,end,...}].
    // Sama seperti tautan, TIDAK ada struktur segmen baru: reflowPages() tidak
    // tersentuh, dan karena getDocumentData() mengembalikan pages, komentar
    // otomatis ikut autosave + snapshot undo tanpa saluran persistensi tambahan.
    //
    // TIGA BEDA PENTING dari tautan (jangan salin literal):
    //  1. Accessor TIDAK lazy-init. _linksOf() menulis line.links = [] pada setiap
    //     baris yang disunting; kalau ditiru, tiap keystroke menambah noise
    //     "comments": [] ke payload simpan. Di sini accessor murni baca.
    //  2. Objek komentar punya metadata (id/author/text/replies). Saat offset
    //     bergeser objek WAJIB di-spread ({...C}), bukan direbuild seperti
    //     _shiftLinks yang hanya menyimpan {start,end,url}.
    //  3. Komentar boleh tumpang-tindih (dua orang menandai frasa yang sama),
    //     jadi addComment hanya push — tidak menimpa rentang beririsan.
    _commentsOf(line) {
      return (line && Array.isArray(line.comments)) ? line.comments : [];
    }

    _newCommentId() {
      // crypto.randomUUID tersedia di browser modern dan Node 22/24. Fallback
      // menjaga id tetap unik di lingkungan uji minimal.
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
          return 'c_' + crypto.randomUUID();
        }
      } catch (_) { /* jatuh ke fallback */ }
      return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    // Jaga offset komentar saat teks berubah. Logika geser identik _shiftLinks,
    // tetapi objek di-spread agar metadata percakapan tidak hilang.
    _shiftComments(line, at, delta) {
      const cs = line && line.comments;
      if (!Array.isArray(cs) || !cs.length || !delta) return;
      const out = [];
      for (const C of cs) {
        let s = C.start, e = C.end;
        if (delta > 0) {
          if (at <= s) { s += delta; e += delta; }
          else if (at < e) { e += delta; }        // sisip di tengah rentang
        } else {
          const d = -delta;
          if (at + d <= s) { s -= d; e -= d; }
          else if (at < e) {                      // hapus beririsan
            const cutStart = Math.max(s, at);
            const cutEnd = Math.min(e, at + d);
            e -= (cutEnd - cutStart);
            if (at < s) s = at;
          }
        }
        if (e > s) out.push({ ...C, start: s, end: e });
      }
      if (out.length) line.comments = out; else delete line.comments;
    }

    // Pecah komentar mengikuti titik potong baris (Enter / Ctrl+Enter).
    // Opsi A: thread TIDAK dibelah. Komentar yang melintasi titik potong tetap
    // di baris KIRI dengan rentang dipangkas (end = cut), karena percakapan yang
    // terbelah dua membingungkan pembaca. Rentang yang kolaps dibuang.
    _splitCommentsAt(line, cut) {
      const cs = line && line.comments;
      if (!Array.isArray(cs) || !cs.length) return null;
      const keep = [], move = [];
      for (const C of cs) {
        if (C.end <= cut) keep.push(C);
        else if (C.start >= cut) move.push({ ...C, start: C.start - cut, end: C.end - cut });
        else if (cut > C.start) keep.push({ ...C, end: cut });
      }
      return { keep, move };
    }

    addComment(pIdx, lIdx, start, end, text, author) {
      const page = this.pages[pIdx];
      const line = page && page.lines[lIdx];
      if (!line) return null;
      const body = String(text == null ? '' : text).trim();
      if (!body) return null;
      const len = (line.text || '').length;
      const s = Math.max(0, Math.min(start, len));
      const e = Math.max(0, Math.min(end, len));
      if (e <= s) return null;
      const C = {
        id: this._newCommentId(),
        start: s,
        end: e,
        author: String(author || 'Saya'),
        text: body,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: []
      };
      line.comments = this._commentsOf(line).concat([C]);
      this.renderAllPages();
      if (typeof this.onChange === 'function') this.onChange(this.getDocumentData());
      return C;
    }

    // Komentar pada kata di kursor. Kix belum punya API seleksi rentang (hanya
    // cursorCharIdx), jadi jangkar diambil dari wordRangeAtCursor() — persis
    // seperti applyLinkAtCursor().
    addCommentAtCursor(text, author) {
      const line = this.activeLineRef();
      if (!line) return null;
      const w = this.wordRangeAtCursor();
      if (!w) return null;
      return this.addComment(this.activePageIdx, this.activeLineIdx, w.start, w.end, text, author);
    }

    getCommentNearCursor() {
      const line = this.activeLineRef();
      if (!line) return null;
      const cs = this._commentsOf(line);
      if (!cs.length) return null;
      const at = Math.max(0, Math.min(this.cursorCharIdx, (line.text || '').length));
      return cs.find(C => at >= C.start && at <= C.end) || null;
    }

    findComment(id) {
      for (let p = 0; p < this.pages.length; p++) {
        const lines = this.pages[p].lines || [];
        for (let l = 0; l < lines.length; l++) {
          const hit = this._commentsOf(lines[l]).find(C => C.id === id);
          if (hit) return { comment: hit, pIdx: p, lIdx: l };
        }
      }
      return null;
    }

    removeComment(id) {
      let removed = false;
      for (const page of this.pages) {
        for (const line of (page.lines || [])) {
          if (!Array.isArray(line.comments) || !line.comments.length) continue;
          const next = line.comments.filter(C => C.id !== id);
          if (next.length === line.comments.length) continue;
          removed = true;
          if (next.length) line.comments = next; else delete line.comments;
        }
      }
      if (!removed) return false;
      this.renderAllPages();
      if (typeof this.onChange === 'function') this.onChange(this.getDocumentData());
      return true;
    }

    resolveComment(id, resolved) {
      const hit = this.findComment(id);
      if (!hit) return false;
      hit.comment.resolved = (resolved === undefined) ? !hit.comment.resolved : !!resolved;
      this.renderAllPages();
      if (typeof this.onChange === 'function') this.onChange(this.getDocumentData());
      return true;
    }

    addReply(id, text, author) {
      const hit = this.findComment(id);
      if (!hit) return false;
      const body = String(text == null ? '' : text).trim();
      if (!body) return false;
      if (!Array.isArray(hit.comment.replies)) hit.comment.replies = [];
      hit.comment.replies.push({
        author: String(author || 'Saya'),
        text: body,
        createdAt: new Date().toISOString()
      });
      this.renderAllPages();
      if (typeof this.onChange === 'function') this.onChange(this.getDocumentData());
      return true;
    }

    // Posisi (pIdx/lIdx) SENGAJA dihitung segar tiap panggilan: reflowPages()
    // memindahkan objek line antar-halaman, jadi posisi ter-cache pasti basi.
    getAllComments() {
      const out = [];
      for (let p = 0; p < this.pages.length; p++) {
        const lines = this.pages[p].lines || [];
        for (let l = 0; l < lines.length; l++) {
          for (const C of this._commentsOf(lines[l])) {
            out.push({ comment: C, pIdx: p, lIdx: l });
          }
        }
      }
      return out;
    }

    // Kata di sekitar kursor. Kix BELUM punya API seleksi rentang (hanya
    // cursorCharIdx), jadi ini cara jujur menentukan teks yang akan ditautkan.
    wordRangeAtCursor() {
      const line = this.activeLineRef();
      if (!line) return null;
      const t = line.text || '';
      if (!t) return null;
      let i = Math.min(this.cursorCharIdx, t.length);
      const isWord = (ch) => ch !== undefined && !/\s/.test(ch);
      if (i > 0 && !isWord(t[i]) && isWord(t[i - 1])) i -= 1;
      if (!isWord(t[i])) { while (i < t.length && !isWord(t[i])) i++; }
      if (!isWord(t[i])) return null;
      let s = i, e = i;
      while (s > 0 && isWord(t[s - 1])) s--;
      while (e < t.length && isWord(t[e])) e++;
      return { start: s, end: e, text: t.slice(s, e) };
    }

    applyLinkAtCursor(url, text) {
      const line = this.activeLineRef();
      if (!line || !url) return false;
      const w = this.wordRangeAtCursor();
      const t = (text === undefined || text === null || text === '') ? null : String(text);
      if (w) {
        let s = w.start, e = w.end;
        if (t !== null && t !== line.text.slice(s, e)) {
          const oldLen = e - s;
          line.text = line.text.slice(0, s) + t + line.text.slice(e);
          this._shiftLinks(line, e, t.length - oldLen);
          e = s + t.length;
          this.cursorCharIdx = e;
        }
        return this.setLinkRange(this.activePageIdx, this.activeLineIdx, s, e, url);
      }
      // Tak ada kata di kursor: sisipkan teks baru yang langsung bertautan.
      const ins = t !== null ? t : String(url);
      const at = this.cursorCharIdx;
      line.text = line.text.slice(0, at) + ins + line.text.slice(at);
      this._shiftLinks(line, at, ins.length);
      this.cursorCharIdx = at + ins.length;
      return this.setLinkRange(this.activePageIdx, this.activeLineIdx, at, at + ins.length, url);
    }

    // Komentar boleh tumpang-tindih (dua orang menandai frasa yang sama), jadi
    // bila beberapa kotak kena, ambil yang TERKECIL: itulah anotasi paling
    // spesifik di titik klik, bukan kotak besar yang menutupi seluruh baris.
    commentBoxAt(pIdx, x, y) {
      let best = null;
      for (const b of this._commentBoxes) {
        if (b.pIdx !== pIdx) continue;
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
          if (!best || (b.w * b.h) < (best.w * best.h)) best = b;
        }
      }
      return best;
    }

    linkBoxAt(pIdx, x, y) {
      for (const b of this._linkBoxes) {
        if (b.pIdx !== pIdx) continue;
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
      }
      return null;
    }

    exportPlainText() {
      return this.pages
        .map(p => p.lines.map(l => l.text || '').join('\n'))
        .join('\n\n---- Halaman Baru ----\n\n');
    }

    calculateWordCount() {
      let count = 0;
      for (const p of this.pages) {
        for (const l of p.lines) {
          if (l.text) {
            const words = l.text.trim().split(/\s+/).filter(Boolean);
            count += words.length;
          }
        }
      }
      return count;
    }

    // ==== PAGINASI DINAMIS ====
    // Memindahkan baris yang meluber keluar batas bawah halaman ke halaman
    // berikutnya. Halaman TIDAK pernah digabung, sehingga pemisah halaman
    // yang disengaja pengarang tetap dipertahankan.
    reflowPages() {
      const activeLine = this.pages[this.activePageIdx]?.lines[this.activeLineIdx];
      const measCanvas = document.createElement('canvas');
      measCanvas.width = this.pageWidth();
      measCanvas.height = this.pageHeight();

      const out = [];
      const yStart = this.textTop();
      const yLimit = this.maxTextY();
      for (const page of this.pages) {
        let cur = { pageNumber: out.length + 1, lines: [] };
        let y = yStart;
        for (let lIdx = 0; lIdx < page.lines.length; lIdx++) {
          // Tinggi baris memakai sumber kebenaran yang SAMA dengan renderPage(),
          // sehingga paginasi tidak pernah melenceng dari yang terlihat user.
          const m = this.measureLine(page, lIdx, measCanvas);
          if (y + m.height > yLimit && cur.lines.length > 0) {
            out.push(cur);
            cur = { pageNumber: out.length + 1, lines: [] };
            y = yStart;
          }
          cur.lines.push(m.line);
          y += m.height;
        }
        out.push(cur);
      }
      this.pages = out;

      // Kembalikan posisi kursor dengan melacak identitas objek baris.
      if (activeLine) {
        for (let p = 0; p < this.pages.length; p++) {
          const li = this.pages[p].lines.indexOf(activeLine);
          if (li !== -1) {
            this.activePageIdx = p;
            this.activeLineIdx = li;
            break;
          }
        }
      }
    }

    // ==== JENDELA RENDER (VIRTUALISASI TILE) ====
    // Paritas .kix-rotatingtilemanager milik Google Docs: hanya tile di
    // sekitar viewport yang DIRASTERISASI. Tile DOM tetap dibuat untuk
    // SEMUA halaman, sehingga indeks halaman, hit-test, clampPoint, dan
    // scrollIntoView tidak berubah - yang dihemat murni paint kanvas.
    //
    // Gerbang tileVirtualizeMin (default 3) membuat dokumen pendek
    // berperilaku 100% identik dengan sebelum perubahan ini.
    updateRenderWindow(force, probeIdx) {
      const total = this.pages.length;
      if (!(total > this.tileVirtualizeMin)) {
        for (let i = 0; i < total; i++) {
          if (force || !this._dirtyPages.has(i)) {
            this.renderPage(i);
            this._dirtyPages.add(i);
          }
        }
        this._renderWindow = { lo: 0, hi: Math.max(0, total - 1) };
        return total;
      }
      const center = Math.max(0, Math.min(total - 1,
        (probeIdx === undefined || probeIdx === null) ? this.activePageIdx : probeIdx));
      const span = Math.max(0, Number(this.tileWindowSpan) || 0);
      const lo = Math.max(0, center - span);
      const hi = Math.min(total - 1, center + span);
      let painted = 0;
      for (let i = lo; i <= hi; i++) {
        if (force || !this._dirtyPages.has(i)) {
          this.renderPage(i);
          this._dirtyPages.add(i);
          painted++;
        }
      }
      this._renderWindow = { lo: lo, hi: hi };
      return painted;
    }

    // Cat SEMUA halaman tanpa memedulikan jendela render.
    // WAJIB dipakai jalur Cetak/PDF: printOrExportPdf merasterisasi tiap
    // kanvas lewat toDataURL, sehingga halaman yang belum dicat akan
    // tercetak sebagai halaman KOSONG.
    renderAllForce() {
      this._forceAll = true;
      try {
        for (let i = 0; i < this.pages.length; i++) {
          this.renderPage(i);
          this._dirtyPages.add(i);
        }
      } finally {
        this._forceAll = false;
      }
      this._renderWindow = { lo: 0, hi: Math.max(0, this.pages.length - 1) };
      return this.pages.length;
    }

    renderAllPages() {
      const container = this.scrollBox;

      // Kotak hit-test tautan dibangun ulang tiap render; kalau tidak direset,
      // kotak lama menumpuk dan klik bisa mendarat di tautan yang sudah pindah.
      this._linkBoxes = [];

      // Rebuild kanvas tile sepenuhnya (querySelectorAll = NodeList statis,
      // TIDAK boleh dipakai sebagai kondisi while karena panjangnya tetap)
      container.innerHTML = '';
      for (let i = 0; i < this.pages.length; i++) {
        const pageDiv = document.createElement('div');
        pageDiv.className = 'kix-page kix-page-paginated';
        // Kotak tile ikut ukuran kertas aktif; tanpa ini kanvas A4 (794px)
        // meluber keluar content box 636px milik .kix-page.
        if (pageDiv.style) {
          pageDiv.style.width = (this.pageWidth() + PAGE_PAD_X * 2) + 'px';
          pageDiv.style.minHeight = (this.pageHeight() + PAGE_PAD_Y * 2) + 'px';
        }
        pageDiv.id = `kixPage${i + 1}`;
        pageDiv.setAttribute('data-page-index', i.toString());
        pageDiv.innerHTML = `
          <div class="kix-page-header">Halaman ${i + 1}</div>
          <canvas class="kix-canvas-tile-content" id="kixCanvas${i + 1}" data-page="${i}" width="${this.pageWidth()}" height="${this.pageHeight()}"></canvas>
        `;
        container.appendChild(pageDiv);
      }

      // Kanvas baru dibuat kosong oleh rebuild DOM di atas, jadi penanda
      // 'sudah dicat' lama tidak berlaku lagi dan harus direset.
      this._dirtyPages = new Set();
      const totalPages = this.pages.length;
      const virtual = totalPages > this.tileVirtualizeMin;
      // Kelas & atribut paritas .kix-rotatingtilemanager (bisa dibuktikan tes).
      if (container.classList && typeof container.classList.toggle === 'function') {
        container.classList.toggle('kix-rotatingtilemanager', virtual);
      }
      if (typeof container.setAttribute === 'function') {
        container.setAttribute('data-virtualized', virtual ? '1' : '0');
      }
      if (virtual && !this._forceAll) {
        this.updateRenderWindow(false, this.activePageIdx);
      } else {
        for (let i = 0; i < totalPages; i++) {
          this.renderPage(i);
          this._dirtyPages.add(i);
        }
        this._renderWindow = { lo: 0, hi: Math.max(0, totalPages - 1) };
      }

      if (typeof this.onPageChange === 'function') {
        this.onPageChange(this.activePageIdx + 1, this.pages.length, this.calculateWordCount());
      }
    }

    // Word-wrap ala Google Docs: pecah teks menjadi segmen yang muat dalam margin.
    // Mengembalikan array { text, start } — `start` = offset char di teks asli,
    // dipakai untuk menempatkan caret pada segmen yang benar.
    wrapSegmentsFor(canvas, text, fontSize, bold, italic, fontFamily, extraLeft, runs, prefixLen) {
      const ctx = canvas.getContext('2d');
      let style = '';
      if (italic) style += 'italic ';
      if (bold) style += 'bold ';
      const baseFont = `${style}${fontSize}px ${fontFamily || 'Arial'}, sans-serif`;
      ctx.font = baseFont;
      // Lebar area teks memakai MARGIN AKTIF (bukan angka 60 hardcoded), supaya
      // penyiapan halaman benar-benar mengubah titik wrap.
      // viewW() (px logis), BUKAN canvas.width (yang sudah dikali dpr). Kalau
      // memakai canvas.width, di layar HiDPI area teks akan dianggap 2x lebih
      // lebar dan wrap tidak pernah terpicu.
      const maxWidth = this.viewW() - this.marginLeft() - this.marginRight() - (extraLeft || 0);
      if (!text) return [{ text: '', start: 0 }];

      // ==== JALUR RUN-AWARE (hanya aktif bila baris punya runs) ====
      // Google Docs mengukur lebar per-run, bukan per-baris. Bila sebuah baris
      // memuat kata tebal di tengah kalimat, lebar glyph-nya berbeda sehingga
      // titik wrap bisa bergeser. Tanpa jalur ini, teks run yang lebih lebar
      // akan meluber melewati margin kanan.
      // Jalur lama (tanpa runs) TETAP dipakai apa adanya di bawah agar seluruh
      // dokumen lama menghasilkan paginasi yang identik byte-per-byte.
      const useRuns = Array.isArray(runs) && runs.length > 0;
      let cum = null;
      if (useRuns) {
        cum = this.runsCumWidths(canvas, text, prefixLen || 0, runs, baseFont);
        ctx.font = baseFont;
      }
      const widthOf = (a, b) => {
        if (cum) return cum[b] - cum[a];
        return ctx.measureText(text.slice(a, b)).width;
      };

      const tokens = text.split(/(?<=\s)/);
      const segs = [];
      let cur = '', curStart = 0, pos = 0;
      for (const tok of tokens) {
        if (cur !== '' && widthOf(curStart, pos + tok.length) > maxWidth) {
          segs.push({ text: cur, start: curStart });
          curStart = pos;
          cur = tok;
        } else {
          cur += tok;
        }
        pos += tok.length;
      }
      if (cur !== '') segs.push({ text: cur, start: curStart });
      return segs.length ? segs : [{ text: '', start: 0 }];
    }

    // Lebar kumulatif tiap batas karakter pada teks (prefix + isi baris).
    // Setiap karakter diukur dengan font RUN yang menaunginya, sehingga hasil
    // wrap dan hit-test sama-sama memakai metrik yang benar untuk teks campuran.
    runsCumWidths(canvas, fullText, prefixLen, runs, baseFont) {
      const ctx = canvas.getContext('2d');
      const n = fullText.length;
      const cum = new Array(n + 1).fill(0);
      // Peta batas offset absolut tiap run di dalam `fullText`.
      const bounds = [];
      let p = prefixLen;
      for (const r of runs) {
        const len = (r.text || '').length;
        bounds.push({ start: p, end: p + len, run: r });
        p += len;
      }
      const fontFor = (idx) => {
        for (const b of bounds) {
          if (idx >= b.start && idx < b.end) {
            const r = b.run;
            let st = '';
            if (r.italic) st += 'italic ';
            if (r.bold) st += 'bold ';
            return `${st}${r.size || 13}px ${r.fontFamily || 'Arial'}, sans-serif`;
          }
        }
        return baseFont;
      };
      let acc = 0, curFont = null;
      for (let i = 0; i < n; i++) {
        const f = fontFor(i);
        if (f !== curFont) { ctx.font = f; curFont = f; }
        acc += ctx.measureText(fullText[i]).width;
        cum[i + 1] = acc;
      }
      return cum;
    }

    // Irisan runs terhadap SATU segmen hasil word-wrap.
    // `seg.start` memuat offset prefix, jadi dikurangi dulu agar jatuh di
    // koordinat line.text. Tanpa pengurangan ini, seluruh run akan tergambar
    // bergeser sepanjang penanda butir.
    segRunsFor(line, seg, prefixLen) {
      if (!Array.isArray(line.runs) || !line.runs.length) return null;
      const segStart = seg.start - prefixLen;
      const segEnd = segStart + seg.text.length;
      const out = [];
      let pos = 0;
      for (const r of line.runs) {
        const rStart = pos;
        const rEnd = pos + (r.text || '').length;
        pos = rEnd;
        const a = Math.max(rStart, segStart);
        const b = Math.min(rEnd, segEnd);
        if (b <= a) continue;
        out.push({ run: r, text: r.text.slice(a - rStart, b - rStart) });
      }
      return out;
    }

    // ==== METRIK BARIS (satu sumber kebenaran) ====
    // Geometri BARIS mana pun (bukan hanya baris ceklis) — dipakai pengujian
    // untuk mengklik baris tertentu secara tepat, tanpa angka ajaib.
    // ==== SATU SUMBER KEBENARAN TINGGI BARIS ====
    // Sebelum ini ada DUA rumus yang tidak pernah bertemu: renderPage memakai
    // measureLine().height (variabel per fontSize/spacing), sedangkan hit-test
    // klik dan lineRectAt memakai konstanta LINE_HEIGHT=24. Akibatnya pita klik
    // bergeser dari glyph: terukur sampai -46px (~2 baris) pada dokumen
    // ber-heading, sehingga klik di bagian atas huruf memilih baris sebelumnya.
    //
    // `tops` berisi n+1 nilai: tops[i] = y puncak baris i, tops[n] = batas bawah.
    // Dihitung dengan measureLine yang SAMA dengan renderPage, jadi paritas
    // gambar-vs-klik menjadi by construction, bukan hasil penyelarasan manual.
    //
    // SENGAJA TIDAK DI-CACHE. Cache yang tidak di-invalidasi saat fontSize atau
    // spacing berubah akan mereproduksi bug kelas yang sama (angka basi yang
    // dipakai hit-test). Biayanya satu measureLine per baris, hanya saat klik.
    _lineTops(pIdx) {
      const page = this.pages[pIdx];
      const top = this.textTop();
      if (!page || !page.lines) return [top, top];
      const canvas = document.getElementById(`kixCanvas${pIdx + 1}`);
      const tops = [top];
      let y = top;
      for (let i = 0; i < page.lines.length; i++) {
        y += this.measureLine(page, i, canvas).height;
        tops.push(y);
      }
      return tops;
    }

    // Y kanvas -> indeks baris. Binary search (satu halaman bisa ratusan baris).
    lineIndexAtY(pIdx, y) {
      const page = this.pages[pIdx];
      const n = (page && page.lines) ? page.lines.length : 0;
      if (n === 0) return 0;
      const tops = this._lineTops(pIdx);
      if (y <= tops[0]) return 0;
      if (y >= tops[n]) return n - 1;
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (tops[mid] <= y) lo = mid; else hi = mid - 1;
      }
      return lo;
    }

    lineRectAt(pIdx, lIdx) {
      const tops = this._lineTops(pIdx);
      const n = Math.max(0, tops.length - 1);
      const i = Math.max(0, Math.min(n - 1, lIdx));
      const top = tops[i];
      const bottom = tops[i + 1];
      return { top, height: bottom - top, centerY: (top + bottom) / 2 };
    }

    // Peta koordinat-x kanvas -> offset karakter di line.text.
    // Kix tidak punya API seleksi, dan dulu klik SELALU menaruh kursor di AKHIR
    // baris (cursorCharIdx = text.length). Akibatnya Ctrl+K hanya bisa
    // "menggenggam" kata terakhir, dan tautan di tengah baris tak pernah bisa
    // disunting. Geometri di sini memakai rumus yang SAMA dengan renderPage()
    // (MARGIN + indent, segmen hasil wrapSegmentsFor, align center/right),
    // sehingga kursor mendarat tepat di huruf yang diklik.
    charIndexAtPoint(pIdx, lIdx, x) {
      const page = this.pages[pIdx];
      const line = page && page.lines[lIdx];
      if (!line) return 0;
      const text = line.text || '';
      const canvas = document.getElementById(`kixCanvas${pIdx + 1}`);
      if (!canvas) return text.length;
      const m = this.measureLine(page, lIdx, canvas);
      const fontSize = line.size || 13;
      const fontFamily = line.fontFamily || 'Arial';
      const ctx = canvas.getContext('2d');
      let style = '';
      if (line.italic) style += 'italic ';
      if (line.bold) style += 'bold ';
      ctx.font = `${style}${fontSize}px ${fontFamily}, sans-serif`;
      const baseX = this.marginLeft() + m.indent;
      const prefixLen = m.prefix.length;
      for (const seg of m.segs) {
        const tw = ctx.measureText(seg.text).width;
        let segX = baseX;
        if (line.align === 'center') {
          const availW = this.viewW() - this.marginLeft() - this.marginRight();
          segX = this.marginLeft() + Math.max(0, (availW - tw) / 2);
        } else if (line.align === 'right') {
          segX = Math.max(this.marginLeft(), this.viewW() - this.marginRight() - tw);
        }
        // Di kiri segmen ini: offset paling awal yang mungkin pada segmen itu.
        if (x < segX) return Math.max(0, seg.start - prefixLen);
        if (x <= segX + tw) {
          const local = x - segX;
          // Cari batas karakter TERDEKAT (bukan selalu karakter sebelumnya),
          // supaya klik di paruh kanan sebuah huruf mendarat setelah huruf itu.
          let best = 0, bestDiff = Infinity, acc = 0;
          for (let i = 0; i <= seg.text.length; i++) {
            const d = Math.abs(acc - local);
            if (d < bestDiff) { bestDiff = d; best = i; }
            if (i < seg.text.length) acc += ctx.measureText(seg.text[i]).width;
          }
          return Math.max(0, Math.min(text.length, seg.start + best - prefixLen));
        }
      }
      return text.length;
    }

    // Geometri kotak centang (koordinat canvas). Satu sumber kebenaran yang
    // dipakai BAIK oleh hit-test klik di bawah maupun oleh pengujian otomatis,
    // supaya tidak ada angka ajaib yang meleset bila tata letak baris berubah.
    checklistBoxRect(pIdx, lIdx) {
      const line = this.pages[pIdx] && this.pages[pIdx].lines[lIdx];
      if (!line || line.listType !== 'checklist') return null;
      const boxLeft = this.marginLeft() + this.indentFor(line);
      const row = this.lineRectAt(pIdx, lIdx);
      return { left: boxLeft - 5, top: row.top, width: 25, height: row.height, centerX: boxLeft + 7, centerY: row.centerY };
    }

    // Penanda butir daftar: "• " bullet, "1. " bernomor, "☐ "/"☑ " ceklis.
    listPrefixFor(page, lIdx) {
      const line = page.lines[lIdx];
      if (!line || !line.listType) return '';
      // Penanda BUTIR menyesuaikan level indentasi (paritas sub-bullet Slides/Docs):
      // level 0 = •, level 1 = ○, level 2+ = ■. Aksara ini yang benar-benar
      // digambar ke kanvas, jadi indentasi terlihat sebagai daftar bertingkat.
      if (line.listType === 'bullet') {
        const lvl = line.indent || 0;
        return (lvl >= 2 ? '■ ' : (lvl === 1 ? '○ ' : '• '));
      }
      if (line.listType === 'checklist') return (line.checked ? '☑ ' : '☐ ');
      let n = 1;
      for (let i = lIdx - 1; i >= 0; i--) {
        const p = page.lines[i];
        if (!p.listType || p.listType !== 'numbered') break;
        n++;
      }
      return `${n}. `;
    }

    indentFor(line) {
      return (line && line.indent ? line.indent : 0) * 24;
    }

    // Dipakai BERSAMA oleh reflowPages() (paginasi) dan renderPage() (gambar).
    // Kalau keduanya menghitung tinggi sendiri-sendiri, halaman akan "melompat"
    // antara hasil paginasi dan hasil gambar.
    measureLine(page, lIdx, canvas) {
      const line = page.lines[lIdx] || { text: '' };
      // ==== BARIS GAMBAR DIUKUR SEBAGAI SATU BLOK ====
      // Tanpa cabang ini, baris gambar diukur sebagai teks kosong (~20px)
      // sehingga paginasi menaruh paragraf berikutnya DI ATAS gambar.
      if (line.type === 'image') {
        const szI = this.imageSize(line);
        const prevI = lIdx > 0 ? page.lines[lIdx - 1] : null;
        const gapI = lIdx === 0 ? 0 : ((line.heading || (prevI && prevI.heading)) ? 12 : 4);
        return {
          line, segs: [{ text: '', start: 0 }], indent: 0, prefix: '',
          base: szI.height, paragraphGap: gapI, height: szI.height + gapI
        };
      }
      // ==== BARIS TABEL DIUKUR SEBAGAI SATU BLOK ====
      // Kalau tabel diukur sebagai baris teks biasa, paginasi akan memotong
      // tabel di tengah dan sel-selnya bertumpuk dengan paragraf berikutnya.
      if (line.type === 'table') {
        const hT = this.tableHeight(line);
        const prevT = lIdx > 0 ? page.lines[lIdx - 1] : null;
        const gapT = lIdx === 0 ? 0 : ((line.heading || (prevT && prevT.heading)) ? 12 : 4);
        return {
          line, segs: [{ text: '', start: 0 }], indent: 0, prefix: '',
          base: hT, paragraphGap: gapT, height: hT + gapT
        };
      }
      const fontSize = line.size || 13;
      const indent = this.indentFor(line);
      const prefix = this.listPrefixFor(page, lIdx);
      const segs = this.wrapSegmentsFor(
        canvas, prefix + (line.text || ''), fontSize,
        line.bold, line.italic, line.fontFamily, indent,
        line.runs, prefix.length
      );
      const base = Math.round(fontSize * 1.5 * (line.spacing || 1));
      const prev = lIdx > 0 ? page.lines[lIdx - 1] : null;
      const gap = lIdx === 0 ? 0 : ((line.heading || (prev && prev.heading)) ? 12 : 4);
      return { line, segs, indent, prefix, base, paragraphGap: gap, height: segs.length * base + gap };
    }

    // ==== GAMBAR INLINE (paritas Google Docs: Sisipkan > Gambar) ====
    // Gambar disimpan sebagai BARIS KHUSUS (line.type === 'image') sehingga
    // otomatis ikut paginasi, snapshot undo, dan autosave — tanpa saluran
    // persistensi baru. Bentuk: line.image = { src, width, height, align }
    imageSize(line) {
      const im = line && line.image;
      if (!im) return { width: 0, height: 0 };
      const maxW = this.pageWidth() - this.marginLeft() - this.marginRight();
      const w = Math.max(8, Math.min(maxW, Number(im.width) || 200));
      // Rasio aspek: bila hanya satu sisi diberikan, sisi lain diturunkan dari
      // gambar asli supaya gambar tidak gepeng.
      const cached = this._imageCache.get(im.src);
      let h = Number(im.height) || 0;
      if (!h) {
        if (cached && cached.naturalWidth) h = w * (cached.naturalHeight / cached.naturalWidth);
        else h = Math.round(w * 0.6);
      }
      return { width: w, height: Math.max(8, Math.round(h)) };
    }

    // Pastikan HTMLImageElement untuk `src` ada di cache. Di lingkungan tanpa
    // Image (mis. harness Node) fungsi ini mengembalikan null dan render jatuh
    // ke placeholder — TIDAK melempar, supaya unit test tidak pecah.
    _ensureImage(src) {
      if (!src) return null;
      if (this._imageCache.has(src)) return this._imageCache.get(src);
      const ImgCtor = (typeof window !== 'undefined' && window.Image) ? window.Image : null;
      if (!ImgCtor) { this._imageCache.set(src, null); return null; }
      let img = null;
      try {
        img = new ImgCtor();
        img.onload = () => {
          // Muat selesai: gambar ulang supaya placeholder berganti isi asli.
          this._imageCache.set(src, img);
          this.renderAllPages();
        };
        img.onerror = () => { this._imageCache.set(src, null); };
        img.src = src;
      } catch (_) {
        this._imageCache.set(src, null);
        return null;
      }
      this._imageCache.set(src, img);
      return img;
    }

    insertImage(src, opts) {
      if (!src || typeof src !== 'string') return false;
      const o = opts || {};
      const line = {
        type: 'image',
        text: '',
        image: {
          src: src,
          width: o.width || 240,
          height: o.height || 0,
          align: o.align || 'left'
        }
      };
      const page = this.pages[this.activePageIdx];
      if (!page) return false;
      const at = Math.min(page.lines.length, this.activeLineIdx + 1);
      page.lines.splice(at, 0, line);
      this.activeLineIdx = at;
      this.activeCell = null;
      this._ensureImage(src);
      this.reflowPages();
      this.renderAllPages();
      this.emitActiveLine();
      this.notifyChange();
      return true;
    }

    // Ubah ukuran gambar aktif (proporsi terjaga bila `height` tidak diberikan).
    resizeActiveImage(width, height) {
      const page = this.pages[this.activePageIdx];
      const line = page && page.lines[this.activeLineIdx];
      if (!line || line.type !== 'image' || !line.image) return false;
      const maxW = this.pageWidth() - this.marginLeft() - this.marginRight();
      line.image.width = Math.max(8, Math.min(maxW, Number(width) || line.image.width));
      if (height !== undefined && height !== null) {
        line.image.height = Math.max(8, Number(height) || line.image.height);
      } else {
        const sz = this.imageSize(line);
        line.image.height = sz.height;
      }
      this.reflowPages();
      this.renderAllPages();
      this.notifyChange();
      return true;
    }

    setActiveImageAlign(align) {
      const page = this.pages[this.activePageIdx];
      const line = page && page.lines[this.activeLineIdx];
      if (!line || line.type !== 'image' || !line.image) return false;
      line.image.align = (align === 'center' || align === 'right') ? align : 'left';
      this.renderAllPages();
      this.notifyChange();
      return true;
    }

    imageAt(pIdx, x, y) {
      for (const b of this._imageBoxes) {
        if (b.pIdx !== pIdx) continue;
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
      }
      return null;
    }

    // ==== KEYBOARD DI DALAM SEL TABEL ====
    // Mengembalikan true bila tombol SUDAH ditangani di sini (handleKey harus
    // berhenti), false bila tombol harus jatuh ke jalur teks biasa.
    // Kontrak paritas Docs: Tab = sel berikutnya, Shift+Tab = sebelumnya,
    // Enter = baris berikutnya, dan mengetik langsung masuk ke sel.
    _handleTableKey(e, line) {
      const cell = this._cell();
      if (!cell) return false;
      const t = line.table;
      const nC = (t.rows[0] || []).length;
      const text = cell.text || '';
      let caret = Math.max(0, Math.min(text.length, this.cellCaret || 0));
      const commit = () => {
        this.reflowPages();
        this.renderAllPages();
        this.emitActiveLine();
        this.notifyChange();
      };

      if (e.key === 'Tab') {
        e.preventDefault();
        this.moveCell(0, e.shiftKey ? -1 : 1);
        return true;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        // Enter di sel = pindah ke baris sel berikutnya (paritas Docs).
        this.moveCell(1, 0);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.activeCell = null;
        this.renderAllPages();
        this.emitActiveLine();
        return true;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        if (caret > 0) {
          cell.text = text.slice(0, caret - 1) + text.slice(caret);
          this.cellCaret = caret - 1;
          commit();
        }
        return true;
      }
      if (e.key === 'Delete') {
        e.preventDefault();
        if (caret < text.length) {
          cell.text = text.slice(0, caret) + text.slice(caret + 1);
          commit();
        }
        return true;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (caret > 0) this.cellCaret = caret - 1;
        else if (this.activeCell.c > 0) { this.moveCell(0, -1); this.cellCaret = 1e9; }
        this.renderAllPages();
        return true;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (caret < text.length) this.cellCaret = caret + 1;
        else if (this.activeCell.c < nC - 1) { this.moveCell(0, 1); this.cellCaret = 0; }
        this.renderAllPages();
        return true;
      }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.moveCell(-1, 0); this.cellCaret = Math.min(this.cellCaret || 0, 1e9); return true; }
      if (e.key === 'ArrowDown') { e.preventDefault(); this.moveCell(1, 0); this.cellCaret = Math.min(this.cellCaret || 0, 1e9); return true; }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        cell.text = text.slice(0, caret) + e.key + text.slice(caret);
        this.cellCaret = caret + 1;
        commit();
        return true;
      }
      return false;
    }

    // ==== RENDER GAMBAR ====
    // Menggambar gambar asli bila sudah termuat; bila belum/gagal, menggambar
    // PLACEHOLDER bergaris tepi. Placeholder wajib ada supaya tata letak tidak
    // melompat dan user tetap melihat ada objek di posisi itu.
    _renderImage(ctx, pIdx, lIdx, line, yTop) {
      const sz = this.imageSize(line);
      const im = line.image || {};
      const mL = this.marginLeft(), mR = this.marginRight();
      let x = mL;
      if (im.align === 'center') x = Math.max(mL, (this.pageWidth() - sz.width) / 2);
      else if (im.align === 'right') x = Math.max(mL, this.pageWidth() - mR - sz.width);

      ctx.save();
      const img = this._ensureImage(im.src);
      // `complete` bisa undefined pada stub; anggap termuat hanya bila
      // naturalWidth > 0 supaya stub Node tidak memicu drawImage yang melempar.
      const loaded = !!(img && img.naturalWidth > 0);
      if (loaded) {
        try {
          ctx.drawImage(img, x, yTop, sz.width, sz.height);
        } catch (_) {
          ctx.fillStyle = '#f1f3f4';
          ctx.fillRect(x, yTop, sz.width, sz.height);
        }
      } else {
        ctx.fillStyle = '#f1f3f4';
        ctx.fillRect(x, yTop, sz.width, sz.height);
        ctx.strokeStyle = '#dadce0';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, yTop, sz.width, sz.height);
        ctx.fillStyle = '#5f6368';
        ctx.font = '12px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Gambar', x + sz.width / 2, yTop + sz.height / 2 + 4);
        ctx.textAlign = 'left';
      }
      // Penanda objek terpilih (baris gambar aktif).
      if (this.activePageIdx === pIdx && this.activeLineIdx === lIdx) {
        ctx.strokeStyle = '#1a73e8';
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 1, yTop - 1, sz.width + 2, sz.height + 2);
      }
      ctx.restore();

      this._imageBoxes.push({
        pIdx, lIdx, src: im.src,
        x, y: yTop, w: sz.width, h: sz.height
      });
    }

    // ==== RENDER TABEL ====
    // Menggambar grid + isi sel, dan MEREKAM kotak tiap sel untuk hit-test klik.
    // Sel yang sedang disunting diberi penanda biru (paritas Docs).
    _renderTable(ctx, pIdx, lIdx, line, yTop) {
      const t = line.table;
      if (!t || !Array.isArray(t.rows) || !t.rows.length) return;
      const widths = this.tableColWidths(line);
      const rh = this.tableRowHeight(line);
      const nR = t.rows.length;
      const nC = (t.rows[0] || []).length;

      ctx.save();
      // Latar putih: tabel harus menutupi apa pun di belakangnya.
      const totalW = widths.reduce((a, b) => a + b, 0);
      const tmL = this.marginLeft();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(tmL, yTop, totalW, nR * rh);

      for (let r = 0; r < nR; r++) {
        for (let c = 0; c < nC; c++) {
          const cell = t.rows[r][c] || { text: '' };
          let x = tmL;
          for (let i = 0; i < c; i++) x += widths[i];
          const cy = yTop + r * rh;

          // Sorotan sel aktif (hanya bila baris ini yang sedang disunting).
          const isActive = this.activeCell && this.activePageIdx === pIdx &&
                           this.activeLineIdx === lIdx &&
                           this.activeCell.r === r && this.activeCell.c === c;
          if (isActive) {
            ctx.fillStyle = 'rgba(66,133,244,0.10)';
            ctx.fillRect(x, cy, widths[c], rh);
          }

          // Isi sel: dipotong agar tidak meluber keluar kolom.
          ctx.fillStyle = cell.color || '#202124';
          let cStyle = '';
          if (cell.italic) cStyle += 'italic ';
          if (cell.bold) cStyle += 'bold ';
          const cSize = cell.size || 13;
          ctx.font = `${cStyle}${cSize}px ${cell.fontFamily || 'Arial'}, sans-serif`;
          ctx.textAlign = 'left';
          const pad = 6;
          let label = cell.text || '';
          // Potong per karakter sampai muat (tanpa ellipsis agar uji deterministik).
          while (label && ctx.measureText(label).width > widths[c] - pad * 2) {
            label = label.slice(0, -1);
          }
          if (label) ctx.fillText(label, x + pad, cy + rh / 2 + cSize * 0.35);

          // Rekam kotak sel untuk hit-test.
          this._tableBoxes.push({ pIdx, lIdx, r, c, x, y: cy, w: widths[c], h: rh });
        }
      }

      // Garis grid: digambar SETELAH isi supaya tidak tertimpa latar sel.
      ctx.strokeStyle = '#dadce0';
      ctx.lineWidth = 1;
      let gx = tmL;
      for (let c = 0; c <= nC; c++) {
        ctx.beginPath();
        ctx.moveTo(gx, yTop);
        ctx.lineTo(gx, yTop + nR * rh);
        ctx.stroke();
        if (c < nC) gx += widths[c];
      }
      for (let r = 0; r <= nR; r++) {
        const gy = yTop + r * rh;
        ctx.beginPath();
        ctx.moveTo(tmL, gy);
        ctx.lineTo(tmL + totalW, gy);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Ukuran tampil kanvas HARUS sama dengan resolusi backing store-nya.
    // Dulu CSS memaku `.kix-canvas-tile-content { height: 900px }` sementara
    // atribut kanvas 850, sehingga setiap glyph diregangkan +5,88% ke bawah:
    // teks tidak hanya buram, GEOMETRINYA salah (batas baris di layar tidak
    // sama dengan koordinat internal yang dipakai hit-test).
    // ==== RESOLUSI LAYAR (devicePixelRatio) ====
    // Kanvas 2D punya dua ukuran: BACKING STORE (atribut width/height, piksel
    // fisik) dan UKURAN TAMPIL (CSS px). Bila keduanya sama di layar HiDPI
    // (dpr 2), browser meng-upscale kanvas 2x sehingga teks jadi buram.
    // Solusi standar: backing store = ukuran logis x dpr, lalu ctx di-skala
    // dpr sehingga SEMUA koordinat gambar tetap dalam px logis.
    //
    // `this.devicePixelRatio` bisa di-override (dipakai pengujian untuk
    // memaksa dpr=2; kalau hanya mengandalkan layar nyata, bug HiDPI tidak
    // akan pernah tertangkap di mesin ber-dpr 1).
    _dpr() {
      const raw = (this.devicePixelRatio != null)
        ? this.devicePixelRatio
        : ((typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1);
      const n = Number(raw);
      if (!isFinite(n) || n <= 0) return 1;
      // Batas atas 4: dpr 8 (zoom ekstrem) akan meledakkan memori kanvas.
      return Math.min(4, n);
    }

    // Ukuran LOGIS halaman (px CSS). Ini yang dipakai seluruh geometri:
    // gambar, hit-test, wrap, dan align. JANGAN pakai canvas.width langsung,
    // karena nilainya sudah dikali dpr.
    viewW() { return this.pageWidth(); }
    viewH() { return this.pageHeight(); }

    _applyCanvasSize(canvas) {
      if (!canvas) return 1;
      const dpr = this._dpr();
      const w = this.pageWidth();
      const h = this.pageHeight();
      const bw = Math.max(1, Math.round(w * dpr));
      const bh = Math.max(1, Math.round(h * dpr));
      // Menulis canvas.width/height mereset konteks & transform, jadi hanya
      // dilakukan bila nilainya benar-benar berubah (caret blink memanggil
      // renderPage tiap 530 ms).
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      if (canvas.style) {
        // Ukuran tampil TETAP px logis -> tidak ada peregangan glyph.
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
      }
      return dpr;
    }

    renderPage(pIdx) {
      const page = this.pages[pIdx];
      if (!page) return;

      const canvas = document.getElementById(`kixCanvas${pIdx + 1}`);
      if (!canvas) return;
      const dpr = this._applyCanvasSize(canvas);

      // Buang kotak hit-test MILIK HALAMAN INI sebelum menggambar ulang.
      // renderPage() dipanggil ulang tiap 530 ms oleh caret blink, dan render
      // itu tidak melewati renderAllPages(). Tanpa filter ini, _linkBoxes
      // menumpuk ribuan entri duplikat selama dokumen dibiarkan terbuka.
      this._linkBoxes = this._linkBoxes.filter(b => b.pIdx !== pIdx);
      // Alasan sama untuk kotak komentar: caret blink memanggil renderPage()
      // tiap 530 ms tanpa lewat renderAllPages(), jadi tanpa filter ini
      // _commentBoxes menumpuk duplikat dan hit-test jadi makin lambat.
      this._commentBoxes = this._commentBoxes.filter(b => b.pIdx !== pIdx);
      // Alasan sama untuk kotak sel tabel & gambar: caret blink memanggil
      // renderPage() tiap 530 ms tanpa lewat renderAllPages(), jadi tanpa
      // filter ini kotak menumpuk dan hit-test makin lambat tiap kedipan.
      this._tableBoxes = this._tableBoxes.filter(b => b.pIdx !== pIdx);
      this._imageBoxes = this._imageBoxes.filter(b => b.pIdx !== pIdx);

      const ctx = canvas.getContext('2d');
      // setTransform HARUS setelah resize: menulis canvas.width/height
      // mereset seluruh state konteks, termasuk transform.
      if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.viewW(), this.viewH());

      // Rentang seleksi dihitung SEKALI per halaman (bukan per segmen) supaya
      // render tetap murah. null = tidak ada seleksi -> seluruh blok di bawah
      // dilewati, sehingga dokumen tanpa seleksi berperilaku persis seperti dulu.
      const selRange = this.getSelectionRange();

      let y = this.textTop();

      for (let lIdx = 0; lIdx < page.lines.length; lIdx++) {
        const m = this.measureLine(page, lIdx, canvas);
        const line = m.line;
        const fontSize = line.size || 13;
        const fontFamily = line.fontFamily || 'Arial';
        const segs = m.segs;

        // ==== RENDER GAMBAR (jalur terpisah dari teks) ====
        // `y` dimajukan manual lalu `continue`, sehingga blok teks di bawah
        // tidak pernah menimpa gambar.
        if (line.type === 'image') {
          this._renderImage(ctx, pIdx, lIdx, line, y);
          y += m.base + m.paragraphGap;
          continue;
        }

        // ==== RENDER TABEL (jalur terpisah dari teks) ====
        // Tabel bukan teks yang di-wrap: ia blok bergaris dengan sel sendiri.
        // `y` dimajukan manual lalu `continue`, sehingga blok teks di bawah
        // tidak pernah menimpa tabel.
        if (line.type === 'table') {
          this._renderTable(ctx, pIdx, lIdx, line, y);
          y += m.base + m.paragraphGap;
          continue;
        }

        ctx.save();
        let fontStyle = '';
        if (line.italic) fontStyle += 'italic ';
        if (line.bold) fontStyle += 'bold ';
        ctx.font = `${fontStyle}${fontSize}px ${fontFamily}, sans-serif`;
        ctx.fillStyle = line.color || '#202124';
        ctx.textAlign = 'left';

        const lineHeight = m.base;
        const baseX = this.marginLeft() + m.indent;

        // Batas seleksi untuk BARIS INI pada basis line.text (tanpa penanda
        // butir). Baris di luar rentang mendapat from === to sehingga tidak
        // ada piksel yang digambar.
        let selFrom = 0, selTo = 0;
        if (selRange) {
          const sp = selRange.start, ep = selRange.end;
          const linePos = { pageIdx: pIdx, lineIdx: lIdx, charIdx: 0 };
          const afterStart = this._comparePoints(linePos, sp) >= 0;
          const beforeEnd = this._comparePoints(linePos, ep) <= 0;
          if (afterStart && beforeEnd) {
            const textLen = (line.text || '').length;
            selFrom = (pIdx === sp.pageIdx && lIdx === sp.lineIdx) ? sp.charIdx : 0;
            selTo = (pIdx === ep.pageIdx && lIdx === ep.lineIdx) ? ep.charIdx : textLen;
          }
        }

        for (let sIdx = 0; sIdx < segs.length; sIdx++) {
          const seg = segs[sIdx];
          const tw = ctx.measureText(seg.text).width;

          // Alignment: hitung titik awal segmen (dipakai juga oleh caret agar konsisten)
          let segX = baseX;
          if (line.align === 'center') {
            const availW = this.viewW() - this.marginLeft() - this.marginRight();
            segX = this.marginLeft() + Math.max(0, (availW - tw) / 2);
          } else if (line.align === 'right') {
            segX = Math.max(this.marginLeft(), this.viewW() - this.marginRight() - tw);
          }

          // ==== HIGHLIGHT SELEKSI RENTANG ====
          // Digambar SEBELUM fillText: kalau sesudah, teks ikut tertimpa biru
          // dan jadi tidak terbaca. Offset seleksi berada pada line.text TANPA
          // penanda butir, jadi digeser m.prefix.length lalu diiris per segmen
          // agar baris yang di-wrap tersorot bersambung.
          if (selRange && selTo > selFrom) {
            const sS = seg.start;
            const sE = seg.start + seg.text.length;
            const a3 = Math.max(selFrom + m.prefix.length, sS);
            const b3 = Math.min(selTo + m.prefix.length, sE);
            if (b3 > a3) {
              const pre3 = seg.text.slice(0, a3 - sS);
              const mid3 = seg.text.slice(a3 - sS, b3 - sS);
              const xOff3 = ctx.measureText(pre3).width;
              const sw = ctx.measureText(mid3).width;
              ctx.save();
              ctx.fillStyle = this.selectionColor || 'rgba(66,133,244,0.28)';
              // Lebar minimum 2px: baris kosong di tengah seleksi lintas baris
              // tetap menampilkan penanda, tidak terlihat "bolong".
              ctx.fillRect(segX + xOff3, y - fontSize + 2, Math.max(sw, 2), fontSize + 4);
              ctx.restore();
            }
          }

          // ==== HIGHLIGHT FIND & REPLACE ====
          // Offset match dihitung pada line.text TANPA penanda butir, sedangkan
          // segmen dibangun dari prefix + text. Karena itu offset match digeser
          // sebesar m.prefix.length agar jatuh di kolom karakter yang benar.
          // Satu match bisa melintasi dua segmen hasil wrap, jadi dihitung
          // irisan (intersection) per segmen, bukan diasumsikan utuh.
          const active = this.findMatches[this.findActiveIdx];
          for (let fmi = 0; fmi < this.findMatches.length; fmi++) {
            const fm = this.findMatches[fmi];
            if (fm.pIdx !== pIdx || fm.lIdx !== lIdx) continue;
            const mStart = fm.start + m.prefix.length;
            const mEnd = mStart + fm.len;
            const sStart = seg.start;
            const sEnd = seg.start + seg.text.length;
            const a = Math.max(mStart, sStart);
            const b = Math.min(mEnd, sEnd);
            if (b <= a) continue;
            const preTxt = seg.text.slice(0, a - sStart);
            const midTxt = seg.text.slice(a - sStart, b - sStart);
            const xOff = ctx.measureText(preTxt).width;
            const hw = ctx.measureText(midTxt).width;
            const isActive = active && active.pIdx === fm.pIdx && active.lIdx === fm.lIdx && active.start === fm.start;
            ctx.save();
            ctx.fillStyle = isActive ? '#fbbc04' : '#ffe066';
            ctx.fillRect(segX + xOff, y - fontSize + 2, hw, fontSize + 4);
            ctx.restore();
          }

          // ==== HIGHLIGHT KOMENTAR ====
          // Digambar SEBELUM fillText supaya teks tetap terbaca di atasnya.
          // Sama seperti pencarian/tautan: offset komentar berada pada line.text
          // TANPA penanda butir, jadi digeser m.prefix.length lalu dihitung
          // irisan per segmen (satu komentar bisa melintasi dua segmen wrap).
          const cms = this._commentsOf(line);
          if (cms.length) {
            const sS2 = seg.start;
            const sE2 = seg.start + seg.text.length;
            for (let ci = 0; ci < cms.length; ci++) {
              const C = cms[ci];
              const cStart = C.start + m.prefix.length;
              const cEnd = C.end + m.prefix.length;
              const a2 = Math.max(cStart, sS2);
              const b2 = Math.min(cEnd, sE2);
              if (b2 <= a2) continue;
              const pre2 = seg.text.slice(0, a2 - sS2);
              const mid2 = seg.text.slice(a2 - sS2, b2 - sS2);
              const xOff2 = ctx.measureText(pre2).width;
              const cw = ctx.measureText(mid2).width;
              ctx.save();
              // Kuning = belum selesai, abu = sudah diresolusi.
              ctx.fillStyle = C.resolved ? 'rgba(154,160,166,0.28)' : 'rgba(255,214,102,0.38)';
              ctx.fillRect(segX + xOff2, y - fontSize + 2, cw, fontSize + 4);
              ctx.restore();
              this._commentBoxes.push({
                pIdx, lIdx, comment: C,
                x: segX + xOff2, y: y - fontSize,
                w: cw, h: fontSize + 6
              });
            }
          }

          ctx.fillStyle = line.color || '#202124';
          // ==== Z-INDEX 3: TEKS UTAMA (RUN-AWARE) ====
          // Baris dengan `runs` digambar potongan demi potongan memakai font run
          // masing-masing; baris tanpa `runs` memakai jalur lama apa adanya.
          // `segRunsFor` memotong runs terhadap SEGMEN INI saja (bukan seluruh
          // baris) — tanpa itu, setiap segmen hasil wrap akan menggambar ulang
          // seluruh isi baris dan teks tampak berlipat.
          const segRuns = this.segRunsFor(line, seg, m.prefix.length);
          if (segRuns && segRuns.length) {
            let rx = segX;
            for (const piece of segRuns) {
              if (!piece.text) continue;
              const r = piece.run;
              let rStyle = '';
              if (r.italic) rStyle += 'italic ';
              if (r.bold) rStyle += 'bold ';
              ctx.font = `${rStyle}${r.size || fontSize}px ${r.fontFamily || fontFamily}, sans-serif`;
              ctx.fillStyle = r.color || line.color || '#202124';
              ctx.fillText(piece.text, rx, y);
              rx += ctx.measureText(piece.text).width;
            }
            // Kembalikan font baris supaya highlight/tautan di bawah memakai metrik
            // yang sama seperti jalur non-run.
            ctx.font = `${fontStyle}${fontSize}px ${fontFamily}, sans-serif`;
            ctx.fillStyle = line.color || '#202124';
          } else {
            ctx.fillText(seg.text, segX, y);
          }

          // ==== HYPERLINK: GAMBAR & HIT-TEST ====
          // Sama seperti highlight pencarian: offset tautan berada pada line.text
          // TANPA penanda butir, sedangkan segmen dibangun dari prefix + text.
          // Karena itu offset digeser sebesar m.prefix.length, lalu dihitung
          // irisan per segmen (satu tautan bisa melintasi dua segmen hasil wrap).
          const links = Array.isArray(line.links) ? line.links : null;
          if (links && links.length) {
            for (let li = 0; li < links.length; li++) {
              const L = links[li];
              const lStart = L.start + m.prefix.length;
              const lEnd = L.end + m.prefix.length;
              const sS = seg.start;
              const sE = seg.start + seg.text.length;
              const a = Math.max(lStart, sS);
              const b = Math.min(lEnd, sE);
              if (b <= a) continue;
              const preTxt = seg.text.slice(0, a - sS);
              const midTxt = seg.text.slice(a - sS, b - sS);
              const xOff = ctx.measureText(preTxt).width;
              const lw = ctx.measureText(midTxt).width;
              // Teks ditimpa warna tautan (Docs memakai biru), lalu digaris bawahi.
              ctx.save();
              ctx.fillStyle = this.linkColor || '#1a73e8';
              ctx.fillText(midTxt, segX + xOff, y);
              ctx.strokeStyle = this.linkColor || '#1a73e8';
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(segX + xOff, y + 3);
              ctx.lineTo(segX + xOff + lw, y + 3);
              ctx.stroke();
              ctx.restore();
              // Rekam kotak untuk hit-test klik. y adalah baseline, jadi kotak
              // dinaikkan setinggi font agar klik di badan huruf tetap kena.
              this._linkBoxes.push({
                pIdx, lIdx, url: L.url,
                x: segX + xOff, y: y - fontSize,
                w: lw, h: fontSize + 6
              });
            }
          }

          if (line.underline) {
            ctx.strokeStyle = line.color || '#202124';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(segX, y + 3);
            ctx.lineTo(segX + tw, y + 3);
            ctx.stroke();
          }

          if (line.strike) {
            ctx.strokeStyle = line.color || '#202124';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(segX, y - fontSize * 0.3);
            ctx.lineTo(segX + tw, y - fontSize * 0.3);
            ctx.stroke();
          }

          // Caret diletakkan pada segmen hasil wrap yang memuat posisi kursor.
          // cursorCharIdx dihitung pada TEKS baris (tanpa penanda butir), jadi
          // posisinya harus digeser sebesar panjang penanda di dalam segmen.
          // Caret disembunyikan saat ada seleksi aktif (paritas Docs): dua
          // penanda sekaligus membuat batas seleksi ambigu.
          if (this.activePageIdx === pIdx && this.activeLineIdx === lIdx && this.isCaretVisible && !selRange) {
            const cIdx = this.cursorCharIdx + m.prefix.length;
            const segEnd = seg.start + seg.text.length;
            const isLast = sIdx === segs.length - 1;
            if (cIdx >= seg.start && (cIdx <= segEnd || isLast)) {
              const local = Math.max(0, Math.min(seg.text.length, cIdx - seg.start));
              const caretX = segX + ctx.measureText(seg.text.slice(0, local)).width;
              ctx.strokeStyle = '#1a73e8';
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(caretX, y - fontSize + 2);
              ctx.lineTo(caretX, y + 3);
              ctx.stroke();
            }
          }

          y += lineHeight;
        }

        ctx.restore();
        y += m.paragraphGap;
      }

      // Header/footer teks di area margin (paritas Docs).
      this._drawHeaderFooter(ctx);

      // ==== NOMOR HALAMAN / WATERMARK FOOTER (Paritas Google Docs) ====
      if (this.showPageNumbers) {
        ctx.save();
        ctx.font = '11px Arial, sans-serif';
        ctx.fillStyle = '#70757a';
        ctx.textAlign = 'center';
        ctx.fillText(String(pIdx + 1), this.pageWidth() / 2, this.pageHeight() - 22);
        ctx.restore();
      } else if (!this.footerText) {
        // Watermark identitas engine Kix di bagian bawah halaman
        ctx.fillStyle = '#9aa0a6';
        ctx.font = 'italic 11px monospace';
        // Nomor tile diturunkan dari indeks halaman, BUKAN dari page.pageNumber:
        // data yang baru dimuat lewat setDocumentData() belum melewati
        // reflowPages(), sehingga pageNumber masih undefined dan watermark
        // akan tercetak "Tile #0undefined".
        ctx.fillText(`[Kix Engine Tile #0${pIdx + 1} · Canvas 2D Text Buffer · 0 DOM Text Glyphs]`, this.marginLeft(), this.pageHeight() - 40);
      }
    }
  }

  // Diekspos supaya test suite dan shell memakai rumus YANG SAMA.
  window.KixUnits = { PT_TO_PX, PX_TO_PT, pxToPt, ptToPx, ptLabel };

  window.KixDocsEditor = KixDocsEditor;
})(window);
