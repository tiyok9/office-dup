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
  const LINE_HEIGHT = 24;

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

  class KixDocsEditor {
    constructor(scrollContainerId, hiddenInputId, onPageChange) {
      this.scrollBox = document.getElementById(scrollContainerId);
      this.hiddenInput = document.getElementById(hiddenInputId);
      this.onPageChange = onPageChange;

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
      this.activePageIdx = 0;
      this.activeLineIdx = 0;
      this.cursorCharIdx = 0;
      this.renderAllPages();
    }

    getDocumentData() {
      return { pages: this.pages };
    }

    startCaretBlink() {
      if (this.caretTimer) clearInterval(this.caretTimer);
      this.caretTimer = setInterval(() => {
        this.isCaretVisible = !this.isCaretVisible;
        this.renderPage(this.activePageIdx);
      }, 530); // Laju kedipan standar Google Docs (~530ms)
    }

    initEvents() {
      // Klik pada scroll box memfokuskan interceptor input teks Kix
      this.scrollBox.addEventListener('click', (e) => {
        const canvas = e.target.closest('.kix-page')?.querySelector('canvas');
        if (canvas) {
          const pIdxRaw = parseInt(canvas.getAttribute('data-page') || '0', 10);
          const rect = canvas.getBoundingClientRect();
          // Kompensasi zoom: rect mengembalikan ukuran SETELAH transform,
          // sedangkan koordinat gambar kanvas tetap 1:1 (PAGE_CANVAS_WIDTH).
          // Tanpa rasio ini, klik saat ter-zoom memilih baris yang salah.
          const zx = rect.width ? canvas.width / rect.width : 1;
          const zy = rect.height ? canvas.height / rect.height : 1;
          const clickY = (e.clientY - rect.top) * zy - LINE_TOP_OFFSET;
          const clickXl = (e.clientX - rect.left) * zx;
          const clickYl = (e.clientY - rect.top) * zy;

          const lIdxRaw = Math.floor(clickY / LINE_HEIGHT);
          const clamped = this.clampPoint(pIdxRaw, lIdxRaw, clickXl);
          this.activePageIdx = clamped.pIdx;
          this.activeLineIdx = clamped.lIdx;
          const pIdx = this.activePageIdx;

          const line = this.pages[pIdx]?.lines[this.activeLineIdx];

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

      // Deteksi scroll untuk update status bar. Indikator mengikuti halaman
      // yang BENAR-BENAR mengisi viewport (lihat pageIndexAtViewportTop).
      this.scrollBox.addEventListener('scroll', () => {
        const curPage = this.pageIndexAtViewportTop() + 1;
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

      if (e.key === 'Backspace') {
        e.preventDefault();
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
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (this.cursorCharIdx > 0) this.cursorCharIdx--;
        else if (this.activeLineIdx > 0) {
          this.activeLineIdx--;
          this.cursorCharIdx = page.lines[this.activeLineIdx].text.length;
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (this.cursorCharIdx < line.text.length) this.cursorCharIdx++;
        else if (this.activeLineIdx < page.lines.length - 1) {
          this.activeLineIdx++;
          this.cursorCharIdx = 0;
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.activeLineIdx > 0) {
          this.activeLineIdx--;
          this.cursorCharIdx = Math.min(this.cursorCharIdx, page.lines[this.activeLineIdx].text.length);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.activeLineIdx < page.lines.length - 1) {
          this.activeLineIdx++;
          this.cursorCharIdx = Math.min(this.cursorCharIdx, page.lines[this.activeLineIdx].text.length);
        }
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
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
      const safeX = Math.max(MARGIN, Math.min(PAGE_CANVAS_WIDTH - MARGIN, x || MARGIN));
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
      measCanvas.width = PAGE_CANVAS_WIDTH;
      measCanvas.height = PAGE_CANVAS_HEIGHT;

      const out = [];
      for (const page of this.pages) {
        let cur = { pageNumber: out.length + 1, lines: [] };
        let y = 60;
        for (let lIdx = 0; lIdx < page.lines.length; lIdx++) {
          // Tinggi baris memakai sumber kebenaran yang SAMA dengan renderPage(),
          // sehingga paginasi tidak pernah melenceng dari yang terlihat user.
          const m = this.measureLine(page, lIdx, measCanvas);
          if (y + m.height > MAX_TEXT_Y && cur.lines.length > 0) {
            out.push(cur);
            cur = { pageNumber: out.length + 1, lines: [] };
            y = 60;
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
        pageDiv.id = `kixPage${i + 1}`;
        pageDiv.setAttribute('data-page-index', i.toString());
        pageDiv.innerHTML = `
          <div class="kix-page-header">Halaman ${i + 1}</div>
          <canvas class="kix-canvas-tile-content" id="kixCanvas${i + 1}" data-page="${i}" width="${PAGE_CANVAS_WIDTH}" height="${PAGE_CANVAS_HEIGHT}"></canvas>
        `;
        container.appendChild(pageDiv);
      }

      for (let i = 0; i < this.pages.length; i++) {
        this.renderPage(i);
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
      const maxWidth = canvas.width - 60 - (extraLeft || 0); // margin + indentasi/penanda
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
    lineRectAt(pIdx, lIdx) {
      const top = LINE_TOP_OFFSET + lIdx * LINE_HEIGHT;
      return { top, height: LINE_HEIGHT, centerY: top + LINE_HEIGHT / 2 };
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
      const baseX = MARGIN + m.indent;
      const prefixLen = m.prefix.length;
      for (const seg of m.segs) {
        const tw = ctx.measureText(seg.text).width;
        let segX = baseX;
        if (line.align === 'center') segX = Math.max(MARGIN, (canvas.width - tw) / 2);
        else if (line.align === 'right') segX = Math.max(MARGIN, canvas.width - MARGIN - tw);
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
      const boxLeft = MARGIN + this.indentFor(line);
      const row = this.lineRectAt(pIdx, lIdx);
      return { left: boxLeft - 5, top: row.top, width: 25, height: LINE_HEIGHT, centerX: boxLeft + 7, centerY: row.centerY };
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

    renderPage(pIdx) {
      const page = this.pages[pIdx];
      if (!page) return;

      const canvas = document.getElementById(`kixCanvas${pIdx + 1}`);
      if (!canvas) return;

      // Buang kotak hit-test MILIK HALAMAN INI sebelum menggambar ulang.
      // renderPage() dipanggil ulang tiap 530 ms oleh caret blink, dan render
      // itu tidak melewati renderAllPages(). Tanpa filter ini, _linkBoxes
      // menumpuk ribuan entri duplikat selama dokumen dibiarkan terbuka.
      this._linkBoxes = this._linkBoxes.filter(b => b.pIdx !== pIdx);
      // Alasan sama untuk kotak komentar: caret blink memanggil renderPage()
      // tiap 530 ms tanpa lewat renderAllPages(), jadi tanpa filter ini
      // _commentBoxes menumpuk duplikat dan hit-test jadi makin lambat.
      this._commentBoxes = this._commentBoxes.filter(b => b.pIdx !== pIdx);

      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      let y = 60;

      for (let lIdx = 0; lIdx < page.lines.length; lIdx++) {
        const m = this.measureLine(page, lIdx, canvas);
        const line = m.line;
        const fontSize = line.size || 13;
        const fontFamily = line.fontFamily || 'Arial';
        const segs = m.segs;

        ctx.save();
        let fontStyle = '';
        if (line.italic) fontStyle += 'italic ';
        if (line.bold) fontStyle += 'bold ';
        ctx.font = `${fontStyle}${fontSize}px ${fontFamily}, sans-serif`;
        ctx.fillStyle = line.color || '#202124';
        ctx.textAlign = 'left';

        const lineHeight = m.base;
        const baseX = MARGIN + m.indent;

        for (let sIdx = 0; sIdx < segs.length; sIdx++) {
          const seg = segs[sIdx];
          const tw = ctx.measureText(seg.text).width;

          // Alignment: hitung titik awal segmen (dipakai juga oleh caret agar konsisten)
          let segX = baseX;
          if (line.align === 'center') segX = Math.max(MARGIN, (canvas.width - tw) / 2);
          else if (line.align === 'right') segX = Math.max(MARGIN, canvas.width - MARGIN - tw);

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
          if (this.activePageIdx === pIdx && this.activeLineIdx === lIdx && this.isCaretVisible) {
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

      // ==== NOMOR HALAMAN / WATERMARK FOOTER (Paritas Google Docs) ====
      if (this.showPageNumbers) {
        ctx.save();
        ctx.font = '11px Arial, sans-serif';
        ctx.fillStyle = '#70757a';
        ctx.textAlign = 'center';
        ctx.fillText(String(pIdx + 1), PAGE_CANVAS_WIDTH / 2, PAGE_CANVAS_HEIGHT - 22);
        ctx.restore();
      } else {
        // Watermark identitas engine Kix di bagian bawah halaman
        ctx.fillStyle = '#9aa0a6';
        ctx.font = 'italic 11px monospace';
        // Nomor tile diturunkan dari indeks halaman, BUKAN dari page.pageNumber:
        // data yang baru dimuat lewat setDocumentData() belum melewati
        // reflowPages(), sehingga pageNumber masih undefined dan watermark
        // akan tercetak "Tile #0undefined".
        ctx.fillText(`[Kix Engine Tile #0${pIdx + 1} · Canvas 2D Text Buffer · 0 DOM Text Glyphs]`, MARGIN, 810);
      }
    }
  }

  window.KixDocsEditor = KixDocsEditor;
})(window);
