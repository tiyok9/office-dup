// D:\program\google\tool\static\ritz_editor.js
// Ritz/Waffle Spreadsheet Engine (Single Canvas Interactive Grid Editor)
// Mendukung: seleksi sel, navigasi keyboard, formula, formatting sel
// (bold/italic/warna teks/warna latar/align/format angka) dan ekspor CSV.

(function(window) {
  'use strict';

  // Escape teks agar aman dimasukkan ke dalam SVG yang dibangun sebagai string
  // (bagan). Tanpa ini, label sel berisi "<" atau "&" akan merusak markup.
  function escapeXml(unsafe) {
    return String(unsafe)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // Ekspor bagan aktif sebagai berkas .svg mandiri (tombol "Unduh SVG").
  // Membaca dokumen SVG dari editor lalu memicunya sebagai unduhan.
  function exportChartSvg(editor) {
    if (!editor || typeof editor.chartSvgDocument !== 'function') return false;
    const doc = editor.chartSvgDocument();
    if (!doc) return false;
    const blob = new Blob([doc], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bagan.svg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return doc.length;
  }

  class RitzSpreadsheetEditor {
    constructor(canvasId, formulaInputId, activeCellBoxId) {
      this.canvas = document.getElementById(canvasId);
      this.ctx = this.canvas.getContext('2d');
      this.formulaInput = document.getElementById(formulaInputId);
      this.activeCellBox = document.getElementById(activeCellBoxId);

      // { 'A1': { val, raw, bold, italic, color, bg, align, numFormat } }
      this.cells = {};
      this.activeCol = 2; // C (0-based)
      this.activeRow = 1; // Row 1 (1-based)
      this.scrollX = 0;
      this.scrollY = 0;

      // Mode sunting-di-sel (in-cell editing ala Google Sheets): user mengetik
      // langsung di sel, bukan wajib lewat formula bar.
      this.editing = false;
      this.editBuffer = '';

      this.colWidth = 110;
      this.rowHeight = 26;
      this.headerWidth = 46;
      this.headerHeight = 28;
      this.totalCols = 26;
      this.totalRows = 100;

      // ==== LEBAR KOLOM DINAMIS (paritas resize kolom Google Sheets) ====
      // Map { [colIdx]: width } milik sheet AKTIF. Kolom tanpa entri memakai
      // this.colWidth (110) — jadi dokumen lama dan koordinat klik tes lama
      // TIDAK bergeser satu piksel pun bila belum ada yang di-resize.
      this.colWidths = {};
      this.isResizingCol = false;
      this.resizeColIdx = -1;
      this.resizeStartX = 0;
      this.resizeStartWidth = 0;
      this._hoverResizeCol = -1;

      this.onCellChange = null;
      // Bagan mengambang yang disimpan bersama dokumen (lihat insertChart).
      this.charts = [];
      this.activeChartId = null;

      // ==== SELEKSI RENTANG (paritas Google Sheets) ====
      // Lapisan tambahan DI ATAS activeCol/activeRow — properti lama tetap utuh
      // agar formula, bagan, dan setActiveCell() tidak berubah perilakunya.
      this.selStartCol = this.activeCol;
      this.selStartRow = this.activeRow;
      this.selEndCol = this.activeCol;
      this.selEndRow = this.activeRow;
      this.isSelecting = false;
      this._dragBound = false;

      // ==== MULTI-SHEET (paritas tab sheet Google Sheets) ====
      // sheets[] adalah sumber kebenaran. this.cells / this.charts tetap menunjuk
      // ke sheet AKTIF, sehingga seluruh kode lama (formula, bagan, render,
      // sortRange) bekerja tanpa perubahan apa pun.
      this.sheets = [{ name: 'Sheet1', cells: {}, charts: [] }];
      this.activeSheetIdx = 0;
      this.initEvents();
    }

    // Tulis keadaan editor saat ini ke entri sheets[] yang aktif.
    // Dipanggil SEBELUM berpindah sheet / sebelum menyusun data dokumen,
    // supaya suntingan pada sheet lama tidak hilang.
    _syncActiveSheet() {
      if (!Array.isArray(this.sheets) || !this.sheets.length) {
        this.sheets = [{ name: 'Sheet1', cells: {}, charts: [] }];
        this.activeSheetIdx = 0;
      }
      const s = this.sheets[this.activeSheetIdx];
      if (!s) return;
      s.cells = this.cells || {};
      s.charts = this.charts || [];
      // Lebar kolom ikut sheet ini (tiap tab bisa punya lebar berbeda).
      s.colWidths = { ...(this.colWidths || {}) };
    }

    // Muat entri sheets[] aktif menjadi keadaan editor (cells/charts/seleksi).
    _loadActiveSheet() {
      const s = this.sheets[this.activeSheetIdx] || { cells: {}, charts: [] };
      this.cells = JSON.parse(JSON.stringify(s.cells || {}));
      this.charts = JSON.parse(JSON.stringify(s.charts || []));
      this.activeChartId = this.charts.length ? this.charts[this.charts.length - 1].id : null;
      // Geometri milik sheet ini; dokumen lama tanpa colWidths -> default 110.
      this.colWidths = { ...(s.colWidths || {}) };
      const fz = s.frozen || {};
      this.frozenRows = Math.max(0, Math.min(this.totalRows, Number(fz.rows) || 0));
      this.frozenCols = Math.max(0, Math.min(this.totalCols, Number(fz.cols) || 0));
      this.isResizingCol = false;
      this.resizeColIdx = -1;
      this._hoverResizeCol = -1;
      // Seleksi milik sheet sebelumnya tidak boleh ikut terbawa.
      this.selStartCol = this.activeCol;
      this.selStartRow = this.activeRow;
      this.selEndCol = this.activeCol;
      this.selEndRow = this.activeRow;
      this.isSelecting = false;
      this.renderChartOverlay();
    }

    // Jalur LAMA (dipakai tes, undo, dan dokumen format lama). Tetap dipertahankan
    // 100%: hanya mengisi sheet AKTIF, tidak menghapus sheet lain.
    setCells(cellsMap) {
      this.cells = JSON.parse(JSON.stringify(cellsMap || {}));
      // Dokumen baru = seleksi lama tidak berlaku. Tanpa ini, name box bisa
      // menampilkan rentang C2:E5 dari dokumen SEBELUMNYA (bocor antar-dokumen).
      this.selStartCol = this.activeCol;
      this.selStartRow = this.activeRow;
      this.selEndCol = this.activeCol;
      this.selEndRow = this.activeRow;
      this.isSelecting = false;
      // Cerminkan ke sheets[] supaya dokumen format lama (tanpa sheets[])
      // tidak menghapus isi sheet aktif saat disimpan.
      if (!Array.isArray(this.sheets) || !this.sheets.length) {
        this.sheets = [{ name: 'Sheet1', cells: {}, charts: [] }];
        this.activeSheetIdx = 0;
      }
      if (this.sheets[this.activeSheetIdx]) {
        this.sheets[this.activeSheetIdx].cells = this.cells;
      }
      this.render();
      this.updateFormulaBar();
    }

    getCells() {
      return this.cells;
    }

    // ==== GEOMETRI KOLOM DINAMIS ====
    // Semua perhitungan x kolom WAJIB lewat tiga helper ini, supaya render,
    // hit-testing klik, overlay seleksi rentang, dan fill handle konsisten
    // saat ada kolom yang lebarnya diubah.
    getColWidth(c) {
      const raw = this.colWidths ? this.colWidths[c] : undefined;
      const n = Number(raw);
      return (Number.isFinite(n) && n > 0) ? n : this.colWidth;
    }

    // Posisi x KIRI kolom c dalam koordinat kanvas (belum dikurangi scrollX).
    getColX(c) {
      let x = this.headerWidth;
      for (let i = 0; i < c; i++) x += this.getColWidth(i);
      return x;
    }

    // Kebalikan getColX: kolom mana yang berada pada x tertentu.
    colFromX(x) {
      if (x < this.headerWidth) return -1;
      let acc = this.headerWidth;
      for (let i = 0; i < this.totalCols; i++) {
        const w = this.getColWidth(i);
        if (x < acc + w) return i;
        acc += w;
      }
      return -1;
    }

    colBoundaryX(c) {
      return this.getColX(c) + this.getColWidth(c);
    }

    // Deteksi pointer berada di garis pemisah header kolom (toleransi 4px).
    // Dipakai untuk kursor col-resize sekaligus memulai drag resize.
    colResizeHit(x, y) {
      if (y > this.headerHeight || x < this.headerWidth) return -1;
      for (let i = 0; i < this.totalCols; i++) {
        const bx = this.colBoundaryX(i) - this.scrollX;
        if (Math.abs(x - bx) <= 4) return i;
        if (bx > this.canvas.width + 40) break;
      }
      return -1;
    }

    setColWidth(c, w) {
      const n = Math.max(30, Math.round(Number(w) || 0));
      this.colWidths[c] = n;
      return n;
    }

    // Lebar total kolom 0..n-1 (dipakai untuk freeze pane).
    colsWidthUpto(n) {
      let x = 0;
      for (let i = 0; i < n; i++) x += this.getColWidth(i);
      return x;
    }

    // ==== API MULTI-SHEET ====
    // Dokumen format lama (hanya punya data.cells) tetap terbaca: dibungkus jadi
    // satu sheet bernama Sheet1, sehingga tidak ada migrasi yang memutus data.
    setSheets(arr, activeIdx = 0) {
      const list = Array.isArray(arr) ? arr : [];
      if (!list.length) {
        this.sheets = [{ name: 'Sheet1', cells: {}, charts: [] }];
        this.activeSheetIdx = 0;
      } else {
        this.sheets = list.map((s, i) => ({
          name: (s && s.name) ? String(s.name) : `Sheet${i + 1}`,
          cells: (s && s.cells) ? JSON.parse(JSON.stringify(s.cells)) : {},
          charts: (s && Array.isArray(s.charts)) ? JSON.parse(JSON.stringify(s.charts)) : [],
          // Lebar kolom per sheet ikut dipulihkan dari dokumen.
          colWidths: (s && s.colWidths && typeof s.colWidths === 'object') ? { ...s.colWidths } : {}
        }));
        const idx = Number(activeIdx);
        this.activeSheetIdx = (Number.isInteger(idx) && idx >= 0 && idx < this.sheets.length) ? idx : 0;
      }
      this.activeCol = 2;
      this.activeRow = 1;
      this._loadActiveSheet();
      this.renderSheetTabs();
      this.render();
      this.updateFormulaBar();
    }

    getSheets() {
      this._syncActiveSheet();
      return this.sheets;
    }

    getActiveSheetName() {
      const s = this.sheets[this.activeSheetIdx];
      return s ? s.name : 'Sheet1';
    }

    // Pindah sheet: suntingan sheet lama WAJIB disimpan dulu ke sheets[].
    switchSheet(idx) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= this.sheets.length) return false;
      if (idx === this.activeSheetIdx) return false;
      this._syncActiveSheet();
      this.activeSheetIdx = idx;
      this.activeCol = 2;
      this.activeRow = 1;
      this._loadActiveSheet();
      this.renderSheetTabs();
      this.render();
      this.updateFormulaBar();
      this.notifyChange();
      return true;
    }

    addSheet(name) {
      this._syncActiveSheet();
      const n = this.sheets.length + 1;
      // Nama unik: Sheet2, Sheet3, ... (lewati nama yang sudah dipakai).
      let candidate = name ? String(name) : `Sheet${n}`;
      let k = n;
      while (this.sheets.some(s => s.name === candidate)) {
        k++;
        candidate = name ? `${name}${k}` : `Sheet${k}`;
      }
      this.sheets.push({ name: candidate, cells: {}, charts: [] });
      this.activeSheetIdx = this.sheets.length - 1;
      this.activeCol = 2;
      this.activeRow = 1;
      this._loadActiveSheet();
      this.renderSheetTabs();
      this.render();
      this.updateFormulaBar();
      this.notifyChange();
      return candidate;
    }

    // Hapus sheet aktif. Sheet terakhir TIDAK boleh dihapus (perilaku Sheets).
    deleteSheet(idx = this.activeSheetIdx) {
      if (this.sheets.length <= 1) return false;
      if (!Number.isInteger(idx) || idx < 0 || idx >= this.sheets.length) return false;
      this._syncActiveSheet();
      this.sheets.splice(idx, 1);
      if (this.activeSheetIdx >= this.sheets.length) this.activeSheetIdx = this.sheets.length - 1;
      else if (idx < this.activeSheetIdx) this.activeSheetIdx--;
      this._loadActiveSheet();
      this.renderSheetTabs();
      this.render();
      this.updateFormulaBar();
      this.notifyChange();
      return true;
    }

    // Gambar ulang tab bar dari this.sheets (bukan HTML statis).
    renderSheetTabs() {
      const bar = document.getElementById('sheetsTabBar');
      if (!bar) return;
      bar.innerHTML = '';
      this.sheets.forEach((s, i) => {
        const tab = document.createElement('div');
        tab.className = 'sheet-tab' + (i === this.activeSheetIdx ? ' active' : '');
        tab.setAttribute('data-sheet-idx', String(i));
        tab.title = s.name;
        const label = document.createElement('span');
        label.className = 'sheet-tab-label';
        label.textContent = s.name;
        tab.appendChild(label);
        // Tombol tutup hanya muncul di tab aktif dan bila sheet > 1.
        if (i === this.activeSheetIdx && this.sheets.length > 1) {
          const x = document.createElement('button');
          x.className = 'sheet-tab-close';
          x.type = 'button';
          x.title = `Hapus ${s.name}`;
          x.textContent = '\u00d7';
          x.addEventListener('click', (e) => { e.stopPropagation(); this.deleteSheet(i); });
          tab.appendChild(x);
        }
        tab.addEventListener('click', () => this.switchSheet(i));
        bar.appendChild(tab);
      });
      const add = document.createElement('button');
      add.className = 'sheet-tab-add';
      add.type = 'button';
      add.id = 'sheetTabAdd';
      add.title = 'Tambahkan Sheet';
      add.textContent = '+';
      add.addEventListener('click', () => this.addSheet());
      bar.appendChild(add);
    }

    colLabel(idx) {
      let s = '';
      let n = idx + 1;
      while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s;
    }

    getActiveCoord() {
      return `${this.colLabel(this.activeCol)}${this.activeRow}`;
    }

    // ==== RENTANG (RANGE) — paritas name box Google Sheets ====
    // activeCol/activeRow adalah JANGKAR (anchor) seleksi, persis seperti Sheets:
    // sel aktif tetap satu sel, sedangkan selStart..selEnd menggambarkan area.
    getRangeBounds() {
      return {
        minCol: Math.min(this.selStartCol, this.selEndCol),
        maxCol: Math.max(this.selStartCol, this.selEndCol),
        minRow: Math.min(this.selStartRow, this.selEndRow),
        maxRow: Math.max(this.selStartRow, this.selEndRow)
      };
    }

    isRangeSelection() {
      const b = this.getRangeBounds();
      return b.minCol !== b.maxCol || b.minRow !== b.maxRow;
    }

    // Label A1 atau A1:C5 — format kanonik Google Sheets.
    getRangeA1() {
      if (!this.isRangeSelection()) return this.getActiveCoord();
      const b = this.getRangeBounds();
      return `${this.colLabel(b.minCol)}${b.minRow}:${this.colLabel(b.maxCol)}${b.maxRow}`;
    }

    // ==== BAGAN (CHART) — SVG murni, TANPA pustaka luar ====
    // Angka diambil dari NILAI sel yang sudah dievaluasi (bukan rumus mentah),
    // supaya bagan selalu sinkron dengan hasil perhitungan formula.
    _numAt(colIdx, row) {
      const c = this.cells[`${this.colLabel(colIdx)}${row}`];
      if (!c) return null;
      const v = (c.val !== undefined && c.val !== '') ? c.val : c.raw;
      // Hanya angka sungguhan yang diterima. Dulu teks seperti "x" diubah
      // menjadi "" oleh replace() lalu Number("") = 0, sehingga sel TEKS ikut
      // terplot sebagai batang bernilai nol. Sekarang teks/token error -> null.
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      const s = String(v).trim();
      if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }

    // Data bagan diambil dari KOLOM AKTIF (nilai) dengan label dari kolom di
    // sebelah kirinya — sama seperti cara user memilih rentang lalu Insert chart.
    readChartData() {
      const valCol = this.activeCol;
      const labelCol = Math.max(0, valCol - 1);
      const labels = [], values = [];
      for (let r = 1; r <= 20 && values.length < 10; r++) {
        const n = this._numAt(valCol, r);
        if (n === null) continue;
        const lc = this.cells[`${this.colLabel(labelCol)}${r}`];
        const lbl = lc ? ((lc.val !== undefined && lc.val !== '') ? lc.val : lc.raw) : '';
        labels.push(lbl !== '' && lbl !== undefined ? String(lbl) : `${this.colLabel(valCol)}${r}`);
        values.push(n);
      }
      return { labels, values, title: `Bagan kolom ${this.colLabel(valCol)}` };
    }

    // type: 'column' | 'line' | 'pie'. Mengembalikan { svg, title, count }.
    buildChartSvg(type = 'column') {
      const { labels, values, title } = this.readChartData();
      const W = 380, H = 210, PAD = 36;
      if (!values.length) {
        const ms = `Tidak ada data angka pada kolom ${this.colLabel(this.activeCol)}`;
        return { svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img"><rect width="${W}" height="${H}" fill="#ffffff"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-family="Arial" font-size="12" fill="#5f6368">${ms}</text></svg>`, title, count: 0 };
      }
      const max = Math.max(...values, 0);
      const min = Math.min(...values, 0);
      const span = (max - min) || 1;
      const plotW = W - PAD * 2, plotH = H - PAD * 2;
      const colors = ['#1a73e8', '#34a853', '#fbbc04', '#ea4335', '#a142f4', '#00acc1'];
      let body = '';
      if (type === 'pie') {
        const total = values.reduce((a, b) => a + Math.abs(b), 0) || 1;
        let ang = -Math.PI / 2;
        const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - 18;
        values.forEach((v, i) => {
          const frac = Math.abs(v) / total;
          const a2 = ang + frac * Math.PI * 2;
          const x1 = cx + r * Math.cos(ang), y1 = cy + r * Math.sin(ang);
          const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
          const large = frac > 0.5 ? 1 : 0;
          body += `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${colors[i % colors.length]}" stroke="#ffffff" stroke-width="1"/>`;
          ang = a2;
        });
      } else if (type === 'line') {
        const pts = values.map((v, i) => ({
          v,
          x: PAD + plotW * (values.length === 1 ? 0.5 : i / (values.length - 1)),
          y: PAD + plotH - ((v - min) / span) * plotH
        }));
        body += `<path d="M${pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L')}" fill="none" stroke="#1a73e8" stroke-width="2.5"/>`;
        pts.forEach(p => {
          body += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="#1a73e8"/>`;
          body += `<text x="${p.x.toFixed(1)}" y="${(p.y - 9).toFixed(1)}" text-anchor="middle" font-family="Arial" font-size="10" fill="#202124">${p.v}</text>`;
        });
      } else {
        const bw = (plotW / values.length) * 0.6;
        values.forEach((v, i) => {
          const cx = PAD + plotW * (i + 0.5) / values.length;
          const y = PAD + plotH - ((v - min) / span) * plotH;
          const bh = Math.max(1, PAD + plotH - y);
          body += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="#1a73e8"/>`;
          body += `<text x="${cx.toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-family="Arial" font-size="10" fill="#202124">${v}</text>`;
        });
      }
      // Sumbu dasar + label kategori (untuk kolom/garis).
      let axis = '';
      if (type !== 'pie') {
        axis += `<line x1="${PAD}" y1="${PAD + plotH}" x2="${W - PAD}" y2="${PAD + plotH}" stroke="#dadce0" stroke-width="1"/>`;
        if (type === 'column') {
          const step = plotW / values.length;
          labels.forEach((lbl, i) => {
            const cx = PAD + step * (i + 0.5);
            const short = lbl.length > 7 ? lbl.slice(0, 6) + '…' : lbl;
            axis += `<text x="${cx.toFixed(1)}" y="${H - 10}" text-anchor="middle" font-family="Arial" font-size="9" fill="#5f6368">${escapeXml(short)}</text>`;
          });
        }
      }
      const svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img" data-chart-type="${type}"><rect width="${W}" height="${H}" fill="#ffffff"/>${body}${axis}</svg>`;
      return { svg, title, count: values.length };
    }

    // Sisipkan bagan mengambang di atas grid; disimpan di this.charts agar
    // tidak lenyap saat dokumen dimuat ulang.
    insertChart(type = 'column') {
      const built = this.buildChartSvg(type);
      if (!Array.isArray(this.charts)) this.charts = [];
      const chart = {
        id: `chart-${Date.now()}`, type,
        col: this.colLabel(this.activeCol),
        x: 300, y: 36, width: 400
      };
      this.charts.push(chart);
      // WAJIB: tanpa ini kartu bagan tidak pernah tampil. renderChartOverlay()
      // menyembunyikan overlay bila activeChartId kosong, dan hanya setCharts()
      // yang mengisinya — sehingga bagan hanya muncul setelah dokumen dimuat
      // ulang, bukan saat tombol Sisipkan Bagan diklik (bug ditemukan E2E S9b).
      this.activeChartId = chart.id;
      this.renderChartOverlay();
      if (typeof this.onCellChange === 'function') this.onCellChange(this.cells);
      return built;
    }

    // Dokumen SVG mandiri untuk bagan aktif — sumber tunggal untuk ekspor
    // maupun pengujian (tidak perlu memicu unduhan untuk memverifikasi isi).
    chartSvgDocument() {
      const charts = this.charts || [];
      const c = charts.find(x => x.id === this.activeChartId) || charts[charts.length - 1];
      if (!c) return null;
      const built = this.buildChartSvg(c.type);
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${c.width}" height="${c.height}" viewBox="0 0 ${c.width} ${c.height}">${built.svg}</svg>`;
    }

    renderChartOverlay() {
      const grid = this.canvas.parentElement;
      if (!grid) return;
      let ov = document.getElementById('ritzChartOverlay');
      if (!ov) {
        ov = document.createElement('div');
        ov.id = 'ritzChartOverlay';
        ov.className = 'ritz-chart-overlay';
        grid.appendChild(ov);
      }
      const charts = this.charts || [];
      if (!charts.length || !this.activeChartId) { ov.style.display = 'none'; ov.innerHTML = ''; return; }
      const c = charts.find(x => x.id === this.activeChartId) || charts[charts.length - 1];
      const built = this.buildChartSvg(c.type);
      ov.style.display = 'block';
      ov.style.left = `${c.x}px`;
      ov.style.top = `${c.y}px`;
      ov.style.width = `${c.width}px`;
      ov.innerHTML =
        `<div class="ritz-chart-head">` +
          `<span class="ritz-chart-title">${escapeXml(built.title)}</span>` +
          `<select class="ritz-chart-type" id="ritzChartType" title="Jenis bagan">` +
            `<option value="column">Kolom</option><option value="line">Garis</option><option value="pie">Lingkaran</option>` +
          `</select>` +
          `<button class="ritz-chart-export" id="ritzChartExport" title="Ekspor bagan sebagai berkas SVG">Unduh SVG</button>` +
          `<button class="ritz-chart-close" id="ritzChartClose" title="Tutup bagan">&times;</button>` +
        `</div><div class="ritz-chart-body">${built.svg}</div>`;
      const sel = document.getElementById('ritzChartType');
      if (sel) {
        sel.value = c.type;
        sel.addEventListener('change', () => { c.type = sel.value; this.renderChartOverlay(); });
      }
      const ex = document.getElementById('ritzChartExport');
      if (ex) ex.addEventListener('click', () => exportChartSvg(this));
      const cl = document.getElementById('ritzChartClose');
      if (cl) cl.addEventListener('click', () => this.removeChart());
    }

    removeChart() {
      this.charts = [];
      this.activeChartId = null;
      const ov = document.getElementById('ritzChartOverlay');
      if (ov) { ov.innerHTML = ''; ov.style.display = 'none'; }
      if (typeof this.onCellChange === 'function') this.onCellChange(this.cells);
    }

    getCharts() {
      return this.charts || [];
    }

    setCharts(arr) {
      this.charts = Array.isArray(arr) ? JSON.parse(JSON.stringify(arr)) : [];
      this.activeChartId = this.charts.length ? this.charts[this.charts.length - 1].id : null;
      if (this.charts.length) this.renderChartOverlay();
    }

    // ==== URUTKAN (SORT) — paritas "Sort range" Google Sheets ====
    // Mengurutkan nilai pada KOLOM AKTIF. Nilai numerik diurutkan sebagai angka,
    // teks diurutkan dengan localeCompare. Sel utuh (raw+val+format) ikut pindah.
    sortRange(dir = 'asc') {
      const col = this.activeCol;
      const entries = [];
      for (let r = 1; r <= this.totalRows; r++) {
        const coord = `${this.colLabel(col)}${r}`;
        const cell = this.cells[coord];
        if (!cell) continue;
        const v = (cell.val !== undefined && cell.val !== '') ? cell.val : cell.raw;
        if (v === '' || v === undefined || v === null) continue;
        const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
        entries.push({ row: r, cell, num: Number.isFinite(n) && /^-?[\d.,]+$/.test(String(v)) ? n : null, txt: String(v) });
      }
      if (entries.length < 2) return { moved: 0, col: this.colLabel(col) };
      const allNum = entries.every(e => e.num !== null);
      const sign = dir === 'desc' ? -1 : 1;
      entries.sort((a, b) => allNum
        ? sign * (a.num - b.num)
        : sign * a.txt.localeCompare(b.txt, 'id', { numeric: true, sensitivity: 'base' }));
      const minRow = Math.min(...entries.map(e => e.row));
      const maxRow = Math.max(...entries.map(e => e.row));
      const cells = entries.map(e => e.cell);
      for (let r = minRow; r <= maxRow; r++) delete this.cells[`${this.colLabel(col)}${r}`];
      cells.forEach((cell, i) => { this.cells[`${this.colLabel(col)}${minRow + i}`] = cell; });
      this.render();
      this.recalculateAll();
      return { moved: cells.length, col: this.colLabel(col), numeric: allNum, dir };
    }

    setActiveCell(col, row) {
      if (col >= 0 && col < this.totalCols && row >= 1 && row <= this.totalRows) {
        this.activeCol = col;
        this.activeRow = row;
        // Pindah sel secara programatik = seleksi tunggal, bukan rentang.
        this.selStartCol = col;
        this.selStartRow = row;
        this.selEndCol = col;
        this.selEndRow = row;
        this.render();
        this.updateFormulaBar();
      }
    }

    initEvents() {
      // Mouse Click Selection
      this.canvas.addEventListener('mousedown', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        // Kompensasi zoom/peregangan: getBoundingClientRect() mengembalikan
        // ukuran SETELAH transform, sedangkan sistem koordinat kanvas tetap
        // 1:1 (canvas.width). Rasio ini otomatis benar untuk zoom apa pun.
        const sx = rect.width ? this.canvas.width / rect.width : 1;
        const sy = rect.height ? this.canvas.height / rect.height : 1;
        const x = (e.clientX - rect.left) * sx;
        const y = (e.clientY - rect.top) * sy;

        // ==== RESIZE KOLOM (paritas Google Sheets) ====
        // Klik tepat di garis pemisah header kolom = mulai drag resize, BUKAN
        // memilih sel. Dicek PALING AWAL supaya handler seleksi di bawah tidak
        // sempat mengubah activeCol/activeRow atau memulai seleksi rentang.
        const rzCol = this.colResizeHit(x, y);
        if (rzCol >= 0) {
          this.isResizingCol = true;
          this.resizeColIdx = rzCol;
          this.resizeStartX = x;
          this.resizeStartWidth = this.getColWidth(rzCol);
          this.isSelecting = false;
          e.preventDefault();
          this.render();
          return;
        }

        if (x > this.headerWidth && y > this.headerHeight) {
          // colFromX() menghormati lebar kolom yang sudah di-resize.
          const clickedCol = this.colFromX(x + this.scrollX);
          const clickedRow = Math.floor((y - this.headerHeight + this.scrollY) / this.rowHeight) + 1;

          if (clickedCol >= 0 && clickedCol < this.totalCols && clickedRow >= 1 && clickedRow <= this.totalRows) {
            // Klik ke sel lain saat sedang menyunting = komit dulu (perilaku Sheets).
            if (this.editing && (clickedCol !== this.activeCol || clickedRow !== this.activeRow)) {
              this.commitEdit();
            }
            this.activeCol = clickedCol;
            this.activeRow = clickedRow;
            // Mulai seleksi rentang baru: jangkar (anchor) = sel yang diklik.
            // activeCol/activeRow tetap jadi jangkar agar formula, bagan, dan
            // setActiveCell() berperilaku persis seperti sebelumnya.
            this.selStartCol = clickedCol;
            this.selStartRow = clickedRow;
            this.selEndCol = clickedCol;
            this.selEndRow = clickedRow;
            this.isSelecting = true;
            this.render();
            this.updateFormulaBar();
          }
        }
      });

      // ==== DRAG SELEKSI RENTANG (paritas Google Sheets) ====
      // Geser mouse dari sel jangkar -> sel akhir. Koordinat dikompensasi zoom
      // dengan rasio canvas.width / rect.width (sama seperti mousedown), supaya
      // seleksi tetap akurat saat --app-zoom aktif.
      const cellAtEvent = (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const sx = rect.width ? this.canvas.width / rect.width : 1;
        const sy = rect.height ? this.canvas.height / rect.height : 1;
        const x = (e.clientX - rect.left) * sx;
        const y = (e.clientY - rect.top) * sy;
        if (x <= this.headerWidth || y <= this.headerHeight) return null;
        const col = this.colFromX(x + this.scrollX);
        const row = Math.floor((y - this.headerHeight + this.scrollY) / this.rowHeight) + 1;
        if (col < 0 || col >= this.totalCols || row < 1 || row > this.totalRows) return null;
        return { col, row };
      };

      this.canvas.addEventListener('mousemove', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const sx = rect.width ? this.canvas.width / rect.width : 1;
        const sy = rect.height ? this.canvas.height / rect.height : 1;
        const mx = (e.clientX - rect.left) * sx;
        const my = (e.clientY - rect.top) * sy;

        // ==== DRAG RESIZE KOLOM (paritas Google Sheets) ====
        // Lebar mengikuti delta x sejak mousedown. Minimum 30px (sama dengan
        // setColWidth) supaya kolom tidak bisa mengecil sampai tak terlihat.
        if (this.isResizingCol) {
          const w = Math.max(30, Math.round(this.resizeStartWidth + (mx - this.resizeStartX)));
          if (this.colWidths[this.resizeColIdx] !== w) {
            this.colWidths[this.resizeColIdx] = w;
            this.render();
          }
          return;
        }

        // ==== HOVER GARIS KOLOM -> kursor col-resize ====
        // Memakai colResizeHit() yang SAMA dengan mousedown, sehingga area
        // hover dan area klik selalu identik (tidak ada zona "hampir kena").
        if (!this.isSelecting && !this.editing) {
          const hovCol = this.colResizeHit(mx, my);
          if (hovCol !== this._hoverResizeCol) {
            this._hoverResizeCol = hovCol;
            this.canvas.style.cursor = hovCol >= 0 ? 'col-resize' : 'cell';
          }
          return;
        }

        if (!this.isSelecting || this.editing) return;
        const hit = cellAtEvent(e);
        if (!hit) return;
        if (hit.col === this.selEndCol && hit.row === this.selEndRow) return;
        this.selEndCol = hit.col;
        this.selEndRow = hit.row;
        this.render();
        this.updateFormulaBar();
      });

      const endSelection = () => {
        // Selesai resize: simpan lebar ke sheet aktif lalu picu autosave.
        // Dicek lebih dulu agar tidak bercampur dengan logika seleksi.
        if (this.isResizingCol) {
          this.isResizingCol = false;
          this.resizeColIdx = -1;
          this._hoverResizeCol = -1;
          this.canvas.style.cursor = 'cell';
          this._syncActiveSheet();
          if (typeof this.onCellChange === 'function') this.onCellChange(this.cells);
          this.render();
          return;
        }
        if (!this.isSelecting) return;
        this.isSelecting = false;
        this.updateFormulaBar();
      };
      this.canvas.addEventListener('mouseup', endSelection);
      // Mouse dilepas di luar kanvas tetap harus menutup mode seleksi.
      window.addEventListener('mouseup', endSelection);

      // Klik ganda pada sel aktif = sunting isi sel yang sudah ada (seperti Sheets).
      this.canvas.addEventListener('dblclick', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const sx = rect.width ? this.canvas.width / rect.width : 1;
        const sy = rect.height ? this.canvas.height / rect.height : 1;
        const x = (e.clientX - rect.left) * sx;
        const y = (e.clientY - rect.top) * sy;
        if (x > this.headerWidth && y > this.headerHeight) {
          const clickedCol = this.colFromX(x + this.scrollX);
          const clickedRow = Math.floor((y - this.headerHeight + this.scrollY) / this.rowHeight) + 1;
          if (clickedCol === this.activeCol && clickedRow === this.activeRow) {
            this.startCellEditExisting();
          }
        }
      });

      // Scroll (roda mouse) — halaman vertikal
      this.canvas.addEventListener('wheel', (e) => {
        this.scrollY = Math.max(0, this.scrollY + (e.deltaY > 0 ? 3 : -3) * this.rowHeight);
        e.preventDefault();
        this.render();
      }, { passive: false });

      // Keyboard Navigation + pengetikan langsung ke sel (ala Google Sheets)
      window.addEventListener('keydown', (e) => {
        if (document.activeElement === this.formulaInput) return;
        if (window.currentApp !== 'sheets') return;
        // Jangan bajak tombol saat pengguna mengetik di input/modal lain.
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        // --- Mode sunting-di-sel ---
        if (this.editing) {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.commitEdit();
            if (this.activeRow < this.totalRows) this.activeRow++;      // Enter -> turun
          } else if (e.key === 'Tab') {
            e.preventDefault();
            this.commitEdit();
            if (this.activeCol < this.totalCols - 1) this.activeCol++;  // Tab -> kanan
          } else if (e.key === 'Escape') {
            e.preventDefault();
            this.editing = false;
            this.editBuffer = '';
            this.render();
          } else if (e.key === 'Backspace') {
            e.preventDefault();
            this.editBuffer = this.editBuffer.slice(0, -1);
            this.render();
          } else if (e.key === 'Delete') {
            e.preventDefault();
            this.editBuffer = '';
            this.render();
          } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            this.editBuffer += e.key;
            this.render();
          }
          return;
        }

        let handled = false;
        if (e.key === 'ArrowUp') {
          if (this.activeRow > 1) { this.activeRow--; handled = true; }
        } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
          if (this.activeRow < this.totalRows) { this.activeRow++; handled = true; }
        } else if (e.key === 'ArrowLeft') {
          if (this.activeCol > 0) { this.activeCol--; handled = true; }
        } else if (e.key === 'ArrowRight' || e.key === 'Tab') {
          if (this.activeCol < this.totalCols - 1) { this.activeCol++; handled = true; }
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          const coord = this.getActiveCoord();
          delete this.cells[coord];
          handled = true;
          // Nilai sel dihapus -> sel turunan (formula) wajib dihitung ulang.
          this.recalculateAll();
          this.notifyChange();
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Mengetik karakter apa pun langsung memulai sunting-di-sel.
          e.preventDefault();
          this.startCellEdit(e.key);
          return;
        }

        if (handled) {
          e.preventDefault();
          // Navigasi keyboard meruntuhkan seleksi rentang kembali ke satu sel
          // (perilaku Google Sheets): jangkar ikut pindah ke sel baru.
          this.selStartCol = this.activeCol;
          this.selStartRow = this.activeRow;
          this.selEndCol = this.activeCol;
          this.selEndRow = this.activeRow;
          this.render();
          this.updateFormulaBar();
        }
      });

      // Formula Bar Enter / Input
      if (this.formulaInput) {
        this.formulaInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.commitFormulaBar();
            this.activeRow = Math.min(this.totalRows, this.activeRow + 1);
            this.render();
            this.updateFormulaBar();
          }
        });
      }
    }

    updateFormulaBar() {
      const coord = this.getActiveCoord();
      // Name box menampilkan RENTANG (A1:C5) saat seleksi lebih dari satu sel,
      // persis seperti #t-name-box Google Sheets. Satu sel tetap "C1".
      if (this.activeCellBox) this.activeCellBox.innerText = this.getRangeA1();
      // Saat menyunting di sel, formula bar cermin buffer sunting (dua arah).
      if (this.editing) {
        if (this.formulaInput) this.formulaInput.value = this.editBuffer;
        return;
      }
      const cell = this.cells[coord];
      const rawVal = cell ? (cell.raw !== undefined ? cell.raw : cell.val) : '';
      if (this.formulaInput) this.formulaInput.value = rawVal;
    }

    async commitFormulaBar() {
      const coord = this.getActiveCoord();
      const rawVal = this.formulaInput ? this.formulaInput.value.trim() : '';

      // Pertahankan metadata formatting sel saat nilai diubah.
      const prevMeta = this.cells[coord] ? { ...this.cells[coord] } : {};
      delete prevMeta.raw;
      delete prevMeta.val;

      try {
        const res = await fetch('/api/sheets/eval', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cells: this.cells,
            targetCoord: coord,
            formula: rawVal
          })
        });
        if (res.ok) {
          const data = await res.json();
          this.cells = data.cells;
        } else {
          this.cells[coord] = { raw: rawVal, val: this.coerce(rawVal), ...prevMeta };
        }
      } catch {
        this.cells[coord] = { raw: rawVal, val: this.coerce(rawVal), ...prevMeta };
      }

      this.render();
      if (typeof this.onCellChange === 'function') {
        this.onCellChange(this.cells);
      }
    }

    coerce(rawVal) {
      if (rawVal === '') return '';
      return isNaN(Number(rawVal)) ? rawVal : Number(rawVal);
    }

    // ==== EVALUASI REAKTIF (ala Google Sheets) ====
    // Setiap sel yang berubah memicu evaluasi ULANG SELURUH sel, sehingga sel
    // turunan (misal C1 = =SUM(C2:C4)) langsung berubah tanpa klik tombol manual.
    // Fallback sinkron dipakai lebih dulu agar UI tidak menunggu jaringan.
    async recalculateAll() {
      try {
        const res = await fetch('/api/sheets/eval', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cells: this.cells })
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.cells) {
            this.cells = data.cells;
            this.render();
            this.updateFormulaBar();
            if (typeof this.onCellChange === 'function') this.onCellChange(this.cells);
            return data.cells;
          }
        }
      } catch { /* jaringan gagal -> pakai hasil fallback di bawah */ }
      this.render();
      return this.cells;
    }

    // ==== SUNTING DI DALAM SEL ====
    startCellEdit(initialChar) {
      this.editing = true;
      this.editBuffer = initialChar || '';
      this.render();
      this.updateFormulaBar();
    }

    startCellEditExisting() {
      const coord = this.getActiveCoord();
      const cell = this.cells[coord];
      this.editing = true;
      this.editBuffer = cell ? String(cell.raw !== undefined ? cell.raw : (cell.val !== undefined ? cell.val : '')) : '';
      this.render();
      this.updateFormulaBar();
    }

    async commitEdit() {
      const coord = this.getActiveCoord();
      const rawVal = this.editBuffer;
      this.editing = false;
      this.editBuffer = '';
      await this.commitCoordValue(coord, rawVal);
    }

    // Menulis nilai mentah ke satu koordinat lalu mengevaluasi ulang seluruh grid.
    async commitCoordValue(coord, rawVal) {
      const prevMeta = this.cells[coord] ? { ...this.cells[coord] } : {};
      delete prevMeta.raw;
      delete prevMeta.val;

      try {
        const res = await fetch('/api/sheets/eval', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cells: this.cells, targetCoord: coord, formula: rawVal })
        });
        if (res.ok) {
          const data = await res.json();
          this.cells = data.cells;
        } else {
          this.cells[coord] = { raw: rawVal, val: this.coerce(rawVal), ...prevMeta };
        }
      } catch {
        this.cells[coord] = { raw: rawVal, val: this.coerce(rawVal), ...prevMeta };
      }

      this.render();
      this.updateFormulaBar();
      // Bagan harus ikut berubah saat sel diedit. Tanpa ini overlay bagan
      // tetap menampilkan angka lama sampai dokumen di-reload.
      if (Array.isArray(this.charts) && this.charts.length) this.renderChartOverlay();
      if (typeof this.onCellChange === 'function') this.onCellChange(this.cells);
    }

    notifyChange() {
      if (Array.isArray(this.charts) && this.charts.length) this.renderChartOverlay();
      if (typeof this.onCellChange === 'function') this.onCellChange(this.cells);
    }

    // ==== FORMATTING SEL ====
    // prop: 'bold' | 'italic' | 'color' | 'bg' | 'align' | 'numFormat'
    // value: 'toggle' untuk bold/italic, atau nilai langsung
    applyFormat(prop, value) {
      const coord = this.getActiveCoord();
      if (!this.cells[coord]) this.cells[coord] = { raw: '', val: '' };
      const cell = this.cells[coord];

      if (prop === 'bold' || prop === 'italic') {
        cell[prop] = (value === 'toggle') ? !cell[prop] : !!value;
      } else if (prop === 'numFormat') {
        cell.numFormat = (cell.numFormat === value) ? 'plain' : value;
      } else if (prop === 'align') {
        cell.align = value;
      } else {
        cell[prop] = value;
      }

      this.render();
      this.updateFormulaBar();
      this.notifyChange();
      return cell;
    }

    // Format angka untuk tampilan (bukan mengubah nilai tersimpan).
    // Jumlah desimal mengikuti this.decimals agar tombol .0/.00 berfungsi.
    formatDisplay(val, numFormat) {
      if (typeof val !== 'number' || !isFinite(val)) return String(val);
      const d = (this.decimals === undefined) ? 2 : this.decimals;
      if (numFormat === 'currency') {
        return '$' + val.toFixed(d);
      }
      if (numFormat === 'percent') {
        return (val * 100).toFixed(Math.max(0, Math.min(4, d))) + '%';
      }
      if (numFormat === 'number') {
        return val.toFixed(d);
      }
      return String(val);
    }

    // ==== EKSPOR CSV (RFC 4180) ====
    exportCsv() {
      // Cari batas kolom/baris yang benar-benar berisi data.
      let maxCol = -1, maxRow = 0;
      for (const coord of Object.keys(this.cells)) {
        const m = coord.match(/^([A-Z]+)(\d+)$/);
        if (!m) continue;
        let c = 0;
        for (let i = 0; i < m[1].length; i++) c = c * 26 + (m[1].charCodeAt(i) - 64);
        maxCol = Math.max(maxCol, c - 1);
        maxRow = Math.max(maxRow, parseInt(m[2], 10));
      }
      if (maxCol < 0 || maxRow === 0) return '';

      const esc = (s) => {
        const t = s === undefined || s === null ? '' : String(s);
        return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
      };

      const lines = [];
      for (let r = 1; r <= maxRow; r++) {
        const row = [];
        for (let c = 0; c <= maxCol; c++) {
          const cell = this.cells[`${this.colLabel(c)}${r}`];
          row.push(esc(cell ? cell.val : ''));
        }
        lines.push(row.join(','));
      }
      return lines.join('\r\n');
    }

    render() {
      const parent = this.canvas.parentElement;
      if (parent && parent.clientWidth > 0) {
        this.canvas.width = parent.clientWidth;
        this.canvas.height = parent.clientHeight;
      }

      const ctx = this.ctx;
      const width = this.canvas.width;
      const height = this.canvas.height;
      ctx.clearRect(0, 0, width, height);

      // Header Kolom A, B, C...
      ctx.fillStyle = '#f8f9fa';
      ctx.fillRect(0, 0, width, this.headerHeight);
      ctx.fillRect(0, 0, this.headerWidth, height);

      ctx.font = '12px "Google Sans", Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#5f6368';

      for (let c = 0; c < this.totalCols; c++) {
        const cw = this.getColWidth(c);
        const x = this.getColX(c) - this.scrollX;
        if (x + cw < this.headerWidth || x > width) continue;

        ctx.fillStyle = (c === this.activeCol) ? '#e8f0fe' : '#f8f9fa';
        ctx.fillRect(x, 0, cw, this.headerHeight);
        ctx.strokeStyle = '#dadce0';
        ctx.strokeRect(x, 0, cw, this.headerHeight);

        ctx.fillStyle = (c === this.activeCol) ? '#1a73e8' : '#5f6368';
        ctx.fillText(this.colLabel(c), x + cw / 2, this.headerHeight / 2);
      }

      const visibleRows = Math.ceil(height / this.rowHeight) + 1;
      for (let r = 1; r <= Math.min(this.totalRows, visibleRows); r++) {
        const y = this.headerHeight + ((r - 1) * this.rowHeight) - this.scrollY;
        if (y + this.rowHeight < this.headerHeight || y > height) continue;

        ctx.fillStyle = (r === this.activeRow) ? '#e8f0fe' : '#f8f9fa';
        ctx.fillRect(0, y, this.headerWidth, this.rowHeight);
        ctx.strokeStyle = '#dadce0';
        ctx.strokeRect(0, y, this.headerWidth, this.rowHeight);

        ctx.fillStyle = (r === this.activeRow) ? '#1a73e8' : '#5f6368';
        ctx.fillText(r.toString(), this.headerWidth / 2, y + this.rowHeight / 2);

        for (let c = 0; c < this.totalCols; c++) {
          const cw = this.getColWidth(c);
          const x = this.getColX(c) - this.scrollX;
          if (x + cw < this.headerWidth || x > width) continue;

          const coord = `${this.colLabel(c)}${r}`;
          const cell = this.cells[coord];

          // Baris/kolom aktif mendapat sorotan penuh (ala Google Sheets).
          if (r === this.activeRow || c === this.activeCol) {
            ctx.save();
            ctx.fillStyle = '#f1f8fe';
            ctx.fillRect(x + 1, y + 1, cw - 1, this.rowHeight - 1);
            ctx.restore();
          }

          // Latar sel (jika diformat) digambar sebelum garis grid.
          if (cell && cell.bg) {
            ctx.save();
            ctx.fillStyle = cell.bg;
            ctx.fillRect(x + 1, y + 1, cw - 1, this.rowHeight - 1);
            ctx.restore();
          }

          ctx.strokeStyle = '#e8eaed';
          ctx.strokeRect(x, y, cw, this.rowHeight);

          // Saat menyunting di sel, buffer pengguna yang dirender (bukan nilai lama).
          const isEditingThis = this.editing && coord === this.getActiveCoord();
          const v = isEditingThis ? this.editBuffer : (cell ? cell.val : undefined);

          if (v !== undefined && v !== null && v !== '') {
            ctx.save();
            const isNum = typeof v === 'number';
            const align = cell && cell.align ? cell.align : (isNum ? 'right' : 'left');

            let fontStyle = '';
            if (cell && cell.italic) fontStyle += 'italic ';
            if (cell && cell.bold) fontStyle += 'bold ';
            ctx.font = `${fontStyle}12px Arial`;
            ctx.fillStyle = (cell && cell.color) ? cell.color : '#202124';
            // Token error formula (#DIV/0!, #NAME?, #VALUE!, #ERROR!) tampil
            // merah seperti Google Sheets, bukan hitam seperti teks biasa.
            if (typeof v === 'string' && /^#[A-Z0-9\/?!]+/.test(v)) {
              ctx.fillStyle = '#d93025';
            }

            const label = isEditingThis ? v : this.formatDisplay(v, cell && cell.numFormat);
            let printX;
            if (align === 'center') {
              ctx.textAlign = 'center';
              printX = x + cw / 2;
            } else if (align === 'right') {
              ctx.textAlign = 'right';
              printX = x + cw - 8;
            } else {
              ctx.textAlign = 'left';
              printX = x + 8;
            }
            ctx.fillText(label, printX, y + this.rowHeight / 2);
            ctx.restore();
          }
        }
      }

      // ==== OVERLAY SELEKSI RENTANG (paritas Google Sheets) ====
      // Digambar SEBELUM border sel aktif. Warna & ukuran mengikuti Sheets asli:
      // isi biru transparan, tepi #1a73e8 2px, fill handle 6x6 di pojok kanan-bawah.
      const rb = this.getRangeBounds();
      const rangeMulti = (rb.minCol !== rb.maxCol || rb.minRow !== rb.maxRow);
      let handleX = 0, handleY = 0, handleVisible = false;

      if (rangeMulti) {
        const rx = this.getColX(rb.minCol) - this.scrollX;
        const ry = this.headerHeight + ((rb.minRow - 1) * this.rowHeight) - this.scrollY;
        const rw = this.getColX(rb.maxCol + 1) - this.getColX(rb.minCol);
        const rh = (rb.maxRow - rb.minRow + 1) * this.rowHeight;

        // Potong area agar tidak menimpa header kolom/baris.
        ctx.save();
        ctx.beginPath();
        ctx.rect(this.headerWidth, this.headerHeight, width - this.headerWidth, height - this.headerHeight);
        ctx.clip();

        // 1) Isi biru transparan di seluruh area rentang.
        ctx.fillStyle = 'rgba(26, 115, 232, 0.12)';
        ctx.fillRect(rx, ry, rw, rh);

        // 2) Tepi luar rentang.
        ctx.strokeStyle = '#1a73e8';
        ctx.lineWidth = 2;
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.lineWidth = 1;
        ctx.restore();

        handleX = rx + rw - 4;
        handleY = ry + rh - 4;
        handleVisible = true;
      }

      // Active Cell Selection Border (Google Green #0f9d58)
      const selW = this.getColWidth(this.activeCol);
      const selX = this.getColX(this.activeCol) - this.scrollX;
      const selY = this.headerHeight + ((this.activeRow - 1) * this.rowHeight) - this.scrollY;

      if (selX + selW >= this.headerWidth && selX <= width && selY + this.rowHeight >= this.headerHeight && selY <= height) {
        ctx.strokeStyle = '#0f9d58';
        ctx.lineWidth = 2;
        ctx.strokeRect(selX, selY, selW, this.rowHeight);

        ctx.fillStyle = '#0f9d58';
        ctx.fillRect(selX + selW - 4, selY + this.rowHeight - 4, 6, 6);
        ctx.lineWidth = 1;
      }

      // 3) Fill handle di pojok kanan-bawah rentang: kotak biru bertepi putih.
      if (handleVisible && handleX >= this.headerWidth && handleY >= this.headerHeight) {
        ctx.save();
        ctx.fillStyle = '#1a73e8';
        ctx.fillRect(handleX, handleY, 6, 6);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.strokeRect(handleX + 0.5, handleY + 0.5, 5, 5);
        ctx.restore();
      }

      // ==== GARIS PANDUAN RESIZE KOLOM (paritas Google Sheets) ====
      // Digambar paling akhir supaya berada di atas grid, teks, dan overlay
      // seleksi. Hanya muncul selama drag berlangsung.
      if (this.isResizingCol && this.resizeColIdx >= 0) {
        const gx = this.colBoundaryX(this.resizeColIdx) - this.scrollX;
        if (gx >= this.headerWidth && gx <= width) {
          ctx.save();
          // Garis vertikal penuh dari atas kanvas sampai bawah.
          ctx.strokeStyle = '#1a73e8';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(gx, 0);
          ctx.lineTo(gx, height);
          ctx.stroke();
          // Label lebar kolom (px) di dekat header, seperti tooltip Sheets.
          const labelTxt = `${this.getColWidth(this.resizeColIdx)} px`;
          ctx.font = '600 11px Arial, sans-serif';
          const tw = ctx.measureText(labelTxt).width;
          const bx = Math.min(gx + 6, width - tw - 14);
          const by = Math.max(2, this.headerHeight + 4);
          ctx.fillStyle = '#1a73e8';
          ctx.fillRect(bx, by, tw + 12, 18);
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(labelTxt, bx + 6, by + 9);
          ctx.restore();
        }
      }
    }
  }

  window.RitzSpreadsheetEditor = RitzSpreadsheetEditor;
})(window);
