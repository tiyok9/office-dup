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
      this.onLinkClick = null;    // callback buka tautan (dipaksa harness untuk uji)
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
      this.initEvents();
      this.startCaretBlink();
      this.renderAllPages();
    }

    setDocumentData(data) {
      if (data && Array.isArray(data.pages) && data.pages.length > 0) {
        this.pages = JSON.parse(JSON.stringify(data.pages));
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
          const pIdx = parseInt(canvas.getAttribute('data-page') || '0', 10);
          this.activePageIdx = pIdx;

          const rect = canvas.getBoundingClientRect();
          // Kompensasi zoom: rect mengembalikan ukuran SETELAH transform,
          // sedangkan koordinat gambar kanvas tetap 1:1 (PAGE_CANVAS_WIDTH).
          // Tanpa rasio ini, klik saat ter-zoom memilih baris yang salah.
          const zx = rect.width ? canvas.width / rect.width : 1;
          const zy = rect.height ? canvas.height / rect.height : 1;
          const clickY = (e.clientY - rect.top) * zy - LINE_TOP_OFFSET;
          this.activeLineIdx = Math.max(0, Math.min(Math.floor(clickY / LINE_HEIGHT), (this.pages[pIdx]?.lines.length || 1) - 1));

          const line = this.pages[pIdx]?.lines[this.activeLineIdx];
          const clickXl = (e.clientX - rect.left) * zx;
          // Kursor mendarat pada karakter yang DIKLIK, bukan selalu di akhir baris.
          // Sebelumnya `line.text.length` membuat Ctrl+K hanya mampu menggenggam
          // kata terakhir, sehingga tautan di tengah baris mustahil disunting.
          this.cursorCharIdx = line ? this.charIndexAtPoint(pIdx, this.activeLineIdx, clickXl) : 0;

          // ==== KLIK TAUTAN ====
          // Paritas Google Docs MODE EDIT: klik biasa = taruh kursor, hanya
          // Ctrl+Klik (Cmd+Klik di Mac) yang membuka tautan. Kalau klik biasa
          // langsung membuka, user tidak bisa menyunting teks di dalam tautan.
          const clickYl = (e.clientY - rect.top) * zy;
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

      // Deteksi scroll untuk update status bar
      this.scrollBox.addEventListener('scroll', () => {
        const st = this.scrollBox.scrollTop;
        const curPage = Math.min(this.pages.length, Math.floor(st / 850) + 1);
        if (typeof this.onPageChange === 'function') {
          this.onPageChange(curPage, this.pages.length, this.calculateWordCount());
        }
      });
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
          this._shiftLinks(line, this.cursorCharIdx - 1, -1);
          this.cursorCharIdx--;
          modified = true;
        } else if (line.listType && !line.text) {
          // Backspace pada butir daftar yang kosong = lepas dari daftar,
          // bukan menggabung dengan baris sebelumnya (perilaku Google Docs).
          delete line.listType;
          delete line.indent;
          delete line.checked;
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
          this._shiftLinks(line, this.cursorCharIdx, -1);
          modified = true;
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
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
        // Warisi SELURUH properti gaya (termasuk underline/strike/heading/list),
        // bukan hanya bold/italic — kalau tidak, format user hilang tiap Enter.
        const newLine = { text: textAfter };
        if (movedLinks) newLine.links = movedLinks;
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
        // Sisip 1 karakter: tautan sesudah/di dalam rentang ikut bergeser.
        this._shiftLinks(line, this.cursorCharIdx, 1);
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
        this.onActiveLineChange(page ? page.lines[this.activeLineIdx] : null, this.currentStyle);
      }
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
        pageDiv.className = 'kix-page';
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
    wrapSegmentsFor(canvas, text, fontSize, bold, italic, fontFamily, extraLeft) {
      const ctx = canvas.getContext('2d');
      let style = '';
      if (italic) style += 'italic ';
      if (bold) style += 'bold ';
      ctx.font = `${style}${fontSize}px ${fontFamily || 'Arial'}, sans-serif`;
      const maxWidth = canvas.width - 60 - (extraLeft || 0); // margin + indentasi/penanda
      if (!text) return [{ text: '', start: 0 }];

      const tokens = text.split(/(?<=\s)/);
      const segs = [];
      let cur = '', curStart = 0, pos = 0;
      for (const tok of tokens) {
        if (cur !== '' && ctx.measureText(cur + tok).width > maxWidth) {
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
        line.bold, line.italic, line.fontFamily, indent
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

          ctx.fillStyle = line.color || '#202124';
          ctx.fillText(seg.text, segX, y);

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

      // Watermark identitas engine Kix di bagian bawah halaman
      ctx.fillStyle = '#9aa0a6';
      ctx.font = 'italic 11px monospace';
      ctx.fillText(`[Kix Engine Tile #0${page.pageNumber} · Canvas 2D Text Buffer · 0 DOM Text Glyphs]`, MARGIN, 810);
    }
  }

  window.KixDocsEditor = KixDocsEditor;
})(window);
