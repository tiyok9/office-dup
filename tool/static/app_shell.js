// D:\program\google\tool\static\app_shell.js
// Workspace Universal Shell: toolbar kontekstual, menu bar aksi nyata,
// autosave, undo/redo, share modal, Drive Hub (cari/filter/bintang/duplikat),
// word count, keyboard shortcuts, dan unduhan per tipe dokumen.

(function(window) {
  'use strict';

  function escapeXml(unsafe) {
    return String(unsafe)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  const TYPE_LABEL = { docs: 'Dokumen', sheets: 'Spreadsheet', slides: 'Presentasi' };
  const TYPE_ENGINE = { docs: 'Kix Engine', sheets: 'Ritz Engine', slides: 'Punch Engine' };
  const TYPE_TAG = { docs: 'tag-kix', sheets: 'tag-ritz', slides: 'tag-punch' };
  const TYPE_THUMB = {
    docs: '/shots/docs.before.png',
    sheets: '/shots/sheets.before.png',
    slides: '/shots/slides.before.png'
  };

  class WorkspaceAppShell {
    constructor() {
      this.currentApp = 'docs';
      this.currentDocId = 'docs-2002-nominee';
      this.documents = [];

      this.saveDebounceTimer = null;
      this.isSaving = false;

      this.kix = null;
      this.ritz = null;
      this.punch = null;

      // Drive Hub state
      this.searchQuery = '';
      this.typeFilter = 'all';
      this.starFirst = false;

      // Riwayat undo/redo per aplikasi (snapshot JSON data dokumen)
      this.undoStack = { docs: [], sheets: [], slides: [] };
      this.redoStack = { docs: [], sheets: [], slides: [] };
      this._restoring = false;
      // Nilai batal milik modal Promise yang SEDANG terbuka (false untuk
      // confirm, null untuk prompt, undefined untuk alert). Dipakai handler
      // Escape global supaya Escape dan tombol Batal menyerahkan nilai yang
      // sama — dulu Escape memberi null walau Batal memberi false.
      this._modalCancelValue = null;
      // Perubahan yang sedang menunggu debounce autosave (lihat triggerAutosave).
      // Diisi { targetId, payload } agar flush dapat menulis TANPA bergantung
      // pada currentDocId yang mungkin sudah berpindah.
      this.pendingSave = null;

      // Zoom tampilan (dipakai <select id="tbZoom">). 1 = 100%.
      this.zoomLevel = 1;
    }

    async init() {
      this.initEditors();
      this.initMenuDropdowns();
      this.initTopBarActions();
      this.initToolbarBindings();
      this.initDriveControls();
      this.initKeyboardShortcuts();
      this.initUnloadFlush();
      await this.loadDocumentList();
      await this.openDocument('docs-2002-nominee');
      this.syncToolbar();
    }

    // ================= EDITOR INSTANCES =================
    initEditors() {
      if (window.KixDocsEditor) {
        this.kix = new window.KixDocsEditor('docsScrollBox', 'kixHiddenInput', (curPage, totalPages, words) => {
          // Setiap bagian status bar diperbarui sebagai ELEMEN TERPISAH.
          //
          // Dulu seluruh isi #docsStatusText ditimpa lewat innerText. Karena
          // <span id="docsCurPage"> adalah ANAK dari div itu, penimpaan pada
          // pembaruan PERTAMA ikut menghapus span tersebut; getElementById
          // ('docsCurPage') lalu selamanya null sehingga angka halaman tidak
          // pernah bisa dibaca maupun disinkronkan lagi. Teks status tetap
          // tampak benar (ditulis ulang utuh), jadi cacat ini tidak terlihat.
          const setStatusPart = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.innerText = String(val);
          };
          setStatusPart('docsCurPage', curPage);
          setStatusPart('docsTotalPages', totalPages);
          setStatusPart('docsWordCount', words);
        });
        this.kix.onChange = (data) => {
          if (!this._restoring) this.recordHistory('docs', data);
          this.triggerAutosave({ data });
          this.syncToolbar();
        };
        // Toolbar harus memantulkan format BARIS DI KURSOR setiap kali kursor
        // bergerak (klik baris lain, panah, Enter) — bukan hanya saat mengedit.
        this.kix.onActiveLineChange = (line, currentStyle, formatting) => this.syncToolbar(formatting);
        if (typeof window !== 'undefined') {
          window.kixEditor = this.kix;
        }
        // Ctrl+Klik pada tautan: buka di tab baru. Callback ini dipasang di
        // shell (bukan di editor) supaya editor tetap murni model+tampilan,
        // dan supaya harness dapat mengganti perilakunya saat pengujian.
        this.kix.onLinkClick = (url) => {
          const safe = this.kix.sanitizeUrl(url);
          if (!safe) { this.showToast('Tautan tidak valid.'); return; }
          window.open(safe, '_blank', 'noopener,noreferrer');
          this.showToast('Membuka tautan: ' + safe);
        };
        // Klik highlight komentar: buka thread. Dipasang di shell (bukan
        // editor) supaya editor tetap murni model+tampilan, dan harness
        // E2E dapat mengganti perilakunya saat pengujian.
        this.kix.onCommentClick = (comment) => this.openCommentModal(comment);
      }

      if (window.RitzSpreadsheetEditor) {
        this.ritz = new window.RitzSpreadsheetEditor('sheetsGridCanvas', 'sheetFormulaInput', 'sheetActiveCell');
        this.ritz.onCellChange = (cells) => {
          // sheets[] ikut dikirim supaya suntingan pada sheet mana pun tersimpan.
          const data = { cells, sheets: this.ritz.getSheets(), activeSheetIdx: this.ritz.activeSheetIdx };
          // Sheets memakai jalur khusus: pindah tab tidak boleh jadi entri undo.
          if (!this._restoring) this.recordSheetsHistory(data);
          this.triggerAutosave({ data });
          this.syncToolbar();
        };
        // Tab bar dinamis digambar dari model (bukan HTML statis "Sheet1").
        this.ritz.renderSheetTabs();
        // Klik indikator komentar sel: buka thread. Pola identik dengan
        // penanganan komentar di Docs (lihat pemasangan pada editor Kix di atas):
        // editor tetap murni model+tampilan, shell yang membuka UI percakapan.
        this.ritz.onCommentClick = (coord, list) => this.openSheetCommentModal(coord, list);
      }

      if (window.PunchSlidesEditor) {
        this.punch = new window.PunchSlidesEditor('punchSvgStage', 'slidesFilmstrip', () => {
          this.syncToolbar();
        });
        this.punch.onChange = (slides) => {
          const data = { slides };
          if (!this._restoring) this.recordHistory('slides', data);
          this.triggerAutosave({ data });
          this.syncToolbar();
        };
      }
    }

    // ================= UNDO / REDO =================
    recordHistory(app, data) {
      const key = JSON.stringify(data);
      const stack = this.undoStack[app] || (this.undoStack[app] = []);
      if (stack.length && stack[stack.length - 1] === key) return;
      stack.push(key);
      if (stack.length > 60) stack.shift();
      this.redoStack[app] = [];
    }

    resetHistory(app, data) {
      this.undoStack[app] = [JSON.stringify(data)];
      this.redoStack[app] = [];
    }

    // Sheets: pindah tab TIDAK boleh menjadi entri undo (paritas Google Sheets).
    // switchSheet() memanggil notifyChange() -> onCellChange(), jadi tanpa guard
    // ini setiap klik tab menambah satu entri dan Ctrl+Z berubah menjadi
    // "batalkan navigasi tab" — resize baris/kolom jadi tidak bisa dijangkau.
    // Aturan: bila snapshot baru HANYA berbeda pada activeSheetIdx, GANTI entri
    // puncak (jangan tambah) supaya kedalaman stack stabil dan Ctrl+Z tetap
    // membatalkan suntingan nyata.
    recordSheetsHistory(data) {
      const key = JSON.stringify(data);
      const stack = this.undoStack.sheets || (this.undoStack.sheets = []);
      if (stack.length && stack[stack.length - 1] === key) return;

      if (stack.length) {
        let prev = null;
        try { prev = JSON.parse(stack[stack.length - 1]); } catch { prev = null; }
        if (prev) {
          // Pembanding HANYA sheets[]. `cells` sengaja tidak diikutkan: ia cermin
          // dari sheet AKTIF (diisi _loadActiveSheet), jadi saat pindah tab
          // nilainya ikut berubah walau isi dokumen sama sekali tidak berubah.
          // Membandingkannya akan membuat guard ini tidak pernah aktif.
          if (JSON.stringify(prev.sheets) === JSON.stringify(data.sheets)) {
            stack[stack.length - 1] = key;
            return;
          }
        }
      }

      stack.push(key);
      if (stack.length > 60) stack.shift();
      this.redoStack.sheets = [];
    }

    performUndo(app) {
      const u = this.undoStack[app] || [];
      if (u.length < 2) {
        this.showToast('Tidak ada aksi untuk dibatalkan (Undo)');
        return false;
      }
      const cur = u.pop();
      (this.redoStack[app] = this.redoStack[app] || []).push(cur);
      this.applySnapshot(app, u[u.length - 1]);
      this.showToast('Undo berhasil');
      return true;
    }

    performRedo(app) {
      const r = this.redoStack[app] || [];
      if (!r.length) {
        this.showToast('Tidak ada aksi untuk diulang (Redo)');
        return false;
      }
      const snap = r.pop();
      (this.undoStack[app] = this.undoStack[app] || []).push(snap);
      this.applySnapshot(app, snap);
      this.showToast('Redo berhasil');
      return true;
    }

    applySnapshot(app, json) {
      let data;
      try { data = JSON.parse(json); } catch { return; }
      this._restoring = true;
      if (app === 'docs' && this.kix) this.kix.setDocumentData(data);
      else if (app === 'sheets' && this.ritz) {
        // Snapshot lama mungkin hanya punya cells (tanpa sheets[]).
        if (Array.isArray(data.sheets) && data.sheets.length) {
          this.ritz.setSheets(data.sheets, data.activeSheetIdx || 0);
        } else {
          this.ritz.setCells(data.cells || {});
        }
      }
      else if (app === 'slides' && this.punch) this.punch.setSlides(data.slides || []);
      this._restoring = false;
      this.triggerAutosave({ data });
      this.syncToolbar();
    }

    // ================= DRIVE HUB =================
    async loadDocumentList() {
      try {
        const res = await fetch('/api/documents');
        if (res.ok) {
          this.documents = await res.json();
          this.renderDriveGrid();
        }
      } catch (err) {
        console.error('Gagal memuat daftar dokumen:', err);
      }
    }

    visibleDocuments() {
      let list = this.documents.slice();
      if (this.typeFilter !== 'all') list = list.filter(d => d.type === this.typeFilter);
      if (this.searchQuery) {
        const q = this.searchQuery.toLowerCase();
        list = list.filter(d => (d.title || '').toLowerCase().includes(q));
      }
      if (this.starFirst) list.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0));
      return list;
    }

    renderDriveGrid() {
      const grid = document.getElementById('driveGridContainer');
      if (!grid) return;
      grid.innerHTML = '';

      const list = this.visibleDocuments();
      const countEl = document.getElementById('driveResultCount');
      if (countEl) countEl.innerText = `${list.length} dari ${this.documents.length} file`;

      if (list.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1/-1; padding: 40px; text-align: center; color: #5f6368; font-size: 14px;">Tidak ada file yang cocok dengan pencarian/filter.</div>`;
        return;
      }

      list.forEach(doc => {
        const card = document.createElement('div');
        card.className = 'drive-card';
        card.setAttribute('data-doc-id', doc.id);
        card.setAttribute('data-doc-type', doc.type);
        card.style.cssText = 'background: #fff; border: 1px solid #dadce0; border-radius: 12px; overflow: hidden; cursor: pointer; transition: all 0.2s; box-shadow: 0 1px 3px rgba(60,64,67,0.15); display: flex; flex-direction: column; position: relative;';

        const tagClass = TYPE_TAG[doc.type] || 'tag-kix';
        const tagLabel = TYPE_ENGINE[doc.type] || 'Kix Engine';
        const thumbImg = TYPE_THUMB[doc.type] || TYPE_THUMB.docs;
        const star = doc.starred ? '★' : '☆';
        const starColor = doc.starred ? '#f29900' : '#9aa0a6';

        card.innerHTML = `
          <div style="height: 150px; background: #202124; display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative;">
            <img src="${thumbImg}" alt="${escapeXml(doc.title)}" style="width: 100%; height: 100%; object-fit: cover;">
            <span class="star-toggle" title="Tandai favorit" style="position: absolute; top: 8px; right: 8px; font-size: 20px; color: ${starColor}; background: rgba(255,255,255,0.85); width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer;">${star}</span>
          </div>
          <div style="padding: 14px 16px; flex: 1; display: flex; flex-direction: column; justify-content: space-between;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
              <span class="drive-title" title="Klik dua kali untuk mengubah nama" style="font-size: 14px; font-weight: 500; color: #202124; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px;">${escapeXml(doc.title)}</span>
              <span class="engine-tag ${tagClass}" style="font-size: 11px; padding: 2px 8px; border-radius: 12px; font-weight: 600;">${tagLabel}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 12px; color: #5f6368; align-items: center; margin-top: 6px;">
              <span>${TYPE_LABEL[doc.type] || doc.type}</span>
              <span style="display: flex; gap: 8px;">
                <span class="card-action" data-act="duplicate" style="color: #1a73e8; font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 4px;">Duplikat</span>
                <span class="card-action" data-act="delete" style="color: #d93025; font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 4px;">Hapus</span>
              </span>
            </div>
          </div>
        `;

        card.onclick = () => this.openDocument(doc.id);

        const starEl = card.querySelector('.star-toggle');
        starEl.onclick = (e) => {
          e.stopPropagation();
          this.toggleStar(doc.id, !doc.starred);
        };

        card.querySelectorAll('.card-action').forEach(btn => {
          btn.onclick = (e) => {
            e.stopPropagation();
            const act = btn.getAttribute('data-act');
            if (act === 'duplicate') this.duplicateDoc(doc.id);
            else this.deleteDoc(doc.id);
          };
        });

        const titleEl = card.querySelector('.drive-title');
        titleEl.ondblclick = async (e) => {
          e.stopPropagation();
          const newTitle = await this.promptModal({
            title: 'Ubah nama file',
            message: 'Masukkan nama baru untuk file ini:',
            defaultValue: doc.title,
            placeholder: 'Nama file',
            confirmText: 'Simpan',
            cancelText: 'Batal'
          });
          if (newTitle !== null && newTitle.trim() !== '') {
            this.renameDoc(doc.id, newTitle.trim());
          }
        };

        grid.appendChild(card);
      });
    }

    initDriveControls() {
      const search = document.getElementById('driveSearchInput');
      if (search) {
        search.addEventListener('input', () => {
          this.searchQuery = search.value.trim();
          this.renderDriveGrid();
        });
      }

      document.querySelectorAll('#driveFilterChips .filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          this.typeFilter = chip.getAttribute('data-filter') || 'all';
          document.querySelectorAll('#driveFilterChips .filter-chip').forEach(c =>
            c.classList.toggle('chip-active', c === chip));
          this.renderDriveGrid();
        });
      });

      const starToggle = document.getElementById('driveStarToggle');
      if (starToggle) {
        starToggle.addEventListener('click', () => {
          this.starFirst = !this.starFirst;
          starToggle.classList.toggle('chip-active', this.starFirst);
          this.renderDriveGrid();
        });
      }
    }

    async toggleStar(id, starred) {
      try {
        const res = await fetch(`/api/documents/${id}/star`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ starred })
        });
        if (res.ok) {
          await this.loadDocumentList();
          this.showToast(starred ? 'Ditandai sebagai favorit.' : 'Tanda favorit dihapus.');
        }
      } catch (err) {
        this.showToast('Gagal memperbarui favorit');
      }
    }

    async renameDoc(id, newTitle) {
      try {
        const res = await fetch(`/api/documents/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle })
        });
        if (res.ok) {
          if (this.currentDocId === id) {
            const t = document.getElementById('docTitle');
            if (t) t.value = newTitle;
          }
          await this.loadDocumentList();
          this.showToast(`Nama file diubah menjadi "${newTitle}".`);
        }
      } catch (err) {
        this.showToast('Gagal mengubah nama');
      }
    }

    async duplicateDoc(id) {
      try {
        const res = await fetch(`/api/documents/${id}/duplicate`, { method: 'POST' });
        if (res.ok) {
          const copy = await res.json();
          await this.loadDocumentList();
          this.showToast(`Salinan dibuat: ${copy.title}`);
        } else {
          this.showToast('Gagal menduplikasi dokumen');
        }
      } catch (err) {
        this.showToast('Gagal menduplikasi dokumen');
      }
    }

    async openDocument(id) {
      try {
        await this.flushPendingSave(); // jangan biarkan autosave dokumen lama ikut pindah
        const res = await fetch(`/api/documents/${id}`);
        if (!res.ok) return;
        const doc = await res.json();
        this.currentDocId = doc.id;

        const titleInput = document.getElementById('docTitle');
        if (titleInput) titleInput.value = doc.title;

        this.switchApp(doc.type);

        if (doc.type === 'docs' && this.kix && doc.data) {
          this.kix.setDocumentData(doc.data);
          this.resetHistory('docs', doc.data);
        } else if (doc.type === 'sheets' && this.ritz && doc.data) {
          // Dokumen format lama hanya punya data.cells -> dibungkus jadi 1 sheet.
          // Dokumen baru punya data.sheets[] -> semua sheet ikut dimuat.
          if (Array.isArray(doc.data.sheets) && doc.data.sheets.length) {
            this.ritz.setSheets(doc.data.sheets, doc.data.activeSheetIdx || 0);
          } else {
            this.ritz.setSheets([{ name: 'Sheet1', cells: doc.data.cells || {}, charts: doc.data.charts || [] }], 0);
          }
          this.resetHistory('sheets', {
            cells: this.ritz.getCells(),
            sheets: this.ritz.getSheets(),
            activeSheetIdx: this.ritz.activeSheetIdx
          });
        } else if (doc.type === 'slides' && this.punch && doc.data) {
          this.punch.setSlides(doc.data.slides || []);
          this.resetHistory('slides', { slides: doc.data.slides || [] });
        }

        this.updateSaveStatus('Semua perubahan disimpan ke Drive');
        this.syncToolbar();
      } catch (err) {
        console.error('Gagal membuka dokumen:', err);
      }
    }

    async createNewDoc(type) {
      const titles = { docs: 'Dokumen Tanpa Judul', sheets: 'Spreadsheet Tanpa Judul', slides: 'Presentasi Tanpa Judul' };
      try {
        const res = await fetch('/api/documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, title: titles[type] || 'Dokumen Baru' })
        });
        if (res.ok) {
          const newDoc = await res.json();
          await this.loadDocumentList();
          await this.openDocument(newDoc.id);
          this.showToast(`Dokumen baru ${newDoc.title} berhasil dibuat!`);
        }
      } catch (err) {
        this.showToast('Gagal membuat dokumen: ' + err.message);
      }
    }

    async deleteDoc(id) {
      if (!(await this.confirmModal({
        title: 'Hapus dokumen',
        message: 'Apakah Anda yakin ingin menghapus dokumen ini dari Drive?',
        confirmText: 'Hapus',
        cancelText: 'Batal',
        danger: true
      }))) return;
      try {
        const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' });
        if (res.ok) {
          await this.loadDocumentList();
          if (this.currentDocId === id) {
            const first = this.documents[0];
            if (first) this.openDocument(first.id);
            else this.switchApp('drive');
          }
          this.showToast('Dokumen berhasil dihapus dari Drive.');
        }
      } catch (err) {
        this.showToast('Gagal menghapus: ' + err.message);
      }
    }

    // ================= TAB / VIEW SWITCHING =================
    switchApp(app) {
      window.currentApp = app;
      this.currentApp = app;

      document.querySelectorAll('.app-tab').forEach(t => t.className = 'app-tab');
      document.querySelectorAll('.view-docs, .view-sheets, .view-slides, .view-drive').forEach(v => v.style.display = 'none');

      const tab = document.getElementById(`tab-${app}`);
      if (tab) tab.classList.add(`active-${app}`);

      const view = document.getElementById(`view-${app}`);
      if (view) view.style.display = (app === 'docs' || app === 'sheets') ? 'flex' : 'block';

      const logo = document.getElementById('appLogoSvg');
      if (logo) {
        const logos = {
          docs: ['#1a73e8', '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/>'],
          sheets: ['#0f9d58', '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H6v-3h3v3zm0-5H6V9h3v3zm0-5H6V6h3v1zm5 10h-3v-3h3v3zm0-5h-3V9h3v3zm0-5h-3V6h3v1zm5 10h-3v-3h3v3zm0-5h-3V9h3v3zm0-5h-3V6h3v1z"/>'],
          slides: ['#f29900', '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM8 7h8v2H8zm0 4h8v2H8zm0 4h5v2H8z"/>'],
          drive: ['#4285f4', '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>']
        };
        const l = logos[app] || logos.drive;
        logo.setAttribute('fill', l[0]);
        logo.innerHTML = l[1];
      }

      this.updateToolbarForApp(app);

      if (app === 'sheets' && this.ritz) {
        setTimeout(() => this.ritz.render(), 50);
      } else if (app === 'docs' && this.kix) {
        setTimeout(() => this.kix.renderAllPages(), 50);
      } else if (app === 'slides' && this.punch) {
        setTimeout(() => this.punch.render(), 50);
      } else if (app === 'drive') {
        this.renderDriveGrid();
      }
    }

    // ================= TOOLBAR KONTEKSTUAL =================
    updateToolbarForApp(app) {
      const groups = { docs: '.tb-group-docs', sheets: '.tb-group-sheets', slides: '.tb-group-slides' };
      Object.keys(groups).forEach(key => {
        document.querySelectorAll(groups[key]).forEach(el => {
          // WAJIB 'flex', bukan '' — mengosongkan display menghapus display:flex
          // inline sehingga span kembali ke `inline` dan tombol-tombolnya
          // bertumpuk vertikal (toolbar rusak).
          el.style.display = (key === app) ? 'flex' : 'none';
        });
      });
      // Tombol kalkulasi hanya relevan di Sheets. Tanpa toggle ini ia tertinggal
      // display:none sehingga tidak bisa diklik user (rect nol -> klik meleset).
      const calcBtn = document.getElementById('sheetCalcBtn');
      if (calcBtn) calcBtn.style.display = (app === 'sheets') ? 'inline-block' : 'none';
      // Grup netral (undo/redo/print/zoom/presentasi) selalu tampil.
      this.syncToolbar();
    }

    // Dropdown ukuran SELALU harus punya opsi untuk nilai aktif.
    // Sebelumnya preset "Title" (26px) tidak ada di daftar <option>, sehingga
    // browser mengosongkan select: selectedIndex -1, kotak ukuran jadi kosong
    // dan user kehilangan indikator ukuran (terukur di probe16).
    // Injeksi generik menutup SELURUH kelas bug ini, bukan hanya 26.
    syncFontSizeSelect(px) {
      const sel = document.getElementById('tbFontSize');
      // Number() dulu: nilai dari storage bisa berupa string. Guard `!px` lama
      // meloloskan -5 dan Infinity (keduanya truthy) sehingga <option value="-5">
      // benar-benar disuntik ke dropdown — kelas bug "kotak aneh", arah sebaliknya.
      const n = Number(px);
      if (!sel || !Number.isFinite(n) || n <= 0) return;
      const val = String(n);
      const ada = Array.from(sel.options).some((o) => o.value === val);
      if (!ada) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = (typeof window !== 'undefined' && window.KixUnits)
          ? window.KixUnits.ptLabel(n) : val;
        sel.appendChild(opt);
        // Urutkan ulang supaya opsi sisipan tidak menumpuk di ekor daftar.
        const urut = Array.from(sel.options).sort((a, b) => parseFloat(a.value) - parseFloat(b.value));
        while (sel.firstChild) sel.removeChild(sel.firstChild);
        urut.forEach((o) => sel.appendChild(o));
      }
      sel.value = val;
    }

    syncToolbar(stOverride) {
      const set = (id, on) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', !!on);
      };

      let st = {};
      if (stOverride && typeof stOverride === 'object') {
        st = stOverride;
        const fam = document.getElementById('tbFontFamily');
        if (fam && st.fontFamily) fam.value = st.fontFamily;
        this.syncFontSizeSelect(st.size);
      } else if (this.currentApp === 'docs' && this.kix) {
        st = (this.kix.getActiveFormatting ? this.kix.getActiveFormatting() : (this.kix.pages[this.kix.activePageIdx]?.lines[this.kix.activeLineIdx] || this.kix.currentStyle || {}));
        const fam = document.getElementById('tbFontFamily');
        if (fam && st.fontFamily) fam.value = st.fontFamily;
        this.syncFontSizeSelect(st.size);
      } else if (this.currentApp === 'sheets' && this.ritz) {
        st = this.ritz.cells[this.ritz.getActiveCoord()] || {};
      }

      set('tbBold', st.bold);
      set('tbItalic', st.italic);
      set('tbUnderline', st.underline);
      set('tbStrike', st.strike);
      set('tbAlignLeft', st.align === 'left' || (!st.align && this.currentApp !== 'slides'));
      set('tbAlignCenter', st.align === 'center');
      set('tbAlignRight', st.align === 'right');
      set('tbCurrency', st.numFormat === 'currency');
      set('tbPercent', st.numFormat === 'percent');
      set('tbBulletList', st.listType === 'bullet');
      set('tbNumberedList', st.listType === 'numbered');
      set('tbChecklist', st.listType === 'checklist');
      // Tombol paritas khusus Sheets (id berbeda agar grup tidak bertabrakan).
      set('tbSheetBold', st.bold);
      set('tbSheetItalic', st.italic);
      set('tbSheetStrike', st.strike);
      set('tbSheetAlignLeft', st.align === 'left' || (!st.align && this.currentApp === 'sheets'));
      set('tbSheetAlignCenter', st.align === 'center');
      set('tbSheetAlignRight', st.align === 'right');

      // Dropdown gaya paragraf + spasi baris mencerminkan baris aktif (Docs).
      const styleSel = document.getElementById('tbParagraphStyle');
      if (styleSel && this.currentApp === 'docs') {
        styleSel.value = st.heading || 'normal';
      }
      const spacingSel = document.getElementById('tbLineSpacing');
      if (spacingSel && this.currentApp === 'docs' && st.spacing) {
        spacingSel.value = String(st.spacing);
      }

      const colorDot = document.getElementById('tbColorDot');
      if (colorDot && st.color) colorDot.style.background = st.color;
      const bgDot = document.getElementById('tbBgDot');
      if (bgDot && st.bg) bgDot.style.background = st.bg;
    }

    // Aksi toolbar yang sadar-konteks: Docs -> Kix, Sheets -> Ritz, Slides -> Punch.
    toolbarAction(kind, value) {
      if (kind === 'pageNumbers' && this.kix) {
        this.kix.togglePageNumbers();
        this.showToast(this.kix.showPageNumbers ? 'Nomor halaman diaktifkan.' : 'Nomor halaman dinonaktifkan.');
        return;
      }
      this.applyFormatForActive(kind, value);
    }

    initToolbarBindings() {
      const bind = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
      };

      // --- Docs ---
      bind('tbBold', () => this.applyFormatForActive('bold'));
      bind('tbItalic', () => this.applyFormatForActive('italic'));
      bind('tbUnderline', () => this.applyFormatForActive('underline'));
      bind('tbStrike', () => this.applyFormatForActive('strike'));
      bind('tbAlignLeft', () => this.applyFormatForActive('align', 'left'));
      bind('tbAlignCenter', () => this.applyFormatForActive('align', 'center'));
      bind('tbAlignRight', () => this.applyFormatForActive('align', 'right'));
      bind('tbCurrency', () => this.applyFormatForActive('numFormat', 'currency'));
      bind('tbPercent', () => this.applyFormatForActive('numFormat', 'percent'));

      bind('tbColor', () => this.applyFormatForActive('color', '#ea4335'));
      bind('tbBg', () => this.applyFormatForActive('bg', '#fef7e0'));

      // --- Docs: paritas toolbar (gaya paragraf, daftar, indentasi, spasi) ---
      const styleSel = document.getElementById('tbParagraphStyle');
      if (styleSel) styleSel.addEventListener('change', () => {
        if (this.kix) { this.kix.applyParagraphStyle(styleSel.value); this.syncToolbar(); }
      });
      bind('tbBulletList', () => { if (this.kix) { this.kix.applyList('bullet'); this.syncToolbar(); } });
      bind('tbNumberedList', () => { if (this.kix) { this.kix.applyList('numbered'); this.syncToolbar(); } });
      bind('tbChecklist', () => { if (this.kix) { this.kix.applyList('checklist'); this.syncToolbar(); } });
      bind('tbCheckAll', () => {
        if (!this.kix) return;
        const line = this.kix.activeLineRef();
        // Baris ceklis: tombol membalik status baris aktif. Baris lain:
        // centang semua butir ceklis di halaman (paritas List options).
        if (line && line.listType === 'checklist') {
          this.kix.toggleChecklistAt(this.kix.activePageIdx, this.kix.activeLineIdx);
          this.showToast('Status butir ceklis dibalik.');
        } else {
          const n = this.kix.setAllChecked(true);
          this.showToast(n ? `${n} butir ceklis ditandai selesai.` : 'Tidak ada butir ceklis di halaman ini.');
        }
        this.syncToolbar();
      });
      bind('tbIndentInc', () => { if (this.kix) { this.kix.changeIndent(1); this.syncToolbar(); } });
      bind('tbIndentDec', () => { if (this.kix) { this.kix.changeIndent(-1); this.syncToolbar(); } });
      bind('tbClearFormat', () => { if (this.kix) { this.kix.clearFormatting(); this.syncToolbar(); } });
      const spSel = document.getElementById('tbLineSpacing');
      if (spSel) spSel.addEventListener('change', () => {
        if (this.kix) { this.kix.changeSpacing(parseFloat(spSel.value)); this.syncToolbar(); }
      });

      // --- Sheets: tombol paritas ---
      const sheetFmt = (prop, val) => { if (this.ritz) { this.ritz.applyFormat(prop, val); this.syncToolbar(); } };
      bind('tbSheetBold', () => sheetFmt('bold', 'toggle'));
      bind('tbSheetItalic', () => sheetFmt('italic', 'toggle'));
      bind('tbSheetStrike', () => sheetFmt('strike', 'toggle'));
      bind('tbSheetAlignLeft', () => sheetFmt('align', 'left'));
      bind('tbSheetAlignCenter', () => sheetFmt('align', 'center'));
      bind('tbSheetAlignRight', () => sheetFmt('align', 'right'));
      bind('tbSheetBg', () => sheetFmt('bg', '#fef7e0'));
      bind('tbDecInc', () => {
        if (!this.ritz) return;
        const cur = (this.ritz.decimals || 2);
        this.ritz.decimals = Math.min(6, cur + 1);
        this.ritz.render();
      });
      bind('tbDecDec', () => {
        if (!this.ritz) return;
        const cur = (this.ritz.decimals || 2);
        this.ritz.decimals = Math.max(0, cur - 1);
        this.ritz.render();
      });
      const sumSel = document.getElementById('tbSheetSum');
      if (sumSel) sumSel.addEventListener('change', () => {
        const fn = sumSel.value;
        if (!fn) return;
        this.insertQuickFunction(fn);
        sumSel.value = '';
      });

      const fam = document.getElementById('tbFontFamily');
      if (fam) fam.addEventListener('change', () => this.applyFormatForActive('fontFamily', fam.value));
      const sz = document.getElementById('tbFontSize');
      if (sz) sz.addEventListener('change', () => this.applyFormatForActive('size', parseInt(sz.value, 10)));

      // --- Slides ---
      bind('tbInsertRect', () => { if (this.punch) this.punch.insertShape('rect'); });
      bind('tbInsertCircle', () => { if (this.punch) this.punch.insertShape('circle'); });
      bind('tbInsertLine', () => { if (this.punch) this.punch.insertShape('line'); });
      bind('tbInsertText', () => { if (this.punch) this.punch.insertTextElement(); });

      // --- Sheets: bagan (SVG murni) + urutkan ---
      bind('tbInsertChart', () => {
        if (!this.ritz) return;
        const built = this.ritz.insertChart('column');
        this.showToast(built && built.count
          ? `Bagan dibuat dari ${built.count} nilai pada kolom ${this.ritz.colLabel(this.ritz.activeCol)}.`
          : `Tidak ada angka pada kolom ${this.ritz.colLabel(this.ritz.activeCol)} untuk dijadikan bagan.`);
      });
      bind('tbRemoveChart', () => { if (this.ritz) { this.ritz.removeChart(); this.showToast('Bagan dihapus.'); } });
      bind('tbSortAsc', () => {
        if (!this.ritz) return;
        const r = this.ritz.sortRange('asc');
        this.showToast(r.moved > 1 ? `Kolom ${r.col} diurutkan menaik (${r.moved} nilai).` : `Tidak cukup data pada kolom ${r.col} untuk diurutkan.`);
      });
      bind('tbSortDesc', () => {
        if (!this.ritz) return;
        const r = this.ritz.sortRange('desc');
        this.showToast(r.moved > 1 ? `Kolom ${r.col} diurutkan menurun (${r.moved} nilai).` : `Tidak cukup data pada kolom ${r.col} untuk diurutkan.`);
      });

      // --- Slides: tata letak + tema ---
      const layoutSel = document.getElementById('tbSlideLayout');
      if (layoutSel) layoutSel.addEventListener('change', () => {
        if (!this.punch) return;
        this.punch.applyLayout(layoutSel.value);
        this.showToast(`Tata letak "${layoutSel.options[layoutSel.selectedIndex].text}" diterapkan.`);
      });
      const themeSel = document.getElementById('tbSlideTheme');
      if (themeSel) themeSel.addEventListener('change', () => {
        if (!this.punch) return;
        this.punch.applyTheme(themeSel.value);
        this.showToast(`Tema "${themeSel.options[themeSel.selectedIndex].text}" diterapkan ke seluruh slide.`);
      });

      bind('tbDuplicateSlide', () => {
        if (this.punch) {
          this.punch.duplicateActiveSlide();
          this.showToast('Slide diduplikasi.');
        }
      });
      bind('tbDeleteSlide', () => {
        if (this.punch) {
          const ok = this.punch.deleteActiveSlide();
          if (ok) this.showToast('Slide dihapus.');
        }
      });
      // Urut-ulang slide (paritas "Move slide"): geser slide aktif di filmstrip.
      bind('tbSlideUp', () => {
        if (!this.punch) return;
        const at = this.punch.activeSlideIdx;
        const to = this.punch.moveSlide(-1);
        if (to >= 0) this.showToast(`Slide dipindah ke posisi ${to + 1}.`);
        else this.showToast(at === 0 ? 'Slide sudah di paling atas.' : 'Slide tidak dapat dipindah.');
      });
      bind('tbSlideDown', () => {
        if (!this.punch) return;
        const to = this.punch.moveSlide(1);
        if (to >= 0) this.showToast(`Slide dipindah ke posisi ${to + 1}.`);
        else this.showToast('Slide sudah di paling bawah.');
      });

      // --- Sheets: tombol kalkulasi wajib ter-bind, jika tidak formula bar
      //     yang diketik user tidak pernah dikomit ke sel aktif.
      bind('sheetCalcBtn', async () => {
        if (this.ritz) {
          await this.ritz.commitFormulaBar();
          this.showToast('Sel ' + this.ritz.getActiveCoord() + ' dihitung ulang.');
        }
      });

      // --- Slides: catatan pembicara ---
      bind('tbSpeakerNotes', () => this.toggleSpeakerNotes());

      // --- Slides: urut-ulang tumpukan elemen (paritas "Urutkan" Google Slides).
      //     Beda dengan tbSlideUp/tbSlideDown yang menggeser SLIDE di filmstrip,
      //     dua tombol ini menggeser ELEMEN di dalam slide aktif.
      bind('tbBringFront', () => {
        if (!this.punch) return;
        const ok = this.punch.bringToFront();
        this.showToast(ok ? 'Elemen dibawa ke depan.' : 'Pilih elemen terlebih dahulu.');
      });
      bind('tbSendBack', () => {
        if (!this.punch) return;
        const ok = this.punch.sendToBack();
        this.showToast(ok ? 'Elemen dikirim ke belakang.' : 'Pilih elemen terlebih dahulu.');
      });

      // --- Shell global ---
      bind('tbUndo', () => this.performUndo(this.currentApp));
      bind('tbRedo', () => this.performRedo(this.currentApp));
      bind('tbPrint', () => window.print());
      bind('tbPresent', () => { if (this.punch) this.punch.startPresentationMode(); });
      bind('tbWordCount', () => this.openWordCountModal());
      bind('tbComment', () => {
      if (this.currentApp === 'docs') this.openCommentModal();
      else if (this.currentApp === 'sheets') this.openSheetCommentModal();
    });
      bind('tbShortcuts', () => this.openShortcutsModal());

      // --- Zoom (global, <select> → event 'change', bukan 'click') ---
      const zoomSel = document.getElementById('tbZoom');
      if (zoomSel) zoomSel.addEventListener('change', () => this.setZoom(zoomSel.value));
    }

    // Menerapkan zoom tampilan. Dipakai lewat CSS variable --app-zoom supaya
    // elemen yang di-render ulang (halaman Kix dibangun kembali tiap render)
    // tetap ikut ter-zoom tanpa perlu di-apply manual satu per satu.
    setZoom(value) {
      let scale = 1;
      if (value === 'Fit') {
        const view = document.getElementById(`view-${this.currentApp}`);
        const w = view ? view.clientWidth : 0;
        // Lebar acuan: halaman Docs 816px, grid Sheets bebas, slide 960px.
        const base = this.currentApp === 'slides' ? 960 : (this.currentApp === 'docs' ? 816 : 0);
        scale = (w > 0 && base > 0) ? Math.min(1, (w - 48) / base) : 1;
      } else {
        const n = parseFloat(value);
        scale = Number.isFinite(n) ? n / 100 : 1;
      }

      this.zoomLevel = scale;
      // Editor membaca nilai ini untuk mengompensasi hit-testing pointer:
      // tanpa kompensasi, klik pada dokumen ter-zoom mendarat di sel/baris salah.
      window.__appZoom = scale;
      document.documentElement.style.setProperty('--app-zoom', String(scale));

      // Kanvas Sheets tidak ikut CSS zoom pada bitmap-nya, jadi render ulang
      // agar ukuran bitmap menyesuaikan ruang yang tersedia.
      if (this.currentApp === 'sheets' && this.ritz) this.ritz.render();
      if (this.currentApp === 'slides' && this.punch) this.punch.render();
    }

    applyFormatForActive(prop, value) {
      const app = this.currentApp;
      if (app === 'docs' && this.kix) {
        // ==== JALUR SELEKSI RENTANG (paritas Google Docs) ====
        // Bila user menyorot teks, format diterapkan HANYA pada rentang itu
        // (run-level). Tanpa cabang ini, klik Bold selalu memformat SATU BARIS
        // PENUH — perilaku yang salah dan membuat run-level tak pernah terpakai.
        if (typeof this.kix.hasSelection === 'function' && this.kix.hasSelection()) {
          // Nilai efektif untuk properti boolean: kebalikan dari run pertama
          // pada rentang, supaya klik pada teks campuran tetap terasa "toggle".
          let eff = value;
          if (eff === undefined) {
            const cur = this.kix.getActiveFormatting()[prop];
            eff = !cur;
          }
          if (this.kix.applyFormatToSelection(prop, eff)) {
            this.syncToolbar();
            return;
          }
        }
        if (value === undefined) this.kix.toggleFormatting(prop);
        else this.kix.applyFormatting(prop, value);
      } else if (app === 'sheets' && this.ritz) {
        this.ritz.applyFormat(prop, value === undefined ? 'toggle' : value);
      } else if (app === 'slides' && this.punch) {
        if (prop === 'color') this.punch.updateSelectedColor(value);
      }
      this.syncToolbar();
    }

    // Sisipkan fungsi cepat (Σ) ke sel aktif, dengan rentang data terdekat di
    // atasnya — perilaku menu "Fungsi cepat" Google Sheets.
    insertQuickFunction(fnName) {
      if (!this.ritz) return;
      const coord = this.ritz.getActiveCoord();
      const m = coord.match(/^([A-Z]+)(\d+)$/);
      if (!m) return;
      const col = m[1];
      const row = parseInt(m[2], 10);

      // Telusuri ke atas dari baris aktif untuk menemukan rentang angka.
      let endRow = row - 1;
      while (endRow >= 1 && !this.ritz.cells[`${col}${endRow}`]) endRow--;
      if (endRow < 1) {
        this.showToast('Tidak ada data ' + col + ' di atas sel untuk dihitung.');
        return;
      }
      let startRow = endRow;
      while (startRow > 1 && this.ritz.cells[`${col}${startRow - 1}`]) startRow--;

      const formula = `=${fnName}(${col}${startRow}:${col}${endRow})`;
      this.ritz.commitCoordValue(coord, formula);
      this.showToast(`Fungsi ${fnName} disisipkan: ${formula}`);
    }

    // ==== CATATAN PEMBICARA (Slides) ====
    toggleSpeakerNotes() {
      const panel = document.getElementById('speakerNotesPanel');
      const input = document.getElementById('speakerNotesInput');
      if (!panel || !input || !this.punch) return;

      const willShow = panel.style.display === 'none';
      panel.style.display = willShow ? 'block' : 'none';

      if (willShow) {
        input.value = this.punch.getSpeakerNotes();
        input.focus();
        // Simpan saat user berhenti mengetik — tidak perlu tombol simpan.
        if (!input._boundNotes) {
          input._boundNotes = true;
          let t = null;
          input.addEventListener('input', () => {
            if (t) clearTimeout(t);
            t = setTimeout(() => {
              if (this.punch) this.punch.setSpeakerNotes(input.value);
            }, 400);
          });
          // Panah di dalam textarea tidak boleh ikut membajak navigasi slide.
          input.addEventListener('keydown', (ev) => ev.stopPropagation());
        }
      }
    }

    // ================= AUTOSAVE =================
    // ID dokumen ditangkap SAAT PENJADWALAN, bukan saat flush. Tanpa ini,
    // berpindah dokumen di dalam jendela debounce membuat payload dokumen lama
    // tertulis ke dokumen baru (menyebabkan korupsi lintas-tipe di store).
    // Simpan payload tertunda + ID-nya supaya flush benar-benar bisa menulis.
    // Dulu flushPendingSave() HANYA clearTimeout tanpa mengirim apa pun, jadi
    // berpindah dokumen / reload di dalam jendela debounce = KEHILANGAN DATA.
    triggerAutosave(payload) {
      const targetId = this.currentDocId;
      this.updateSaveStatus('Menyimpan...');
      // Gabungkan dengan payload tertunda untuk dokumen yang sama, agar
      // perubahan judul tidak menimpa perubahan data yang belum terkirim.
      const prev = (this.pendingSave && this.pendingSave.targetId === targetId)
        ? this.pendingSave.payload : {};
      this.pendingSave = { targetId, payload: { ...prev, ...payload } };
      if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = setTimeout(async () => {
        this.saveDebounceTimer = null;
        const p = this.pendingSave;
        this.pendingSave = null;
        if (!p || p.targetId !== this.currentDocId) return; // dokumen berganti -> batalkan
        await this.saveDocument(p.payload, p.targetId);
      }, 600);
    }

    // Tulis SEKARANG setiap perubahan yang masih tertunda. Dipanggil sebelum
    // berpindah dokumen (await) dan sebelum reload/tutup tab (keepalive).
    async flushPendingSave(keepalive = false) {
      if (this.saveDebounceTimer) {
        clearTimeout(this.saveDebounceTimer);
        this.saveDebounceTimer = null;
      }
      const p = this.pendingSave;
      if (!p) return;
      this.pendingSave = null;
      // targetId ditulis eksplisit: dokumen lama tetap tersimpan walau
      // currentDocId sudah/akan berganti.
      await this.saveDocument(p.payload, p.targetId, { keepalive });
    }

    async saveDocument(payload, id, opts = {}) {
      const docId = id || this.currentDocId;
      if (!docId) return;
      try {
        const res = await fetch(`/api/documents/${docId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          // keepalive WAJIB saat dipanggil dari beforeunload/pagehide:
          // tanpa ini Chrome membatalkan request saat halaman dibongkar.
          keepalive: !!opts.keepalive
        });
        if (res.ok) {
          if (docId === this.currentDocId) this.updateSaveStatus('Semua perubahan disimpan ke Drive');
        } else {
          this.updateSaveStatus('Gagal menyimpan');
        }
      } catch (err) {
        this.updateSaveStatus('Gagal menyimpan');
      }
    }

    updateSaveStatus(msg) {
      const el = document.getElementById('saveStatusIndicator');
      if (el) {
        const isSaving = msg === 'Menyimpan...';
        el.innerHTML = isSaving
          ? `<svg class="spin-icon" style="animation: spin 1s linear infinite;" width="14" height="14" viewBox="0 0 24 24" fill="#5f6368"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg> <span>Menyimpan...</span>`
          : `<svg width="14" height="14" viewBox="0 0 24 24" fill="#5f6368"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM10 17l-3.5-3.5 1.41-1.41L10 14.17l5.59-5.59L17 10l-7 7z"/></svg> <span>${msg}</span>`;
      }
    }

    // ================= TOP BAR & KEYBOARD =================
    initTopBarActions() {
      const titleInput = document.getElementById('docTitle');
      if (titleInput) {
        titleInput.addEventListener('change', () => {
          const newTitle = titleInput.value.trim() || 'Tanpa Judul';
          this.triggerAutosave({ title: newTitle });
          this.loadDocumentList();
        });
      }

      const shareBtn = document.getElementById('shareModalBtn');
      if (shareBtn) {
        shareBtn.addEventListener('click', () => this.openShareModal());
      }
    }

    // Tulis perubahan tertunda sebelum halaman ditinggalkan/di-reload.
    // `fetch(..., { keepalive: true })` dipakai karena request tanpa keepalive
    // DIBATALKAN Chrome saat dokumen dibongkar -> suntingan terakhir hilang.
    initUnloadFlush() {
      const flush = () => { this.flushPendingSave(true); };
      window.addEventListener('pagehide', flush);
      window.addEventListener('beforeunload', flush);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
      });
    }

    initKeyboardShortcuts() {
      window.addEventListener('keydown', (e) => {
        const tag = (e.target && e.target.tagName) || '';
        const inField = tag === 'INPUT' || tag === 'TEXTAREA';
        // Kix menangkap ketikan lewat hiddenInput (TEXTAREA), jadi `inField`
        // SELALU true saat user mengetik di dokumen. Guard Ctrl+F/Ctrl+H tidak
        // boleh memakai `inField` — kalau iya, shortcut mati tepat di konteks
        // yang paling dibutuhkan. Yang harus dikecualikan hanyalah kolom di
        // dalam modal pencarian itu sendiri (agar tidak membuka modal berulang).
        const inModalField = !!(e.target && e.target.closest && e.target.closest('#gwsModal'));

        // Ctrl+Shift+C: Dialog Jumlah Kata (paritas Google Docs)
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'C' || e.key === 'c') && this.currentApp === 'docs' && this.kix) {
          e.preventDefault();
          this.openWordCountModal();
          return;
        }

        if (e.key === 'Escape') {
          this.closeAllMenus();
          if (this._modalResolver) {
            // Wrapper modal (confirm/prompt/alert). Nilai batal diambil dari
            // _modalCancelValue milik modal yang sedang terbuka, supaya Escape
            // dan tombol Batal tidak menyerahkan nilai berbeda. Tanpa resolve
            // ini `await` menggantung selamanya, karena closeModal() hanya
            // mengeset display:none tanpa menyelesaikan Promise.
            this._resolveModal(this._modalCancelValue);
            return;
          }
          // Modal Bagikan memakai elemen sendiri (#gwsShareModal), bukan
          // #gwsModal. Tanpa cabang ini Escape tidak menutupnya sama sekali.
          const sm = document.getElementById('gwsShareModal');
          if (sm && sm.style.display !== 'none') {
            this.closeShareModal();
            return;
          }
          // JANGAN sembunyikan langsung: closeModal() yang melepas fokus.
          // Modal komentar Docs/Sheets dibuka lewat ensureModal(), BUKAN
          // wrapper confirm/prompt/alert, jadi tidak punya _modalResolver
          // dan Escape mendarat di sini. Raw hide di titik ini membuat
          // activeElement tertinggal di dalam modal tersembunyi -> guard
          // inModalField (:1027) mematikan SEMUA pintasan.
          this.closeModal();
          return;
        }

        if (!e.ctrlKey && !e.metaKey) {
          if (e.key === 'F5') {
            e.preventDefault();
            if (this.punch) this.punch.startPresentationMode();
          }
          return;
        }

        const k = e.key.toLowerCase();
        if (k === 'b' && this.currentApp === 'docs') {
          e.preventDefault();
          this.applyFormatForActive('bold');
        } else if (k === 'i' && this.currentApp === 'docs') {
          e.preventDefault();
          this.applyFormatForActive('italic');
        } else if (k === 'u' && this.currentApp === 'docs') {
          e.preventDefault();
          this.applyFormatForActive('underline');
        } else if (k === 'z') {
          e.preventDefault();
          this.performUndo(this.currentApp);
        } else if (k === 'y') {
          e.preventDefault();
          this.performRedo(this.currentApp);
        } else if (k === 'p') {
          e.preventDefault();
          window.print();
        } else if (k === 'f' && this.currentApp === 'docs' && !inModalField) {
          // Find: paritas Google Docs (Ctrl+F). Hanya diblokir bila fokus sudah
          // di dalam modal pencarian (mencegah modal dibuka ulang dari dirinya).
          e.preventDefault();
          this.openFindReplaceModal(false);
        } else if (k === 'h' && this.currentApp === 'docs' && !inModalField) {
          // Find and Replace: paritas Google Docs (Ctrl+H).
          e.preventDefault();
          this.openFindReplaceModal(true);
        } else if (k === 'k' && this.currentApp === 'docs' && !inModalField) {
          // Sisipkan/Edit tautan: paritas Google Docs (Ctrl+K). Guard WAJIB
          // `!inModalField` (bukan `!inField`) — hiddenInput Kix adalah TEXTAREA,
          // jadi `inField` selalu true saat user mengetik di dokumen dan shortcut
          // akan mati tepat di konteks yang paling dibutuhkan.
          e.preventDefault();
          this.openLinkModal();
        } else if (k === 'm' && e.altKey && (this.currentApp === 'docs' || this.currentApp === 'sheets') && !inModalField) {
          // Komentar: paritas Google Docs/Sheets (Ctrl+Alt+M). Guard !inModalField
          // (bukan !inField) — hiddenInput Kix adalah TEXTAREA, jadi inField
          // selalu true saat mengetik di dokumen.
          //
          // RUTE WAJIB per aplikasi: openCommentModal() adalah modal KHUSUS Docs
          // dan langsung menolak bila currentApp !== 'docs'. Memanggilnya di
          // Sheets berarti pintasan tampak terpasang tetapi tidak pernah membuka
          // apa pun (hanya toast penolakan).
          e.preventDefault();
          if (this.currentApp === 'sheets') this.openSheetCommentModal();
          else this.openCommentModal();
        } else if (k === 's') {
          e.preventDefault();
          this.saveDocument({ title: document.getElementById('docTitle')?.value });
          this.showToast('Dokumen disimpan.');
        } else if (k === 'n' && !inField) {
          e.preventDefault();
          this.createNewDoc(this.currentApp === 'drive' ? 'docs' : this.currentApp);
        }
      });
    }

    // ================= MENU BAR =================
    initMenuDropdowns() {
      const menuItems = document.querySelectorAll('.menu-item');
      menuItems.forEach(item => {
        item.addEventListener('mousedown', (e) => e.stopPropagation());
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const menuName = item.getAttribute('data-menu');
          this.toggleMenu(menuName, item);
        });
      });

      // Tutup menu pada `mousedown`, BUKAN `click`: handler mousedown editor
      // (Kix canvas / Punch stage) mengganti node DOM, sehingga event `click`
      // tidak pernah lahir di area dokumen dan menu akan tetap terbuka.
      window.addEventListener('mousedown', () => this.closeAllMenus());
    }

    toggleMenu(menuName, targetEl) {
      const existing = document.getElementById('activeMenuDropdown');
      if (existing) {
        const isSame = existing.getAttribute('data-for') === menuName;
        existing.remove();
        if (isSame) return;
      }

      const rect = targetEl.getBoundingClientRect();
      const dropdown = document.createElement('div');
      dropdown.id = 'activeMenuDropdown';
      dropdown.setAttribute('data-for', menuName);
      dropdown.style.cssText = `position: fixed; top: ${rect.bottom + 4}px; left: ${rect.left}px; background: #fff; border: 1px solid #dadce0; border-radius: 6px; box-shadow: 0 4px 12px rgba(60,64,67,0.25); min-width: 250px; z-index: 10000; padding: 6px 0; font-size: 13px; color: #202124;`;

      const options = this.getMenuItems(menuName);
      options.forEach(opt => {
        if (opt.sep) {
          const sep = document.createElement('div');
          sep.style.cssText = 'height: 1px; background: #ebebeb; margin: 4px 0;';
          dropdown.appendChild(sep);
        } else {
          const row = document.createElement('div');
          row.className = 'menu-option';
          row.setAttribute('data-label', opt.label);
          row.style.cssText = 'padding: 7px 16px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; gap: 24px;';
          row.innerHTML = `<span>${escapeXml(opt.label)}</span><span style="font-size: 11px; color: #70757a;">${escapeXml(opt.shortcut || '')}</span>`;
          row.onmouseenter = () => row.style.background = '#f1f3f4';
          row.onmouseleave = () => row.style.background = '#fff';
          // Tahan mousedown agar listener global (penutup dropdown) tidak
          // menghapus elemen ini sebelum event `click` sempat lahir.
          row.addEventListener('mousedown', (ev) => ev.stopPropagation());
          row.onclick = () => {
            dropdown.remove();
            if (typeof opt.action === 'function') opt.action();
          };
          dropdown.appendChild(row);
        }
      });

      document.body.appendChild(dropdown);
    }

    closeAllMenus() {
      const existing = document.getElementById('activeMenuDropdown');
      if (existing) existing.remove();
    }

    getMenuItems(menu) {
      if (menu === 'file') {
        return [
          { label: 'Dokumen Baru', shortcut: 'Ctrl+N', action: () => this.createNewDoc('docs') },
          { label: 'Spreadsheet Baru', action: () => this.createNewDoc('sheets') },
          { label: 'Presentasi Baru', action: () => this.createNewDoc('slides') },
          { sep: true },
          { label: 'Buka Drive Hub', action: () => this.switchApp('drive') },
          { label: 'Buat Salinan (Make a copy)', action: () => this.duplicateDoc(this.currentDocId) },
          { sep: true },
          { label: 'Unduh Dokumen (.txt)', action: () => this.downloadCurrentDoc('txt') },
          { label: 'Unduh Spreadsheet (.csv)', action: () => this.downloadCurrentDoc('csv') },
          { label: 'Unduh Slide (.svg)', action: () => this.downloadCurrentDoc('svg') },
          { label: 'Unduh Data (.json)', action: () => this.downloadCurrentDoc('json') },
          { sep: true },
          { label: 'Cetak / Print', shortcut: 'Ctrl+P', action: () => this.printOrExportPdf() }
        ];
      }
      if (menu === 'edit') {
        return [
          { label: 'Undo', shortcut: 'Ctrl+Z', action: () => this.performUndo(this.currentApp) },
          { label: 'Redo', shortcut: 'Ctrl+Y', action: () => this.performRedo(this.currentApp) },
          { sep: true },
          { label: 'Pilih Semua (Select All)', shortcut: 'Ctrl+A', action: () => this.selectAll() },
          { sep: true },
          // ==== FIND & REPLACE (paritas Google Docs: Edit > Cari dan ganti) ====
          { label: 'Cari (Find)', shortcut: 'Ctrl+F', action: () => this.openFindReplaceModal(false) },
          { label: 'Cari dan Ganti (Find and Replace)', shortcut: 'Ctrl+H', action: () => this.openFindReplaceModal(true) },
          { sep: true },
          { label: 'Hapus Elemen Terpilih (Slides)', shortcut: 'Delete', action: () => { if (this.punch) this.punch.deleteSelectedElement(); } }
        ];
      }
      if (menu === 'view') {
        const fz = this.ritz ? { rows: this.ritz.frozenRows || 0, cols: this.ritz.frozenCols || 0 } : { rows: 0, cols: 0 };
        return [
          { label: 'Mode Presentasi Slideshow', shortcut: 'F5', action: () => { if (this.punch) this.punch.startPresentationMode(); } },
          { label: 'Layar Penuh (Fullscreen)', shortcut: 'F11', action: () => this.toggleFullscreen() },
          { sep: true },
          // ==== FREEZE PANE (paritas Google Sheets: menu Tampilan > Bekukan) ====
          // Item yang statusnya sudah aktif ditandai centang agar user tahu posisi.
          { label: `${fz.rows === 1 ? '✓ ' : ''}Bekukan 1 baris (Sheets)`, action: () => { if (this.ritz) { this.ritz.setFrozen(1, this.ritz.frozenCols); this.syncToolbar(); } } },
          { label: `${fz.rows === 2 ? '✓ ' : ''}Bekukan 2 baris (Sheets)`, action: () => { if (this.ritz) { this.ritz.setFrozen(2, this.ritz.frozenCols); this.syncToolbar(); } } },
          { label: `${fz.cols === 1 ? '✓ ' : ''}Bekukan 1 kolom (Sheets)`, action: () => { if (this.ritz) { this.ritz.setFrozen(this.ritz.frozenRows, 1); this.syncToolbar(); } } },
          { label: `${(fz.rows === 0 && fz.cols === 0) ? '✓ ' : ''}Tidak ada panel beku (Sheets)`, action: () => { if (this.ritz) { this.ritz.setFrozen(0, 0); this.syncToolbar(); } } },
          { sep: true },
          { label: 'Tampilkan/Sembunyikan Telemetry Drawer', action: () => window.toggleTelemetry() },
          { label: 'Buka Drive Hub', action: () => this.switchApp('drive') }
        ];
      }
      if (menu === 'insert') {
        return [
          { label: 'Tambah Halaman Baru (Docs)', action: () => { if (this.kix) this.kix.insertNewPage(); } },
          { label: 'Pemisah Halaman (Docs)', shortcut: 'Ctrl+Enter', action: () => { if (this.kix) this.kix.insertPageBreak(); } },
          { label: 'Tautan (Docs)', shortcut: 'Ctrl+K', action: () => this.openLinkModal() },
          { label: 'Nomor Halaman (Docs)', action: () => this.toolbarAction('pageNumbers') },
          { label: 'Header & Footer (Docs)', action: () => this.openHeaderFooterModal() },
          { sep: true },
          { label: 'Tabel (Docs)', action: () => this.openInsertTableModal() },
          { label: 'Gambar (Docs)', action: () => this.openInsertImageModal() },
          { label: 'Ukuran Gambar (Docs)', action: () => this.openImageSizeModal() },
          { label: 'Gambar Rata Kiri (Docs)', action: () => this.setImageAlign('left') },
          { label: 'Gambar Rata Tengah (Docs)', action: () => this.setImageAlign('center') },
          { label: 'Gambar Rata Kanan (Docs)', action: () => this.setImageAlign('right') },
          { sep: true },
          { label: 'Tabel: Sisip Baris di Atas', action: () => this.tableOp('rowAbove') },
          { label: 'Tabel: Sisip Baris di Bawah', action: () => this.tableOp('rowBelow') },
          { label: 'Tabel: Hapus Baris', action: () => this.tableOp('rowDelete') },
          { label: 'Tabel: Sisip Kolom di Kiri', action: () => this.tableOp('colLeft') },
          { label: 'Tabel: Sisip Kolom di Kanan', action: () => this.tableOp('colRight') },
          { label: 'Tabel: Hapus Kolom', action: () => this.tableOp('colDelete') },
          { sep: true },
          { label: 'Penyiapan Halaman (Docs)', action: () => this.openPageSetupModal() },
          { label: 'Komentar', shortcut: 'Ctrl+Alt+M', action: () => { if (this.currentApp === 'sheets') this.openSheetCommentModal(); else this.openCommentModal(); } },
          { sep: true },
          { label: 'Tambah Slide Baru (Slides)', action: () => { if (this.punch) this.punch.addNewSlide(); } },
          { label: 'Duplikat Slide Aktif (Slides)', action: () => { if (this.punch) this.punch.duplicateActiveSlide(); } },
          { label: 'Hapus Slide Aktif (Slides)', action: () => { if (this.punch) this.punch.deleteActiveSlide(); } },
          { sep: true },
          { label: 'Sisipkan Kotak (Slides)', action: () => { if (this.punch) this.punch.insertShape('rect'); } },
          { label: 'Sisipkan Lingkaran (Slides)', action: () => { if (this.punch) this.punch.insertShape('circle'); } },
          { label: 'Sisipkan Garis (Slides)', action: () => { if (this.punch) this.punch.insertShape('line'); } },
          { label: 'Sisipkan Teks (Slides)', action: () => { if (this.punch) this.punch.insertTextElement(); } }
        ];
      }
      if (menu === 'format') {
        return [
          { label: 'Tebal (Bold)', shortcut: 'Ctrl+B', action: () => this.applyFormatForActive('bold') },
          { label: 'Miring (Italic)', shortcut: 'Ctrl+I', action: () => this.applyFormatForActive('italic') },
          { label: 'Garis Bawah (Underline)', shortcut: 'Ctrl+U', action: () => this.applyFormatForActive('underline') },
          { label: 'Coret (Strikethrough)', action: () => this.applyFormatForActive('strike') },
          { sep: true },
          { label: 'Rata Kiri', action: () => this.applyFormatForActive('align', 'left') },
          { label: 'Rata Tengah', action: () => this.applyFormatForActive('align', 'center') },
          { label: 'Rata Kanan', action: () => this.applyFormatForActive('align', 'right') },
          { sep: true },
          { label: 'Format Mata Uang ($)', action: () => this.applyFormatForActive('numFormat', 'currency') },
          { label: 'Format Persen (%)', action: () => this.applyFormatForActive('numFormat', 'percent') },
          { label: 'Hapus Format Angka', action: () => this.applyFormatForActive('numFormat', 'plain') }
        ];
      }
      if (menu === 'tools') {
        return [
          { label: 'Penghitung Kata (Word Count)', action: () => this.openWordCountModal() },
          { label: 'Uji Soft-404 Engine', action: () => { window.toggleTelemetry(); } },
          { sep: true },
          { label: 'Ekspor CSV Spreadsheet', action: () => this.downloadCurrentDoc('csv') },
          { label: 'Ekspor Slide ke SVG', action: () => this.downloadCurrentDoc('svg') }
        ];
      }
      if (menu === 'help') {
        return [
          { label: 'Pintasan Keyboard (Shortcuts)', action: () => this.openShortcutsModal() },
          { label: 'Tentang Workspace Ini', action: () => this.openAboutModal() }
        ];
      }
      return [{ label: 'Fitur standar aktif', action: () => {} }];
    }

    selectAll() {
      if (this.currentApp === 'docs' && this.kix && this.kix.hiddenInput) {
        this.kix.hiddenInput.focus();
        this.kix.hiddenInput.select();
      }
      this.showToast('Semua konten dipilih (Ctrl+A).');
    }

    toggleFullscreen() {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen();
      }
    }

    // ================= UNDUHAN =================
    saveBlob(content, filename, mime) {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      return filename;
    }

    downloadCurrentDoc(format) {
      const doc = this.documents.find(d => d.id === this.currentDocId);
      const title = doc ? doc.title : 'dokumen';
      const type = this.currentApp === 'drive' ? (doc ? doc.type : 'docs') : this.currentApp;
      let content = '';
      let ext = format || 'json';
      let mime = 'application/json';

      if (format === 'txt') {
        content = (type === 'docs' && this.kix) ? this.kix.exportPlainText() : JSON.stringify(this.editorData(type), null, 2);
        mime = 'text/plain; charset=utf-8';
      } else if (format === 'csv') {
        if (type === 'sheets' && this.ritz) content = this.ritz.exportCsv();
        else content = JSON.stringify(this.editorData(type), null, 2);
        mime = 'text/csv; charset=utf-8';
      } else if (format === 'svg') {
        if (type === 'slides' && this.punch) content = this.punch.exportSvg();
        else content = JSON.stringify(this.editorData(type), null, 2);
        mime = 'image/svg+xml; charset=utf-8';
      } else {
        ext = 'json';
        content = JSON.stringify(this.editorData(type), null, 2);
      }

      if (!content) {
        this.showToast('Tidak ada konten untuk diekspor pada dokumen ini.');
        return;
      }

      this.saveBlob(content, `${title}.${ext}`, mime);
      this.showToast(`File ${title}.${ext} berhasil diunduh.`);
    }

    editorData(type) {
      if (type === 'docs' && this.kix) return this.kix.getDocumentData();
      if (type === 'sheets' && this.ritz) {
        // sheets[] = sumber kebenaran (semua tab). cells/charts sheet aktif tetap
        // dikirim untuk kompatibilitas mundur dengan pembaca format lama.
        return {
          cells: this.ritz.getCells(),
          charts: this.ritz.getCharts(),
          sheets: this.ritz.getSheets(),
          activeSheetIdx: this.ritz.activeSheetIdx
        };
      }
      if (type === 'slides' && this.punch) return { slides: this.punch.getSlides() };
      const doc = this.documents.find(d => d.id === this.currentDocId);
      return doc || {};
    }

    // ================= MODALS =================
    // Satu-satunya pintu keluar modal berbasis Promise. Semua handler
    // (OK / Batal / silang / backdrop / Escape) lewat sini supaya:
    //   - resolver SELALU dibersihkan -> tidak ada Promise yatim,
    //   - handler yang terpanggil dua kali (mis. Enter lalu Escape) tidak
    //     melempar TypeError karena memanggil resolver yang sudah null,
    //   - Escape memakai nilai batal yang sama dengan tombol Batal.
    // Catatan arsitektur: ensureModal() mengembalikan SATU elemen #gwsModal
    // bersama, jadi dua modal tidak bisa tampil bersamaan — modal kedua
    // menimpa innerHTML modal pertama. Karena itu tidak ada stack resolver
    // di sini; yang dijaga adalah kebersihan resolver tunggal ini.
    _resolveModal(val) {
      const r = this._modalResolver;
      this._modalResolver = null;
      this._modalCancelValue = null;
      this.closeModal();
      if (typeof r === 'function') r(val);
      return true;
    }

    ensureModal() {
      let modal = document.getElementById('gwsModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'gwsModal';
        modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.5); z-index: 100000; display: flex; align-items: center; justify-content: center;';
        document.body.appendChild(modal);
      }
      return modal;
    }

    closeModal() {
      const modal = document.getElementById('gwsModal');
      if (modal) {
        // Lepas fokus SEBELUM menyembunyikan modal.
        //
        // Tanpa ini document.activeElement tetap menunjuk tombol/textarea di
        // dalam #gwsModal yang kini display:none. Guard `inModalField`
        // (initKeyboardShortcuts, :1027) memakai e.target.closest('#gwsModal'),
        // sehingga SELURUH pintasan (Ctrl+F, Ctrl+K, Ctrl+Alt+M, ...) tetap
        // dianggap "sedang di dalam modal" dan MATI setelah modal ditutup.
        // Gejalanya membingungkan: tombol toolbar jalan, pintasan tidak.
        const ae = document.activeElement;
        if (ae && modal.contains(ae) && typeof ae.blur === 'function') ae.blur();
        modal.style.display = 'none';
        modal.onclick = null;
      }
    }

    // Modal Bagikan (#gwsShareModal) adalah elemen TERPISAH dari #gwsModal.
    // closeModal() TIDAK menjangkaunya, jadi ia butuh jalur tutupnya sendiri.
    // Sebelum ini Escape tidak menutupnya sama sekali dan tombol x memakai
    // onclick mentah tanpa melepas fokus: jalan keluar hanya lewat klik.
    closeShareModal() {
      const m = document.getElementById('gwsShareModal');
      if (!m) return;
      const ae = document.activeElement;
      if (ae && m.contains(ae) && typeof ae.blur === 'function') ae.blur();
      m.style.display = 'none';
    }

    // ============== MODAL DIALOG WRAPPERS (Promise-based) ==============
    // Menggantikan dialog native prompt()/confirm()/alert() yang memblokir
    // event loop dan merusak otomasi CDP/E2E. Semua mengembalikan Promise
    // dan dibangun di atas ensureModal() yang sudah dipakai modal lain.
    // Escape (handler global initKeyboardShortcuts) menyelesaikan Promise
    // dengan nilai batal: false untuk confirm, null untuk prompt.

    confirmModal({ title = 'Konfirmasi', message = '', confirmText = 'OK', cancelText = 'Batal', danger = false } = {}) {
      return new Promise(resolve => {
        if (this._modalResolver) this._resolveModal(this._modalCancelValue);
        const modal = this.ensureModal();
        const btnColor = danger ? '#ea4335' : '#1a73e8';
        modal.innerHTML = `
          <div style="background: #fff; width: 420px; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.25); padding: 24px; font-family: 'Google Sans', Arial, sans-serif;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
              <h3 style="font-size: 18px; font-weight: 500; color: #202124;">${escapeXml(title)}</h3>
              <span class="modal-close" style="cursor: pointer; font-size: 20px; color: #5f6368;">✕</span>
            </div>
            <p style="font-size: 14px; color: #3c4043; line-height: 1.5; margin: 0 0 24px;">${escapeXml(message)}</p>
            <div style="text-align: right; display: flex; gap: 8px; justify-content: flex-end;">
              <button class="modal-cancel" style="padding: 8px 20px; background: #fff; color: #1a73e8; border: 1px solid #dadce0; border-radius: 20px; font-size: 13px; font-weight: 500; cursor: pointer;">${escapeXml(cancelText)}</button>
              <button class="modal-ok" style="padding: 8px 20px; background: ${btnColor}; color: #fff; border: none; border-radius: 20px; font-size: 13px; font-weight: 500; cursor: pointer;">${escapeXml(confirmText)}</button>
            </div>
          </div>`;
        modal.style.display = 'flex';
        this._modalCancelValue = false;
        this._modalResolver = (val) => { this._modalResolver = null; this.closeModal(); resolve(val); };
        modal.querySelector('.modal-ok').addEventListener('click', () => this._resolveModal(true));
        modal.querySelector('.modal-cancel').addEventListener('click', () => this._resolveModal(false));
        modal.querySelector('.modal-close').addEventListener('click', () => this._resolveModal(false));
        modal.onclick = (e) => { if (e.target === modal) this._resolveModal(false); };
      });
    }

    promptModal({ title = 'Input', message = '', defaultValue = '', placeholder = '', confirmText = 'OK', cancelText = 'Batal' } = {}) {
      return new Promise(resolve => {
        if (this._modalResolver) this._resolveModal(this._modalCancelValue);
        const modal = this.ensureModal();
        modal.innerHTML = `
          <div style="background: #fff; width: 420px; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.25); padding: 24px; font-family: 'Google Sans', Arial, sans-serif;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
              <h3 style="font-size: 18px; font-weight: 500; color: #202124;">${escapeXml(title)}</h3>
              <span class="modal-close" style="cursor: pointer; font-size: 20px; color: #5f6368;">✕</span>
            </div>
            <p style="font-size: 14px; color: #3c4043; line-height: 1.5; margin: 0 0 12px;">${escapeXml(message)}</p>
            <input type="text" class="modal-input" value="${escapeXml(defaultValue)}" placeholder="${escapeXml(placeholder)}" autocomplete="off"
              style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #dadce0; border-radius: 8px; font-size: 14px; font-family: inherit; outline: none; margin-bottom: 24px;" />
            <div style="text-align: right; display: flex; gap: 8px; justify-content: flex-end;">
              <button class="modal-cancel" style="padding: 8px 20px; background: #fff; color: #1a73e8; border: 1px solid #dadce0; border-radius: 20px; font-size: 13px; font-weight: 500; cursor: pointer;">${escapeXml(cancelText)}</button>
              <button class="modal-ok" style="padding: 8px 20px; background: #1a73e8; color: #fff; border: none; border-radius: 20px; font-size: 13px; font-weight: 500; cursor: pointer;">${escapeXml(confirmText)}</button>
            </div>
          </div>`;
        modal.style.display = 'flex';
        const input = modal.querySelector('.modal-input');
        input.focus();
        input.select();
        this._modalCancelValue = null;
        this._modalResolver = (val) => { this._modalResolver = null; this.closeModal(); resolve(val); };
        modal.querySelector('.modal-ok').addEventListener('click', () => this._resolveModal(input.value));
        modal.querySelector('.modal-cancel').addEventListener('click', () => this._resolveModal(null));
        modal.querySelector('.modal-close').addEventListener('click', () => this._resolveModal(null));
        modal.onclick = (e) => { if (e.target === modal) this._resolveModal(null); };
        input.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') { ev.preventDefault(); this._resolveModal(input.value); }
          if (ev.key === 'Escape') { ev.preventDefault(); this._resolveModal(null); }
        });
      });
    }

    alertModal({ title = 'Pemberitahuan', message = '', okText = 'OK' } = {}) {
      return new Promise(resolve => {
        if (this._modalResolver) this._resolveModal(this._modalCancelValue);
        const modal = this.ensureModal();
        modal.innerHTML = `
          <div style="background: #fff; width: 420px; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.25); padding: 24px; font-family: 'Google Sans', Arial, sans-serif;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
              <h3 style="font-size: 18px; font-weight: 500; color: #202124;">${escapeXml(title)}</h3>
              <span class="modal-close" style="cursor: pointer; font-size: 20px; color: #5f6368;">✕</span>
            </div>
            <p style="font-size: 14px; color: #3c4043; line-height: 1.5; margin: 0 0 24px;">${escapeXml(message)}</p>
            <div style="text-align: right;">
              <button class="modal-ok" style="padding: 8px 20px; background: #1a73e8; color: #fff; border: none; border-radius: 20px; font-size: 13px; font-weight: 500; cursor: pointer;">${escapeXml(okText)}</button>
            </div>
          </div>`;
        modal.style.display = 'flex';
        this._modalCancelValue = undefined;
        this._modalResolver = (val) => { this._modalResolver = null; this.closeModal(); resolve(val); };
        modal.querySelector('.modal-ok').addEventListener('click', () => this._resolveModal());
        modal.querySelector('.modal-close').addEventListener('click', () => this._resolveModal());
        modal.onclick = (e) => { if (e.target === modal) this._resolveModal(); };
      });
    }


    // ==== SISIPKAN: TABEL / GAMBAR / PENYIAPAN HALAMAN / CETAK (paritas Google Docs) ====
    // Semua dialog di bawah memakai promptModal()/alertModal() yang SUDAH ada, supaya
    // tidak lahir sistem modal kedua — itu penyebab bug duplikat openWordCountModal dulu.
    async openInsertTableModal() {
      if (!this.kix || this.currentApp !== 'docs') return;
      const val = await this.promptModal({
        title: 'Sisipkan Tabel',
        message: 'Ukuran tabel dalam format baris x kolom, contoh: 3x4',
        defaultValue: '3x4',
        confirmText: 'Sisipkan'
      });
      if (val === null || val === undefined) return;
      const m = String(val).trim().match(/^(\d{1,2})\s*[x\u00d7]\s*(\d{1,2})$/i);
      if (!m) {
        return this.alertModal({ title: 'Format tidak valid', message: 'Gunakan format baris x kolom, contoh: 3x4' });
      }
      const rows = Math.max(1, Math.min(50, parseInt(m[1], 10)));
      const cols = Math.max(1, Math.min(12, parseInt(m[2], 10)));
      this.kix.insertTable(rows, cols);
      this.showToast('Tabel ' + rows + 'x' + cols + ' disisipkan.');
    }

    async openInsertImageModal() {
      if (!this.kix || this.currentApp !== 'docs') return;
      const url = await this.promptModal({
        title: 'Sisipkan Gambar',
        message: 'Masukkan URL gambar (http/https atau data:image/...)',
        defaultValue: '',
        placeholder: 'https://...',
        confirmText: 'Sisipkan'
      });
      if (url === null || url === undefined) return;
      const clean = String(url).trim();
      if (!clean) return;
      // Validasi skema sejalan dengan sanitizeUrl() di engine: hanya http/https dan
      // data:image yang lolos, sehingga javascript:/vbscript:/file: tidak pernah masuk.
      if (!/^(https?:\/\/|data:image\/)/i.test(clean)) {
        return this.alertModal({ title: 'URL tidak diizinkan', message: 'Gunakan URL http/https atau data:image/...' });
      }
      this.kix.insertImage(clean);
      this.showToast('Gambar disisipkan.');
    }

    // ==== GAMBAR: UKURAN & PERATAAN ====
    // Engine sudah punya resizeActiveImage()/setActiveImageAlign(), tetapi
    // tanpa pintu ini keduanya KODE MATI: user tak bisa mengubah gambar
    // setelah disisipkan. Kelas celah yang sama dengan Tabel/Gambar dulu.
    async openImageSizeModal() {
      if (!this.kix || this.currentApp !== 'docs') return;
      const val = await this.promptModal({
        title: 'Ukuran Gambar',
        message: 'Lebar gambar dalam piksel. Tinggi mengikuti proporsi asli gambar.',
        defaultValue: '240',
        confirmText: 'Terapkan'
      });
      if (val === null || val === undefined) return;
      const w = parseInt(String(val).trim(), 10);
      if (!w || w < 8) {
        return this.alertModal({ title: 'Lebar tidak valid', message: 'Masukkan angka minimal 8.' });
      }
      if (!this.kix.resizeActiveImage(w)) {
        return this.alertModal({ title: 'Tidak ada gambar aktif', message: 'Klik gambarnya dulu, lalu ulangi.' });
      }
      this.showToast('Lebar gambar: ' + w + 'px');
    }

    setImageAlign(align) {
      if (!this.kix || this.currentApp !== 'docs') return;
      if (!this.kix.setActiveImageAlign(align)) {
        return this.alertModal({ title: 'Tidak ada gambar aktif', message: 'Klik gambarnya dulu, lalu ulangi.' });
      }
      this.showToast('Gambar rata ' + align + '.');
    }

    // ==== TABEL: STRUKTUR BARIS & KOLOM ====
    // Tabel sebelumnya hanya bisa DIBUAT, tidak bisa diubah. Satu pintu
    // untuk enam operasi agar menu tidak menumpuk enam method serupa.
    tableOp(op) {
      if (!this.kix || this.currentApp !== 'docs') return;
      const map = {
        rowAbove: () => this.kix.insertTableRow('above'),
        rowBelow: () => this.kix.insertTableRow('below'),
        rowDelete: () => this.kix.deleteTableRow(),
        colLeft: () => this.kix.insertTableColumn('left'),
        colRight: () => this.kix.insertTableColumn('right'),
        colDelete: () => this.kix.deleteTableColumn()
      };
      const fn = map[op];
      if (!fn) return;
      if (!fn()) {
        return this.alertModal({
          title: 'Tidak bisa dijalankan',
          message: 'Letakkan kursor di dalam sel tabel. Tabel selalu menyisakan minimal satu baris dan satu kolom.'
        });
      }
      this.showToast('Tabel diperbarui.');
    }

    // ==== HEADER & FOOTER (paritas Docs: Sisipkan > Header & footer) ====
    // Dua promptModal berurutan, BUKAN sistem modal kedua: promptModal sudah
    // menangani Escape, fokus, dan pelepasan fokus di closeModal(). Membangun
    // modal tandingan di sini persis akar bug duplikat openWordCountModal dulu.
    //
    // Tiap langkah diterapkan SEGERA, sehingga membatalkan prompt footer tidak
    // ikut membatalkan perubahan header yang sudah dikonfirmasi.
    async openHeaderFooterModal() {
      if (!this.kix || this.currentApp !== 'docs') return;
      const cur = this.kix.getHeaderFooter();

      const header = await this.promptModal({
        title: 'Header',
        message: 'Teks header diulang pada setiap halaman. Kosongkan untuk menghapus.',
        defaultValue: cur.header
      });
      if (header === null) return;
      this.kix.setHeaderFooter({ header });

      const footer = await this.promptModal({
        title: 'Footer',
        message: 'Teks footer diulang pada setiap halaman. Kosongkan untuk menghapus.',
        defaultValue: cur.footer
      });
      if (footer === null) { this.showToast('Header diperbarui.'); return; }
      this.kix.setHeaderFooter({ footer });
      this.showToast('Header & footer diperbarui.');
    }

    async openPageSetupModal() {
      if (!this.kix || this.currentApp !== 'docs') return;
      const cur = this.kix.getPageSetup();
      const val = await this.promptModal({
        title: 'Penyiapan Halaman',
        message: 'Ukuran kertas: kix | a4 | letter | legal. Tambahkan -l untuk lanskap, contoh: a4-l',
        defaultValue: cur.paperSize + (cur.orientation === 'landscape' ? '-l' : ''),
        confirmText: 'Terapkan'
      });
      if (val === null || val === undefined) return;
      const raw = String(val).trim().toLowerCase();
      if (!raw) return;
      const landscape = /-l(andscape)?$/.test(raw);
      const paper = raw.replace(/-l(andscape)?$/, '');
      if (['kix', 'a4', 'letter', 'legal'].indexOf(paper) === -1) {
        return this.alertModal({ title: 'Ukuran tidak dikenal', message: 'Pilih salah satu: kix, a4, letter, legal (boleh diakhiri -l untuk lanskap).' });
      }
      this.kix.setPageSetup({ paperSize: paper, orientation: landscape ? 'landscape' : 'portrait' });
      this.showToast('Penyiapan halaman: ' + paper + (landscape ? ' lanskap' : ' potret'));
    }

    printOrExportPdf() {
      if (this.currentApp !== 'docs' || !this.kix) { window.print(); return; }
      // Canvas tidak ikut alur cetak browser secara otomatis. Setiap halaman Kix
      // dirasterisasi ke <img> lalu ditulis ke jendela cetak — jalur yang sama
      // dipakai untuk "ekspor PDF" lewat dialog cetak (Save as PDF).
      // Virtualisasi tile hanya mencat halaman di sekitar viewport. Tanpa
      // renderAllForce(), halaman yang jauh masih kanvas KOSONG dan
      // toDataURL() menghasilkan PDF berisi halaman kosong. Ini regresi
      // fungsional yang tidak tertangkap tes lama mana pun.
      if (typeof this.kix.renderAllForce === 'function') this.kix.renderAllForce();
      const canvases = document.querySelectorAll('.kix-page-paginated canvas, .kix-page canvas');
      if (!canvases.length) { window.print(); return; }
      const win = window.open('', '_blank');
      if (!win) { this.showToast('Popup diblokir - izinkan popup untuk mencetak.'); return; }
      let html = '<!DOCTYPE html><html><head><title>Cetak Dokumen</title>';
      html += '<style>@page{margin:0}body{margin:0;background:#fff}img{display:block;width:100%;page-break-after:always}</style>';
      html += '</head><body>';
      for (let i = 0; i < canvases.length; i++) {
        html += '<img src="' + canvases[i].toDataURL('image/png') + '" />';
      }
      html += '</body></html>';
      // Kembalikan jendela render normal setelah seluruh rasterisasi selesai.
      // Data gambar sudah tersalin menjadi string HTML, jadi kanvas di luar
      // jendela boleh dilepas lagi agar memori tidak membengkak.
      if (typeof this.kix.updateRenderWindow === 'function') {
        this.kix.updateRenderWindow(false, this.kix.activePageIdx);
      }
      win.document.open();
      win.document.write(html);
      win.document.close();
      win.focus();
      setTimeout(() => win.print(), 300);
    }

    openWordCountModal() {
      const modal = this.ensureModal();
      let words = 0, chars = 0, pages = 0;
      if (this.kix && this.currentApp === 'docs') {
        const stats = this.kix.getStatistics ? this.kix.getStatistics() : null;
        if (stats) {
          words = stats.words;
          chars = stats.characters;
          pages = stats.pages;
        } else {
          words = this.kix.calculateWordCount();
          pages = this.kix.pages.length;
          for (const p of this.kix.pages) for (const l of p.lines) chars += (l.text || '').length;
        }
      } else if (this.ritz) {
        for (const c of Object.values(this.ritz.cells)) chars += String(c.val === undefined ? '' : c.val).length;
      } else if (this.punch) {
        for (const s of this.punch.slides) for (const el of s.elements) chars += (el.text || '').length;
      }

      modal.innerHTML = `
        <div style="background: #fff; width: 420px; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.25); padding: 24px; font-family: 'Google Sans', Arial, sans-serif;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <h3 style="font-size: 18px; font-weight: 500; color: #202124;">Penghitung Kata</h3>
            <span class="modal-close" style="cursor: pointer; font-size: 20px; color: #5f6368;">✕</span>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div style="background: #f8f9fa; border-radius: 8px; padding: 14px;">
              <div style="font-size: 24px; font-weight: 600; color: #1a73e8;">${words}</div>
              <div style="font-size: 12px; color: #5f6368;">Kata</div>
            </div>
            <div style="background: #f8f9fa; border-radius: 8px; padding: 14px;">
              <div style="font-size: 24px; font-weight: 600; color: #0f9d58;">${chars}</div>
              <div style="font-size: 12px; color: #5f6368;">Karakter</div>
            </div>
            <div style="background: #f8f9fa; border-radius: 8px; padding: 14px;">
              <div style="font-size: 24px; font-weight: 600; color: #f29900;">${pages}</div>
              <div style="font-size: 12px; color: #5f6368;">Halaman</div>
            </div>
            <div style="background: #f8f9fa; border-radius: 8px; padding: 14px;">
              <div style="font-size: 24px; font-weight: 600; color: #202124;">${this.currentApp.toUpperCase()}</div>
              <div style="font-size: 12px; color: #5f6368;">Editor Aktif</div>
            </div>
          </div>
          <div style="text-align: right; margin-top: 18px;">
            <button class="modal-close" style="padding: 8px 20px; background: #1a73e8; color: #fff; border: none; border-radius: 20px; font-size: 13px; font-weight: 500; cursor: pointer;">Tutup</button>
          </div>
        </div>
      `;
      modal.style.display = 'flex';
      modal.querySelectorAll('.modal-close').forEach(el => el.addEventListener('click', () => this.closeModal()));
    }

    openShortcutsModal() {
      const modal = this.ensureModal();
      const rows = [
        ['Ctrl + B', 'Tebal (Bold)'],
        ['Ctrl + I', 'Miring (Italic)'],
        ['Ctrl + U', 'Garis bawah (Underline)'],
        ['Ctrl + Z / Ctrl + Y', 'Undo / Redo'],
        ['Ctrl + S', 'Simpan paksa'],
        ['Ctrl + N', 'Dokumen baru'],
        ['Ctrl + P', 'Cetak'],
        ['Ctrl + A', 'Pilih semua'],
        ['Enter / Backspace', 'Baris baru / hapus karakter (Docs)'],
        ['Arrow keys', 'Navigasi kursor / sel'],
        ['Delete', 'Hapus elemen terpilih (Slides)'],
        ['F5', 'Mulai presentasi (Slides)'],
        ['Esc', 'Tutup dialog / keluar presentasi'],
        ['Ctrl + Alt + M', 'Tambah / sunting komentar (Docs)'],
        ['Double-click', 'Sunting teks (Docs / Slides)']
      ];
      modal.innerHTML = `
        <div style="background: #fff; width: 520px; max-height: 80vh; overflow-y: auto; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.25); padding: 24px; font-family: 'Google Sans', Arial, sans-serif;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <h3 style="font-size: 18px; font-weight: 500; color: #202124;">Pintasan Keyboard</h3>
            <span class="modal-close" style="cursor: pointer; font-size: 20px; color: #5f6368;">✕</span>
          </div>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            ${rows.map(r => `<tr style="border-bottom: 1px solid #ebebeb;">
              <td style="padding: 8px 0; color: #5f6368; width: 45%;"><code style="background: #f1f3f4; padding: 2px 6px; border-radius: 4px;">${escapeXml(r[0])}</code></td>
              <td style="padding: 8px 0; color: #202124;">${escapeXml(r[1])}</td>
            </tr>`).join('')}
          </table>
          <div style="text-align: right; margin-top: 18px;">
            <button class="modal-close" style="padding: 8px 20px; background: #1a73e8; color: #fff; border: none; border-radius: 20px; font-size: 13px; font-weight: 500; cursor: pointer;">Tutup</button>
          </div>
        </div>
      `;
      modal.style.display = 'flex';
      modal.querySelectorAll('.modal-close').forEach(el => el.addEventListener('click', () => this.closeModal()));
    }

    // ==== FIND & REPLACE (Docs) ====
    // Mengikuti pola ensureModal() yang sudah dipakai modal lain. Kolom input
    // menghentikan propagasi keydown supaya ketikan TIDAK ikut masuk ke
    // hiddenInput Kix (dokumen digambar ke canvas, bukan DOM teks).
    openFindReplaceModal(withReplace) {
      if (!this.kix || this.currentApp !== 'docs') {
        this.showToast('Cari & Ganti hanya tersedia di Docs.');
        return;
      }
      const modal = this.ensureModal();
      const btn = 'padding:7px 14px; border:1px solid #dadce0; background:#fff; color:#1a73e8; border-radius:6px; font-size:12.5px; font-weight:500; cursor:pointer;';
      const btnP = 'padding:7px 14px; border:none; background:#1a73e8; color:#fff; border-radius:6px; font-size:12.5px; font-weight:500; cursor:pointer;';

      modal.innerHTML = `
        <div style="background:#fff; width:470px; border-radius:12px; box-shadow:0 8px 32px rgba(0,0,0,.25); padding:20px; font-family:'Google Sans',Arial,sans-serif;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
            <h3 style="font-size:17px; font-weight:500; color:#202124; margin:0;">${withReplace ? 'Cari dan Ganti' : 'Cari'}</h3>
            <span class="modal-close" style="cursor:pointer; font-size:20px; color:#5f6368;">✕</span>
          </div>
          <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
            <input id="gwsFindInput" type="text" placeholder="Cari teks..." autocomplete="off"
              style="flex:1; min-width:0; padding:8px 10px; border:1px solid #dadce0; border-radius:6px; font-size:13px; outline:none;">
            <span id="gwsFindCount" style="font-size:12px; color:#5f6368; min-width:70px; text-align:right;">0 hasil</span>
          </div>
          ${withReplace ? `
          <div style="margin-bottom:10px;">
            <input id="gwsReplaceInput" type="text" placeholder="Ganti dengan..." autocomplete="off"
              style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #dadce0; border-radius:6px; font-size:13px; outline:none;">
          </div>` : ''}
          <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#5f6368; margin-bottom:16px; cursor:pointer;">
            <input id="gwsFindCase" type="checkbox"> Bedakan huruf besar/kecil
          </label>
          <div style="display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap;">
            <button id="gwsFindPrev" style="${btn}">Sebelumnya</button>
            <button id="gwsFindNext" style="${btn}">Berikutnya</button>
            ${withReplace ? `
            <button id="gwsReplaceOne" style="${btnP}">Ganti</button>
            <button id="gwsReplaceAll" style="${btnP}">Ganti Semua</button>` : ''}
            <button class="modal-close" style="${btn}">Tutup</button>
          </div>
        </div>
      `;
      modal.style.display = 'flex';

      const qEl = modal.querySelector('#gwsFindInput');
      const cEl = modal.querySelector('#gwsFindCase');
      const nEl = modal.querySelector('#gwsFindCount');
      const rEl = modal.querySelector('#gwsReplaceInput');

      const refresh = () => {
        const n = this.kix.findMatches.length;
        if (!n) { nEl.textContent = qEl.value ? '0 hasil' : ''; return; }
        nEl.textContent = `${this.kix.findActiveIdx + 1} dari ${n}`;
      };

      const runSearch = () => {
        this.kix.setFindQuery(qEl.value, { matchCase: cEl.checked });
        refresh();
      };

      qEl.addEventListener('keydown', (ev) => {
        ev.stopPropagation(); // jangan bocor ke dokumen
        if (ev.key === 'Enter') { ev.preventDefault(); this.kix.findNext(); refresh(); }
        if (ev.key === 'Escape') { ev.preventDefault(); this.closeModal(); this.kix.clearFind(); }
      });
      qEl.addEventListener('input', runSearch);
      cEl.addEventListener('change', runSearch);

      if (rEl) {
        rEl.addEventListener('keydown', (ev) => ev.stopPropagation());
        rEl.addEventListener('keydown', (ev) => {
          if (ev.key === 'Escape') { ev.preventDefault(); this.closeModal(); this.kix.clearFind(); }
        });
      }

      modal.querySelectorAll('.modal-close').forEach(el => el.addEventListener('click', () => {
        this.closeModal();
        this.kix.clearFind(); // buang highlight agar dokumen kembali bersih
      }));

      const prevB = modal.querySelector('#gwsFindPrev');
      const nextB = modal.querySelector('#gwsFindNext');
      if (prevB) prevB.addEventListener('click', () => { this.kix.findPrev(); refresh(); });
      if (nextB) nextB.addEventListener('click', () => { this.kix.findNext(); refresh(); });

      const oneB = modal.querySelector('#gwsReplaceOne');
      if (oneB) oneB.addEventListener('click', () => {
        if (!this.kix.findMatches.length) { runSearch(); return; }
        this.kix.replaceCurrent(rEl ? rEl.value : '');
        refresh();
        this.showToast('1 kemunculan diganti.');
      });

      const allB = modal.querySelector('#gwsReplaceAll');
      if (allB) allB.addEventListener('click', () => {
        if (!this.kix.findMatches.length) runSearch();
        const n = this.kix.replaceAll(rEl ? rEl.value : '');
        refresh();
        this.showToast(n ? `${n} kemunculan diganti.` : 'Tidak ada yang diganti.');
      });

      if (qEl) { qEl.focus(); qEl.select(); }
    }

    // ==== MODAL TAUTAN (Docs) ====
    // Kix TIDAK punya API seleksi rentang (hanya cursorCharIdx), jadi modal ini
    // menawarkan dua kolom: teks yang ditautkan + URL. Bila kursor berada di
    // tautan yang sudah ada, kolom terisi otomatis dan tombol Hapus muncul.
    openLinkModal() {
      if (!this.kix || this.currentApp !== 'docs') {
        this.showToast('Tautan hanya tersedia di Docs.');
        return;
      }
      const modal = this.ensureModal();
      const btn = 'padding:7px 14px; border:1px solid #dadce0; background:#fff; color:#1a73e8; border-radius:6px; font-size:12.5px; font-weight:500; cursor:pointer;';
      const btnP = 'padding:7px 14px; border:none; background:#1a73e8; color:#fff; border-radius:6px; font-size:12.5px; font-weight:500; cursor:pointer;';
      const btnD = 'padding:7px 14px; border:1px solid #dadce0; background:#fff; color:#d93025; border-radius:6px; font-size:12.5px; font-weight:500; cursor:pointer;';

      const existing = this.kix.getLinkNearCursor();
      const line = this.kix.activeLineRef();
      const word = this.kix.wordRangeAtCursor();
      const defText = existing
        ? (line.text || '').slice(existing.start, existing.end)
        : (word ? word.text : '');
      const defUrl = existing ? existing.url : 'https://';

      modal.innerHTML = `
        <div style="background:#fff; width:470px; border-radius:12px; box-shadow:0 8px 32px rgba(0,0,0,.25); padding:20px; font-family:'Google Sans',Arial,sans-serif;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
            <h3 style="font-size:17px; font-weight:500; color:#202124; margin:0;">${existing ? 'Edit Tautan' : 'Sisipkan Tautan'}</h3>
            <span class="modal-close" style="cursor:pointer; font-size:20px; color:#5f6368;">✕</span>
          </div>
          <label style="display:block; font-size:12px; color:#5f6368; margin-bottom:4px;">Teks</label>
          <input id="gwsLinkText" type="text" placeholder="Teks yang ditampilkan" autocomplete="off" value="${defText.replace(/"/g, '&quot;')}"
            style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #dadce0; border-radius:6px; font-size:13px; outline:none; margin-bottom:12px;">
          <label style="display:block; font-size:12px; color:#5f6368; margin-bottom:4px;">Tautan (URL)</label>
          <input id="gwsLinkUrl" type="text" placeholder="https://example.com" autocomplete="off" value="${String(defUrl).replace(/"/g, '&quot;')}"
            style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #dadce0; border-radius:6px; font-size:13px; outline:none;">
          <div id="gwsLinkErr" style="font-size:12px; color:#d93025; margin-top:8px; min-height:16px;"></div>
          <div style="display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; margin-top:6px;">
            ${existing ? `<button id="gwsLinkRemove" style="${btnD}">Hapus Tautan</button>` : ''}
            <button class="modal-close" style="${btn}">Batal</button>
            <button id="gwsLinkApply" style="${btnP}">Terapkan</button>
          </div>
        </div>
      `;
      modal.style.display = 'flex';

      const tEl = modal.querySelector('#gwsLinkText');
      const uEl = modal.querySelector('#gwsLinkUrl');
      const errEl = modal.querySelector('#gwsLinkErr');
      modal.querySelectorAll('.modal-close').forEach(el => el.addEventListener('click', () => this.closeModal()));

      // Ketikan di modal TIDAK boleh bocor ke hiddenInput Kix (dokumen digambar
      // ke canvas, jadi setiap karakter yang lolos akan menulis ke dokumen).
      [tEl, uEl].forEach(el => {
        if (!el) return;
        el.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Escape') { ev.preventDefault(); this.closeModal(); }
          if (ev.key === 'Enter') { ev.preventDefault(); apply(); }
        });
      });

      const apply = () => {
        const safe = this.kix.sanitizeUrl(uEl ? uEl.value : '');
        if (!safe) {
          if (errEl) errEl.textContent = 'URL tidak valid. Gunakan http/https, mailto, atau tel.';
          if (uEl) uEl.focus();
          return;
        }
        const txt = tEl ? tEl.value : '';
        const p = this.kix.activePageIdx, l = this.kix.activeLineIdx;
        let ok = false;
        if (existing) {
          const cur = (line.text || '').slice(existing.start, existing.end);
          if (txt && txt !== cur) {
            // Teks tautan diganti: tulis ulang potongan itu, geser offset link
            // lain di baris yang sama, lalu pasang rentang baru.
            line.text = line.text.slice(0, existing.start) + txt + line.text.slice(existing.end);
            this.kix._shiftLinks(line, existing.end, txt.length - cur.length);
            ok = this.kix.setLinkRange(p, l, existing.start, existing.start + txt.length, safe);
          } else {
            ok = this.kix.setLinkRange(p, l, existing.start, existing.end, safe);
          }
        } else {
          ok = this.kix.applyLinkAtCursor(safe, txt);
        }
        if (!ok) { if (errEl) errEl.textContent = 'Tidak ada teks untuk ditautkan di posisi kursor.'; return; }
        this.closeModal();
        this.showToast(existing ? 'Tautan diperbarui.' : 'Tautan disisipkan.');
      };

      const rm = modal.querySelector('#gwsLinkRemove');
      if (rm) rm.addEventListener('click', () => {
        const ok = this.kix.removeLinkRange(this.kix.activePageIdx, this.kix.activeLineIdx, existing.start, existing.end);
        this.closeModal();
        this.showToast(ok ? 'Tautan dihapus (teks tetap).' : 'Tidak ada tautan untuk dihapus.');
      });

      const ap = modal.querySelector('#gwsLinkApply');
      if (ap) ap.addEventListener('click', apply);

      if (tEl) { tEl.focus(); tEl.select(); }
    }

    // ==== KOMENTAR (Docs) ====
    // Meniru arsitektur openLinkModal(): modal dinamis via ensureModal(),
    // stopPropagation pada keydown input/textarea (cegah bocor ke hiddenInput
    // Kix), dan onChange dipicu oleh metode kix_editor (bukan di sini).
    openCommentModal(existing) {
      if (!this.kix || this.currentApp !== 'docs') {
        this.showToast('Komentar hanya tersedia di Docs.');
        return;
      }
      // Jika tidak ada komentar yang diklik, cek apakah kursor berada di
      // dalam komentar yang sudah ada — mirip Google Docs (Ctrl+Alt+M membuka
      // thread yang ada, bukan membuat duplikat).
      if (!existing) {
        existing = this.kix.getCommentNearCursor();
      }
      const modal = this.ensureModal();
      const btn = 'padding:7px 14px; border:1px solid #dadce0; background:#fff; color:#1a73e8; border-radius:6px; font-size:12.5px; font-weight:500; cursor:pointer;';
      const btnP = 'padding:7px 14px; border:none; background:#1a73e8; color:#fff; border-radius:6px; font-size:12.5px; font-weight:500; cursor:pointer;';
      const btnD = 'padding:7px 14px; border:1px solid #dadce0; background:#fff; color:#d93025; border-radius:6px; font-size:12.5px; font-weight:500; cursor:pointer;';
      const fmtDate = (iso) => {
        try {
          const d = new Date(iso);
          return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' +
                 d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        } catch { return iso || ''; }
      };

      if (!existing) {
        // ==== MODE: KOMENTAR BARU ====
        const word = this.kix.wordRangeAtCursor();
        if (!word) {
          this.showToast('Tempatkan kursor pada teks untuk menambahkan komentar.');
          this.closeModal();
          return;
        }
        modal.innerHTML = `
          <div style="background:#fff; width:470px; border-radius:12px; box-shadow:0 8px 32px rgba(0,0,0,.25); padding:20px; font-family:'Google Sans',Arial,sans-serif;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
              <h3 style="font-size:17px; font-weight:500; color:#202124; margin:0;">Tambah Komentar</h3>
              <span class="modal-close" style="cursor:pointer; font-size:20px; color:#5f6368;">✕</span>
            </div>
            <div style="font-size:12px; color:#5f6368; margin-bottom:8px;">Kata yang dikomentari:</div>
            <div style="background:#fef7e0; border-left:3px solid #f9ab00; padding:8px 12px; border-radius:4px; font-size:13px; color:#202124; margin-bottom:14px;">${escapeXml(word.text || '')}</div>
            <label style="display:block; font-size:12px; color:#5f6368; margin-bottom:4px;">Komentar</label>
            <textarea id="gwsCommentText" rows="3" placeholder="Tulis komentar…" autocomplete="off"
              style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #dadce0; border-radius:6px; font-size:13px; outline:none; resize:vertical; font-family:inherit;"></textarea>
            <div id="gwsCommentErr" style="font-size:12px; color:#d93025; margin-top:8px; min-height:16px;"></div>
            <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:6px;">
              <button class="modal-close" style="${btn}">Batal</button>
              <button id="gwsCommentApply" style="${btnP}">Komentari</button>
            </div>
          </div>
        `;
        modal.style.display = 'flex';
        const tEl = modal.querySelector('#gwsCommentText');
        const errEl = modal.querySelector('#gwsCommentErr');
        modal.querySelectorAll('.modal-close').forEach(el => el.addEventListener('click', () => this.closeModal()));
        // Ketikan di modal TIDAK boleh bocor ke hiddenInput Kix (dokumen
        // digambar ke canvas, jadi karakter yang lolos menulis ke dokumen).
        if (tEl) {
          tEl.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Escape') { ev.preventDefault(); this.closeModal(); }
          });
        }
        const apply = () => {
          const body = tEl ? tEl.value.trim() : '';
          if (!body) { if (errEl) errEl.textContent = 'Komentar tidak boleh kosong.'; return; }
          const ok = this.kix.addCommentAtCursor(body, 'Saya');
          if (!ok) { if (errEl) errEl.textContent = 'Gagal menambahkan komentar di posisi kursor.'; return; }
          this.closeModal();
          this.showToast('Komentar ditambahkan.');
        };
        const ap = modal.querySelector('#gwsCommentApply');
        if (ap) ap.addEventListener('click', apply);
        if (tEl) tEl.focus();
      } else {
        // ==== MODE: LIHAT / BALAS / SELESAIKAN / HAPUS ====
        const c = existing;
        const renderThread = () => {
          const rs = Array.isArray(c.replies) ? c.replies : [];
          const replyHtml = rs.map(r => `
            <div style="margin-top:10px; padding-left:14px; border-left:2px solid #e0e0e0;">
              <div style="font-size:12px; color:#5f6368; margin-bottom:2px;"><strong>${escapeXml(r.author || 'Saya')}</strong> · ${escapeXml(fmtDate(r.createdAt))}</div>
              <div style="font-size:13px; color:#202124; white-space:pre-wrap;">${escapeXml(r.text || '')}</div>
            </div>`).join('');
          const resolvedBadge = c.resolved
            ? '<span style="display:inline-block; padding:2px 8px; background:#e6f4ea; color:#137333; border-radius:10px; font-size:11px; font-weight:500; margin-left:8px;">Selesai</span>'
            : '';
          modal.innerHTML = `
            <div style="background:#fff; width:500px; border-radius:12px; box-shadow:0 8px 32px rgba(0,0,0,.25); padding:20px; font-family:'Google Sans',Arial,sans-serif;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
                <h3 style="font-size:17px; font-weight:500; color:#202124; margin:0;">Komentar${resolvedBadge}</h3>
                <span class="modal-close" style="cursor:pointer; font-size:20px; color:#5f6368;">✕</span>
              </div>
              <div style="font-size:12px; color:#5f6368; margin-bottom:4px;"><strong>${escapeXml(c.author || 'Saya')}</strong> · ${escapeXml(fmtDate(c.createdAt))}</div>
              <div style="font-size:13px; color:#202124; white-space:pre-wrap; background:#f8f9fa; padding:10px 12px; border-radius:6px; margin-bottom:14px;">${escapeXml(c.text || '')}</div>
              ${replyHtml ? `<div style="margin-bottom:14px;">${replyHtml}</div>` : ''}
              <label style="display:block; font-size:12px; color:#5f6368; margin-bottom:4px;">Balas</label>
              <textarea id="gwsReplyText" rows="2" placeholder="Tulis balasan…" autocomplete="off"
                style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #dadce0; border-radius:6px; font-size:13px; outline:none; resize:vertical; font-family:inherit; margin-bottom:8px;"></textarea>
              <div id="gwsReplyErr" style="font-size:12px; color:#d93025; min-height:16px; margin-bottom:6px;"></div>
              <div style="display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap;">
                <button id="gwsCommentDelete" style="${btnD}">Hapus</button>
                <button id="gwsCommentResolve" style="${btn}">${c.resolved ? 'Buka Kembali' : 'Selesaikan'}</button>
                <button class="modal-close" style="${btn}">Tutup</button>
                <button id="gwsReplyApply" style="${btnP}">Balas</button>
              </div>
            </div>
          `;
          modal.style.display = 'flex';
          modal.querySelectorAll('.modal-close').forEach(el => el.addEventListener('click', () => this.closeModal()));
          const rEl = modal.querySelector('#gwsReplyText');
          const rErr = modal.querySelector('#gwsReplyErr');
          if (rEl) {
            rEl.addEventListener('keydown', (ev) => {
              ev.stopPropagation();
              if (ev.key === 'Escape') { ev.preventDefault(); this.closeModal(); }
            });
          }
          const replyBtn = modal.querySelector('#gwsReplyApply');
          if (replyBtn) replyBtn.addEventListener('click', () => {
            const body = rEl ? rEl.value.trim() : '';
            if (!body) { if (rErr) rErr.textContent = 'Balasan tidak boleh kosong.'; return; }
            const ok = this.kix.addReply(c.id, body, 'Saya');
            if (!ok) { if (rErr) rErr.textContent = 'Komentar tidak ditemukan.'; return; }
            this.showToast('Balasan ditambahkan.');
            renderThread();
            const nr = modal.querySelector('#gwsReplyText');
            if (nr) nr.focus();
          });
          const resBtn = modal.querySelector('#gwsCommentResolve');
          if (resBtn) resBtn.addEventListener('click', () => {
            const ok = this.kix.resolveComment(c.id);
            if (!ok) { this.closeModal(); this.showToast('Komentar tidak ditemukan.'); return; }
            this.showToast(c.resolved ? 'Komentar dibuka kembali.' : 'Komentar diselesaikan.');
            renderThread();
          });
          const delBtn = modal.querySelector('#gwsCommentDelete');
          if (delBtn) delBtn.addEventListener('click', () => {
            const ok = this.kix.removeComment(c.id);
            this.closeModal();
            this.showToast(ok ? 'Komentar dihapus.' : 'Komentar tidak ditemukan.');
          });
          if (rEl) rEl.focus();
        };
        renderThread();
      }
    }

    // ==== KOMENTAR SEL (Sheets) ====
    // Meniru openCommentModal() Docs: modal dinamis via ensureModal(),
    // stopPropagation keydown textarea (cegah bocor ke window keydown Ritz
    // yang menulis ke grid), dan mutasi lewat metode ritz_editor (bukan di sini).
    //
    // Perbedaan dari Docs: satu sel bisa punya BANYAK komentar (paritas Sheets),
    // jadi modal menampilkan seluruh thread sel + form tambah komentar baru.
    openSheetCommentModal(coord, existingList) {
      if (!this.ritz || this.currentApp !== 'sheets') {
        this.showToast('Komentar sel hanya tersedia di Sheets.');
        return;
      }
      if (!coord) coord = this.ritz.getActiveCoord();
      const modal = this.ensureModal();
      const btn = 'padding:7px 14px; border:1px solid #dadce0; background:#fff; color:#1a73e8; border-radius:6px; font-size:12.5px; font-weight:500; cursor:pointer;';
      const btnP = 'padding:7px 14px; border:none; background:#1a73e8; color:#fff; border-radius:6px; font-size:12.5px; font-weight:500; cursor:pointer;';
      const btnD = 'padding:7px 14px; border:1px solid #dadce0; background:#fff; color:#d93025; border-radius:6px; font-size:12.5px; font-weight:500; cursor:pointer;';
      const fmtDate = (iso) => {
        try {
          const d = new Date(iso);
          return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' +
                 d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        } catch { return iso || ''; }
      };
      // stopPropagation WAJIB: window.addEventListener('keydown') di ritz_editor.js
      // (:1398) menulis ke grid bila e.target bukan INPUT/TEXTAREA. Modal memakai
      // textarea, jadi technically aman — tetapi stopPropagation adalah sabuk
      // pengaman kedua (defense in depth), persis seperti openCommentModal Docs.
      const guardTextarea = (el) => {
        if (!el) return;
        el.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Escape') { ev.preventDefault(); this.closeModal(); }
        });
      };

      const renderThread = () => {
        const list = this.ritz.getCellComments(coord);
        const commentsHtml = list.map((c) => {
          const rs = Array.isArray(c.replies) ? c.replies : [];
          const replyHtml = rs.map(r => `
            <div style="margin-top:8px; padding-left:14px; border-left:2px solid #e0e0e0;">
              <div style="font-size:12px; color:#5f6368; margin-bottom:2px;"><strong>${escapeXml(r.author || 'Saya')}</strong> · ${escapeXml(fmtDate(r.createdAt))}</div>
              <div style="font-size:13px; color:#202124; white-space:pre-wrap;">${escapeXml(r.text || '')}</div>
            </div>`).join('');
          const resolvedBadge = c.resolved
            ? '<span style="display:inline-block; padding:2px 8px; background:#e6f4ea; color:#137333; border-radius:10px; font-size:11px; font-weight:500; margin-left:8px;">Selesai</span>'
            : '';
          return `
            <div style="background:#f8f9fa; padding:12px 14px; border-radius:8px; margin-bottom:12px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                <div style="font-size:12px; color:#5f6368;"><strong>${escapeXml(c.author || 'Saya')}</strong> · ${escapeXml(fmtDate(c.createdAt))}${resolvedBadge}</div>
                <div style="display:flex; gap:6px;">
                  <button class="sc-resolve" data-id="${escapeXml(c.id)}" style="${btn}">${c.resolved ? 'Buka' : 'Selesai'}</button>
                  <button class="sc-delete" data-id="${escapeXml(c.id)}" style="${btnD}">Hapus</button>
                </div>
              </div>
              <div style="font-size:13px; color:#202124; white-space:pre-wrap; margin-bottom:8px;">${escapeXml(c.text || '')}</div>
              ${replyHtml ? `<div style="margin-bottom:8px;">${replyHtml}</div>` : ''}
              <div style="display:flex; gap:6px; align-items:flex-start;">
                <textarea class="sc-reply-input" data-id="${escapeXml(c.id)}" rows="1" placeholder="Balas…" autocomplete="off"
                  style="flex:1; box-sizing:border-box; padding:6px 8px; border:1px solid #dadce0; border-radius:6px; font-size:12.5px; outline:none; resize:none; font-family:inherit;"></textarea>
                <button class="sc-reply-btn" data-id="${escapeXml(c.id)}" style="${btnP}">Balas</button>
              </div>
            </div>`;
        }).join('');

        const hasComments = list.length > 0;
        modal.innerHTML = `
          <div style="background:#fff; width:520px; max-height:80vh; overflow-y:auto; border-radius:12px; box-shadow:0 8px 32px rgba(0,0,0,.25); padding:20px; font-family:'Google Sans',Arial,sans-serif;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
              <h3 style="font-size:17px; font-weight:500; color:#202124; margin:0;">Komentar Sel ${escapeXml(coord)}</h3>
              <span class="modal-close" style="cursor:pointer; font-size:20px; color:#5f6368;">✕</span>
            </div>
            ${hasComments ? commentsHtml : '<div style="font-size:13px; color:#5f6368; margin-bottom:14px;">Belum ada komentar pada sel ini.</div>'}
            <label style="display:block; font-size:12px; color:#5f6368; margin-bottom:4px;">Tambah Komentar</label>
            <textarea id="gwsSheetCommentText" rows="2" placeholder="Tulis komentar…" autocomplete="off"
              style="width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #dadce0; border-radius:6px; font-size:13px; outline:none; resize:vertical; font-family:inherit; margin-bottom:8px;"></textarea>
            <div id="gwsSheetCommentErr" style="font-size:12px; color:#d93025; min-height:16px; margin-bottom:6px;"></div>
            <div style="display:flex; gap:8px; justify-content:flex-end;">
              <button class="modal-close" style="${btn}">Tutup</button>
              <button id="gwsSheetCommentAdd" style="${btnP}">Komentari</button>
            </div>
          </div>
        `;
        modal.style.display = 'flex';
        modal.querySelectorAll('.modal-close').forEach(el => el.addEventListener('click', () => this.closeModal()));
        guardTextarea(modal.querySelector('#gwsSheetCommentText'));
        modal.querySelectorAll('.sc-reply-input').forEach(el => guardTextarea(el));

        // Tambah komentar baru.
        const addBtn = modal.querySelector('#gwsSheetCommentAdd');
        if (addBtn) addBtn.addEventListener('click', () => {
          const tEl = modal.querySelector('#gwsSheetCommentText');
          const errEl = modal.querySelector('#gwsSheetCommentErr');
          const body = tEl ? tEl.value.trim() : '';
          if (!body) { if (errEl) errEl.textContent = 'Komentar tidak boleh kosong.'; return; }
          this.ritz.addCellComment(coord, body, 'Saya');
          this.showToast('Komentar ditambahkan.');
          renderThread();
          const nt = modal.querySelector('#gwsSheetCommentText');
          if (nt) nt.focus();
        });

        // Reply per komentar.
        modal.querySelectorAll('.sc-reply-btn').forEach(btnEl => {
          btnEl.addEventListener('click', () => {
            const cid = btnEl.getAttribute('data-id');
            const input = modal.querySelector(`.sc-reply-input[data-id="${cid}"]`);
            const body = input ? input.value.trim() : '';
            if (!body) { input && input.focus(); return; }
            const ok = this.ritz.addCellCommentReply(coord, cid, body, 'Saya');
            if (!ok) { this.showToast('Komentar tidak ditemukan.'); return; }
            this.showToast('Balasan ditambahkan.');
            renderThread();
          });
        });

        // Resolve toggle per komentar.
        modal.querySelectorAll('.sc-resolve').forEach(btnEl => {
          btnEl.addEventListener('click', () => {
            const cid = btnEl.getAttribute('data-id');
            const c = this.ritz.getCellComments(coord).find(x => x.id === cid);
            if (!c) { this.closeModal(); this.showToast('Komentar tidak ditemukan.'); return; }
            this.ritz.setCellCommentResolved(coord, cid);
            this.showToast(c.resolved ? 'Komentar dibuka kembali.' : 'Komentar diselesaikan.');
            renderThread();
          });
        });

        // Delete per komentar.
        modal.querySelectorAll('.sc-delete').forEach(btnEl => {
          btnEl.addEventListener('click', () => {
            const cid = btnEl.getAttribute('data-id');
            const ok = this.ritz.deleteCellComment(coord, cid);
            if (ok) {
              this.showToast('Komentar dihapus.');
              // Bila sel tidak lagi punya komentar, tutup modal (tidak ada yang ditampilkan).
              if (!this.ritz.hasCellComment(coord)) { this.closeModal(); return; }
              renderThread();
            } else {
              this.showToast('Komentar tidak ditemukan.');
            }
          });
        });

        // Fokus: bila tidak ada komentar, fokus ke textarea tambah; bila ada,
        // fokus tetap di textarea tambah (paritas Sheets: form selalu siap).
        const focusEl = modal.querySelector('#gwsSheetCommentText');
        if (focusEl) focusEl.focus();
      };
      renderThread();
    }

    openAboutModal() {
      const modal = this.ensureModal();
      modal.innerHTML = `
        <div style="background: #fff; width: 520px; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.25); padding: 24px; font-family: 'Google Sans', Arial, sans-serif;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
            <h3 style="font-size: 18px; font-weight: 500; color: #202124;">Tentang Workspace Ini</h3>
            <span class="modal-close" style="cursor: pointer; font-size: 20px; color: #5f6368;">✕</span>
          </div>
          <p style="font-size: 13px; color: #5f6368; line-height: 1.6;">
            Implementasi mandiri tiga engine Google Workspace hasil reverse-engineering
            artefak nyata, berjalan sepenuhnya lokal tanpa koneksi ke Google.
          </p>
          <ul style="font-size: 13px; color: #202124; line-height: 1.8; margin: 12px 0 0 18px;">
            <li><strong>Docs</strong> — Kix: multi-canvas tile + word-wrap + paginasi dinamis.</li>
            <li><strong>Sheets</strong> — Ritz/Waffle: grid canvas tunggal, 26 fungsi formula.</li>
            <li><strong>Slides</strong> — Punch: scene graph SVG murni (0 canvas).</li>
            <li><strong>Drive</strong> — persistensi JSON via REST API lokal.</li>
          </ul>
          <div style="text-align: right; margin-top: 18px;">
            <button class="modal-close" style="padding: 8px 20px; background: #1a73e8; color: #fff; border: none; border-radius: 20px; font-size: 13px; font-weight: 500; cursor: pointer;">Tutup</button>
          </div>
        </div>
      `;
      modal.style.display = 'flex';
      modal.querySelectorAll('.modal-close').forEach(el => el.addEventListener('click', () => this.closeModal()));
    }

    openShareModal() {
      let modal = document.getElementById('gwsShareModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'gwsShareModal';
        modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.5); z-index: 100000; display: flex; align-items: center; justify-content: center;';
        document.body.appendChild(modal);
      }

      modal.innerHTML = `
        <div style="background: #fff; width: 500px; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.25); overflow: hidden; padding: 24px; font-family: 'Google Sans', Arial, sans-serif;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <h3 style="font-size: 18px; font-weight: 500; color: #202124;">Bagikan "${escapeXml(document.getElementById('docTitle')?.value || 'Dokumen')}"</h3>
            <span style="cursor: pointer; font-size: 20px; color: #5f6368;" onclick="window.workspaceApp.closeShareModal()">✕</span>
          </div>
          <div style="margin-bottom: 20px;">
            <div style="font-size: 13px; color: #5f6368; margin-bottom: 8px;">Akses Umum</div>
            <div style="display: flex; align-items: center; gap: 12px; padding: 12px; background: #f8f9fa; border-radius: 8px; border: 1px solid #dadce0;">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="#0f9d58"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
              <div>
                <div style="font-size: 13px; font-weight: 500; color: #202124;">Siapa saja yang memiliki link</div>
                <div style="font-size: 12px; color: #5f6368;">Siapa saja di internet yang memiliki link ini dapat melihat</div>
              </div>
            </div>
            <div style="margin-top: 12px;">
              <div style="font-size: 13px; color: #5f6368; margin-bottom: 6px;">Link dokumen (lokal)</div>
              <input id="shareLinkInput" readonly value="${escapeXml(window.location.href)}" style="width: 100%; padding: 8px 10px; border: 1px solid #dadce0; border-radius: 6px; font-size: 12px; color: #202124;">
            </div>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <button id="shareCopyBtn" style="display: flex; align-items: center; gap: 6px; padding: 8px 18px; border: 1px solid #dadce0; background: #fff; color: #1a73e8; border-radius: 20px; font-size: 13px; font-weight: 500; cursor: pointer;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
              <span>Salin Link</span>
            </button>
            <button class="share-done" style="padding: 8px 20px; background: #1a73e8; color: #fff; border: none; border-radius: 20px; font-size: 13px; font-weight: 500; cursor: pointer;">Selesai</button>
          </div>
        </div>
      `;
      modal.style.display = 'flex';

      const copyBtn = modal.querySelector('#shareCopyBtn');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          const link = document.getElementById('shareLinkInput');
          try {
            if (navigator.clipboard) navigator.clipboard.writeText(link.value);
            else link.select();
          } catch {}
          this.showToast('Link berhasil disalin ke clipboard!');
        });
      }
      modal.querySelectorAll('.share-done').forEach(el => el.addEventListener('click', () => {
        this.closeShareModal();
      }));
    }

    showToast(msg) {
      let toast = document.getElementById('gwsToast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'gwsToast';
        toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#202124;color:#fff;padding:12px 24px;border-radius:24px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:99999;transition:opacity 0.3s;pointer-events:none;';
        document.body.appendChild(toast);
      }
      toast.innerText = msg;
      toast.style.opacity = '1';
      setTimeout(() => { toast.style.opacity = '0'; }, 3500);
    }
  }

  window.WorkspaceAppShell = WorkspaceAppShell;
})(window);
