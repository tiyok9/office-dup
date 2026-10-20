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
          const el = document.getElementById('docsCurPage');
          if (el) el.innerText = curPage;
          const statusEl = document.getElementById('docsStatusText');
          if (statusEl) statusEl.innerText = `Halaman ${curPage} dari ${totalPages} · ${words} kata`;
        });
        this.kix.onChange = (data) => {
          if (!this._restoring) this.recordHistory('docs', data);
          this.triggerAutosave({ data });
          this.syncToolbar();
        };
        // Toolbar harus memantulkan format BARIS DI KURSOR setiap kali kursor
        // bergerak (klik baris lain, panah, Enter) — bukan hanya saat mengedit.
        this.kix.onActiveLineChange = () => this.syncToolbar();
      }

      if (window.RitzSpreadsheetEditor) {
        this.ritz = new window.RitzSpreadsheetEditor('sheetsGridCanvas', 'sheetFormulaInput', 'sheetActiveCell');
        this.ritz.onCellChange = (cells) => {
          const data = { cells };
          if (!this._restoring) this.recordHistory('sheets', data);
          this.triggerAutosave({ data });
          this.syncToolbar();
        };
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
      else if (app === 'sheets' && this.ritz) this.ritz.setCells(data.cells || {});
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
        titleEl.ondblclick = (e) => {
          e.stopPropagation();
          const newTitle = prompt('Ubah nama file:', doc.title);
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
          this.ritz.setCells(doc.data.cells || {});
          this.ritz.setCharts(doc.data.charts || []);
          this.resetHistory('sheets', { cells: doc.data.cells || {}, charts: doc.data.charts || [] });
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
      if (!confirm('Apakah Anda yakin ingin menghapus dokumen ini dari Drive?')) return;
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

    syncToolbar() {
      const set = (id, on) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', !!on);
      };

      let st = {};
      if (this.currentApp === 'docs' && this.kix) {
        st = this.kix.pages[this.kix.activePageIdx]?.lines[this.kix.activeLineIdx] || this.kix.currentStyle || {};
        const fam = document.getElementById('tbFontFamily');
        if (fam && st.fontFamily) fam.value = st.fontFamily;
        const sz = document.getElementById('tbFontSize');
        if (sz && st.size) sz.value = String(st.size);
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

        if (e.key === 'Escape') {
          this.closeAllMenus();
          const m = document.getElementById('gwsModal');
          if (m) m.style.display = 'none';
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
          { label: 'Cetak / Print', shortcut: 'Ctrl+P', action: () => window.print() }
        ];
      }
      if (menu === 'edit') {
        return [
          { label: 'Undo', shortcut: 'Ctrl+Z', action: () => this.performUndo(this.currentApp) },
          { label: 'Redo', shortcut: 'Ctrl+Y', action: () => this.performRedo(this.currentApp) },
          { sep: true },
          { label: 'Pilih Semua (Select All)', shortcut: 'Ctrl+A', action: () => this.selectAll() },
          { label: 'Hapus Elemen Terpilih (Slides)', shortcut: 'Delete', action: () => { if (this.punch) this.punch.deleteSelectedElement(); } }
        ];
      }
      if (menu === 'view') {
        return [
          { label: 'Mode Presentasi Slideshow', shortcut: 'F5', action: () => { if (this.punch) this.punch.startPresentationMode(); } },
          { label: 'Layar Penuh (Fullscreen)', shortcut: 'F11', action: () => this.toggleFullscreen() },
          { sep: true },
          { label: 'Tampilkan/Sembunyikan Telemetry Drawer', action: () => window.toggleTelemetry() },
          { label: 'Buka Drive Hub', action: () => this.switchApp('drive') }
        ];
      }
      if (menu === 'insert') {
        return [
          { label: 'Tambah Halaman Baru (Docs)', action: () => { if (this.kix) this.kix.insertNewPage(); } },
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
      if (type === 'sheets' && this.ritz) return { cells: this.ritz.getCells(), charts: this.ritz.getCharts() };
      if (type === 'slides' && this.punch) return { slides: this.punch.getSlides() };
      const doc = this.documents.find(d => d.id === this.currentDocId);
      return doc || {};
    }

    // ================= MODALS =================
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
      if (modal) modal.style.display = 'none';
    }

    openWordCountModal() {
      const modal = this.ensureModal();
      const words = this.kix ? this.kix.calculateWordCount() : 0;
      let chars = 0, pages = 0;
      if (this.kix) {
        pages = this.kix.pages.length;
        for (const p of this.kix.pages) for (const l of p.lines) chars += (l.text || '').length;
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
            <span style="cursor: pointer; font-size: 20px; color: #5f6368;" onclick="document.getElementById('gwsShareModal').style.display='none'">✕</span>
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
        modal.style.display = 'none';
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
