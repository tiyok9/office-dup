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

      // ==== FREEZE PANE (paritas Google Sheets: Bekukan baris/kolom) ====
      // Jumlah baris teratas / kolom terkiri yang TIDAK ikut ter-scroll.
      // 0 = tidak ada panel beku; perilaku identik dengan versi sebelumnya.
      this.frozenRows = 0;
      this.frozenCols = 0;

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

      // ==== AUTOFILL / FILL HANDLE (paritas Google Sheets) ====
      // Kotak 6x6 di pojok kanan-bawah seleksi sudah digambar sejak fc733b6,
      // tetapi belum bereaksi apa pun. State di bawah menghidupkannya.
      // autofillOrigin = rentang SUMBER (tetap), autofillTarget = rentang
      // perluasan saat drag. Keduanya memakai bentuk getRangeBounds().
      this.isAutofilling = false;
      this.autofillOrigin = null;
      this.autofillTarget = null;
      this._hoverFillHandle = false;

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
      // Panel beku milik sheet ini (tiap tab bisa punya freeze berbeda).
      s.frozen = {
        rows: Math.max(0, Number(this.frozenRows) || 0),
        cols: Math.max(0, Number(this.frozenCols) || 0)
      };
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

    // Kebalikan getColX: kolom mana yang berada pada x KONTEN (belum diskrol).
    _colAtContentX(x) {
      if (x < this.headerWidth) return -1;
      let acc = this.headerWidth;
      for (let i = 0; i < this.totalCols; i++) {
        const w = this.getColWidth(i);
        if (x < acc + w) return i;
        acc += w;
      }
      return -1;
    }

    // ==== FREEZE PANE: GEOMETRI TERPUSAT ====
    // Dua helper di bawah adalah SATU-SATUNYA sumber koordinat sel. Semua render,
    // hit-testing, overlay seleksi, fill handle, dan autofill wajib lewat sini.
    // Saat frozenRows/frozenCols = 0 rumusnya IDENTIK dengan versi lama
    // (headerHeight + (r-1)*rowHeight - scrollY), jadi tidak ada regresi.
    freezeX() {
      return this.headerWidth + this.colsWidthUpto(this.frozenCols);
    }

    freezeY() {
      return this.headerHeight + this.frozenRows * this.rowHeight;
    }

    // x KIRI kolom c dalam koordinat kanvas. Kolom beku mengabaikan scrollX.
    cellX(c) {
      const raw = this.getColX(c);
      return (c < this.frozenCols) ? raw : raw - this.scrollX;
    }

    // y ATAS baris r (1-based) dalam koordinat kanvas. Baris beku mengabaikan scrollY.
    cellY(r) {
      const raw = this.headerHeight + ((r - 1) * this.rowHeight);
      return (r <= this.frozenRows) ? raw : raw - this.scrollY;
    }

    // Kebalikan cellX/cellY: x kanvas -> indeks kolom (menghormati panel beku).
    colFromX(x) {
      if (x < this.headerWidth) return -1;
      // Di dalam area beku, konten tidak bergeser.
      if (x < this.freezeX()) return this._colAtContentX(x);
      return this._colAtContentX(x + this.scrollX);
    }

    colBoundaryX(c) {
      return this.getColX(c) + this.getColWidth(c);
    }

    // Deteksi pointer berada di garis pemisah header kolom (toleransi 4px).
    // Dipakai untuk kursor col-resize sekaligus memulai drag resize.
    colResizeHit(x, y) {
      if (y > this.headerHeight || x < this.headerWidth) return -1;
      for (let i = 0; i < this.totalCols; i++) {
        const bx = this.cellX(i) + this.getColWidth(i);
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

    // ==== AUTOFILL: GEOMETRI & HIT-TESTING ====
    // y ATAS baris r dalam koordinat kanvas (lihat cellY).
    getRowY(r) {
      return this.cellY(r);
    }

    // Kebalikan cellY: y kanvas -> nomor baris (menghormati panel beku).
    // Saat frozenRows = 0 rumusnya IDENTIK dengan versi lama.
    rowFromY(y) {
      if (y < this.headerHeight) return -1;
      let r;
      if (this.frozenRows > 0 && y < this.freezeY()) {
        // Di dalam area beku, konten tidak bergeser.
        r = Math.floor((y - this.headerHeight) / this.rowHeight) + 1;
      } else {
        const rel = y - this.freezeY() + this.scrollY;
        r = this.frozenRows + 1 + Math.floor(rel / this.rowHeight);
      }
      return (r >= 1 && r <= this.totalRows) ? r : -1;
    }

    // Kotak fill handle 6x6 di pojok kanan-bawah seleksi. Koordinatnya HARUS
    // identik dengan yang digambar render(): biru (rentang) dan hijau (sel
    // tunggal) sama-sama mendarat di rx+rw-4, ry+rh-4 — jadi satu hit-test
    // cukup untuk keduanya.
    fillHandleRect() {
      const rb = this.getRangeBounds();
      const rx = this.cellX(rb.minCol);
      const ry = this.cellY(rb.minRow);
      const rw = this.getColX(rb.maxCol + 1) - this.getColX(rb.minCol);
      const rh = (rb.maxRow - rb.minRow + 1) * this.rowHeight;
      return { x: rx + rw - 4, y: ry + rh - 4, w: 6, h: 6 };
    }

    // Toleransi klik sedikit lebih lebar dari 6x6 aslinya supaya handle kecil
    // tetap mudah ditangkap mouse (Sheets punya toleransi serupa).
    isOverFillHandle(x, y) {
      if (this.isResizingCol || this.editing) return false;
      const h = this.fillHandleRect();
      if (h.x < this.headerWidth - 8 || h.y < this.headerHeight - 8) return false;
      const pad = 4;
      return x >= h.x - pad && x <= h.x + h.w + pad && y >= h.y - pad && y <= h.y + h.h + pad;
    }

    // Kebalikan colLabel(): "A" -> 0, "AA" -> 26.
    colIndexFromLabel(txt) {
      const s = String(txt || '').toUpperCase();
      let n = 0;
      for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
      return n - 1;
    }

    // Geser SEMUA referensi A1 di dalam rumus sebesar (dCol, dRow).
    // $A$1 tidak digeser, $A1 hanya baris, A$1 hanya kolom. Isi string
    // literal ("...") tidak disentuh, dan nama fungsi seperti LOG10( tidak
    // salah ditafsirkan sebagai referensi.
    shiftFormula(raw, dCol, dRow) {
      if (typeof raw !== 'string' || raw.charAt(0) !== '=') return raw;
      if (!dCol && !dRow) return raw;
      const REF = /(?<![A-Za-z0-9_$])(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(])/g;
      // Pisahkan string literal agar tidak ikut digeser.
      const parts = raw.split(/("(?:[^"]|"")*")/);
      return parts.map((seg, i) => {
        if (i % 2 === 1) return seg;
        return seg.replace(REF, (m, cAbs, colTxt, rAbs, rowTxt) => {
          let col = this.colIndexFromLabel(colTxt);
          let row = parseInt(rowTxt, 10);
          if (!cAbs) col += dCol;
          if (!rAbs) row += dRow;
          if (col < 0 || col >= this.totalCols || row < 1 || row > this.totalRows) return m;
          return `${cAbs ? '$' : ''}${this.colLabel(col)}${rAbs ? '$' : ''}${row}`;
        });
      }).join('');
    }

    // ==== AUTOFILL: LOGIKA PENGISIAN ====
    // Menerima rentang SUMBER dan rentang TUJUAN (bentuk getRangeBounds()),
    // lalu mengisi bagian di luar sumber. Empat pola, sesuai perilaku Sheets:
    //   1) formula  -> referensi relatif digeser per baris/kolom
    //   2) angka    -> deret aritmatika bila >= 2 angka, selain itu salin
    //   3) teks+angka di ujung ("Bab 1") -> angka dinaikkan
    //   4) selain itu -> salin berulang mengikuti pola sumber
    // Arah didukung: bawah, atas, kanan, kiri (tidak hanya ke bawah).
    applyAutofill(origin, target) {
      if (!origin || !target) return 0;
      const srcRows = origin.maxRow - origin.minRow + 1;
      const srcCols = origin.maxCol - origin.minCol + 1;

      // Kumpulan nilai sumber per posisi relatif (dipakai untuk pola siklus).
      const srcCells = [];
      for (let r = origin.minRow; r <= origin.maxRow; r++) {
        const rowVals = [];
        for (let c = origin.minCol; c <= origin.maxCol; c++) {
          const cell = this.cells[`${this.colLabel(c)}${r}`];
          rowVals.push(cell ? { ...cell } : null);
        }
        srcCells.push(rowVals);
      }

      const numOf = (cell) => {
        if (!cell) return null;
        const v = (cell.val !== undefined && cell.val !== '') ? cell.val : cell.raw;
        if (typeof v === 'number') return v;
        if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
        return null;
      };
      const isFormula = (cell) => !!cell && typeof cell.raw === 'string' && cell.raw.charAt(0) === '=';
      const hasFormula = srcCells.some(row => row.some(isFormula));

      let written = 0;
      for (let r = target.minRow; r <= target.maxRow; r++) {
        for (let c = target.minCol; c <= target.maxCol; c++) {
          // Lewati sel yang masih bagian dari rentang sumber.
          const inSrc = r >= origin.minRow && r <= origin.maxRow && c >= origin.minCol && c <= origin.maxCol;
          if (inSrc) continue;

          // Sel sumber acuan: dipetakan periodik terhadap ukuran sumber.
          const srcRowIdx = ((r - origin.minRow) % srcRows + srcRows) % srcRows;
          const srcColIdx = ((c - origin.minCol) % srcCols + srcCols) % srcCols;
          const ref = srcCells[srcRowIdx] && srcCells[srcRowIdx][srcColIdx];

          const coord = `${this.colLabel(c)}${r}`;
          if (!ref) { delete this.cells[coord]; continue; }

          const prevMeta = this.cells[coord] ? { ...this.cells[coord] } : {};

          if (isFormula(ref)) {
            // Pergeseran dihitung dari sel sumber acuan ke sel tujuan.
            const fromCol = origin.minCol + srcColIdx;
            const fromRow = origin.minRow + srcRowIdx;
            const shifted = this.shiftFormula(ref.raw, c - fromCol, r - fromRow);
            this.cells[coord] = { ...prevMeta, raw: shifted, val: this.coerce(shifted) };
            written++;
            continue;
          }

          // Deret angka: hanya bila SELURUH kolom sumber numerik & >= 2 baris.
          const colVals = srcCells.map(row => numOf(row[srcColIdx]));
          const allNum = srcRows >= 2 && colVals.every(v => v !== null);
          if (allNum && !hasFormula) {
            const step = (colVals[colVals.length - 1] - colVals[0]) / (srcRows - 1);
            // Indeks langkah relatif terhadap baris sumber pertama.
            const stepsFromStart = r - origin.minRow;
            const n = colVals[0] + step * stepsFromStart;
            const rounded = Math.round(n * 1e10) / 1e10;
            this.cells[coord] = { ...prevMeta, raw: String(rounded), val: rounded };
            written++;
            continue;
          }

          // Teks berakhiran angka: "Bab 1" -> "Bab 2", "Bab 3", ...
          const rawTxt = ref.raw !== undefined ? String(ref.raw) : (ref.val !== undefined ? String(ref.val) : '');
          const m = /^(.*?)(\d+)$/.exec(rawTxt);
          // Angka MURNI tunggal disalin, bukan dijadikan deret. Di Google Sheets
          // deret hanya lahir dari >= 2 sel angka; "7" diseret tetap "7".
          // Karena itu pola "teks berakhiran angka" hanya boleh jalan bila ada
          // awalan non-angka ("Bab 1" ya, "7" tidak).
          const pureNum = rawTxt.trim() !== '' && !isNaN(Number(rawTxt));
          if (m && !pureNum && m[1].trim() !== '' && !hasFormula && srcRows * srcCols === 1) {
            const base = parseInt(m[2], 10);
            const delta = (r - origin.minRow) + (c - origin.minCol);
            const nextTxt = `${m[1]}${base + delta}`;
            this.cells[coord] = { ...prevMeta, raw: nextTxt, val: this.coerce(nextTxt) };
            written++;
            continue;
          }

          // Pola umum: salin nilai sumber (siklus).
          const copyRaw = ref.raw !== undefined ? ref.raw : '';
          this.cells[coord] = { ...prevMeta, raw: copyRaw, val: ref.val !== undefined ? ref.val : this.coerce(copyRaw) };
          written++;
        }
      }

      if (written) {
        this.recalculateAll();
      }
      return written;
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
          colWidths: (s && s.colWidths && typeof s.colWidths === 'object') ? { ...s.colWidths } : {},
          // Panel beku per sheet ikut dipulihkan (dokumen lama tanpa frozen -> 0).
          frozen: (s && s.frozen && typeof s.frozen === 'object')
            ? { rows: Math.max(0, Number(s.frozen.rows) || 0), cols: Math.max(0, Number(s.frozen.cols) || 0) }
            : { rows: 0, cols: 0 }
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

    // ==== FREEZE PANE: API PUBLIK ====
    // rows/cols = jumlah baris/kolom teratas yang dibekukan. Nilai di-clamp ke
    // ukuran grid supaya dokumen rusak (mis. frozen 9999) tidak mematikan render.
    // State disimpan per sheet dan memicu autosave lewat notifyChange().
    setFrozen(rows, cols) {
      const rr = (rows === undefined || rows === null) ? this.frozenRows : rows;
      const cc = (cols === undefined || cols === null) ? this.frozenCols : cols;
      this.frozenRows = Math.max(0, Math.min(this.totalRows, Math.round(Number(rr) || 0)));
      this.frozenCols = Math.max(0, Math.min(this.totalCols, Math.round(Number(cc) || 0)));
      // Simpan ke sheet aktif SEKARANG, jangan menunggu switchSheet.
      this._syncActiveSheet();
      this.render();
      this.notifyChange();
      return { rows: this.frozenRows, cols: this.frozenCols };
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
          // ==== AUTOFILL: MULAI SERET FILL HANDLE (paritas Google Sheets) ====
          // Dicek SEBELUM seleksi sel, supaya menyeret handle tidak mengubah
          // jangkar seleksi. Handle kecil (6x6) dengan toleransi 4px.
          if (this.isOverFillHandle(x, y)) {
            this.isAutofilling = true;
            this.autofillOrigin = this.getRangeBounds();
            this.autofillTarget = { ...this.autofillOrigin };
            this.isSelecting = false;
            e.preventDefault();
            this.render();
            return;
          }

          // colFromX()/rowFromY() menghormati lebar kolom dan panel beku.
          const clickedCol = this.colFromX(x);
          const clickedRow = this.rowFromY(y);

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
        const col = this.colFromX(x);
        const row = this.rowFromY(y);
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

        // ==== DRAG AUTOFILL (paritas Google Sheets) ====
        // Target diperluas mengikuti sel di bawah kursor. Arah ditentukan oleh
        // posisi kursor relatif terhadap rentang sumber: di bawah -> bawah,
        // di atas -> atas, di kanan -> kanan, di kiri -> kiri. Preview digambar
        // oleh render() sebagai kotak putus-putus.
        if (this.isAutofilling && this.autofillOrigin) {
          const o = this.autofillOrigin;
          const curCol = this.colFromX(mx);
          const curRow = this.rowFromY(my);
          if (curCol < 0 || curRow < 0) return;
          const t = { ...o };
          if (curRow > o.maxRow) { t.maxRow = curRow; t.minRow = o.minRow; }
          else if (curRow < o.minRow) { t.minRow = curRow; t.maxRow = o.maxRow; }
          if (curCol > o.maxCol) { t.maxCol = curCol; t.minCol = o.minCol; }
          else if (curCol < o.minCol) { t.minCol = curCol; t.maxCol = o.maxCol; }
          if (JSON.stringify(t) !== JSON.stringify(this.autofillTarget)) {
            this.autofillTarget = t;
            this.render();
          }
          return;
        }

        // ==== HOVER GARIS KOLOM -> kursor col-resize ====
        // Memakai colResizeHit() yang SAMA dengan mousedown, sehingga area
        // hover dan area klik selalu identik (tidak ada zona "hampir kena").
        if (!this.isSelecting && !this.editing) {
          // Fill handle dicek lebih dulu: kursor crosshair menandakan handle
          // bisa diseret, dan posisinya menang atas garis kolom.
          if (this.isOverFillHandle(mx, my)) {
            if (!this._hoverFillHandle) {
              this._hoverFillHandle = true;
              this._hoverResizeCol = -1;
              this.canvas.style.cursor = 'crosshair';
            }
            return;
          }
          if (this._hoverFillHandle) {
            this._hoverFillHandle = false;
            this.canvas.style.cursor = 'cell';
          }
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
        // ==== SELESAI AUTOFILL (paritas Google Sheets) ====
        // Isi rentang tujuan, jadikan rentang hasil sebagai seleksi baru,
        // lalu picu autosave. Dicek sebelum logika seleksi.
        if (this.isAutofilling) {
          const o = this.autofillOrigin;
          const t = this.autofillTarget;
          this.isAutofilling = false;
          this.autofillOrigin = null;
          this.autofillTarget = null;
          this._hoverFillHandle = false;
          this.canvas.style.cursor = 'cell';
          if (o && t) {
            const wrote = this.applyAutofill(o, t);
            // Seleksi mengikuti hasil pengisian, persis seperti Sheets.
            if (wrote > 0) {
              this.selStartCol = t.minCol;
              this.selStartRow = t.minRow;
              this.selEndCol = t.maxCol;
              this.selEndRow = t.maxRow;
              this.activeCol = t.minCol;
              this.activeRow = t.minRow;
              this._syncActiveSheet();
              if (typeof this.onCellChange === 'function') this.onCellChange(this.cells);
            }
          }
          this.render();
          this.updateFormulaBar();
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
          const clickedCol = this.colFromX(x);
          const clickedRow = this.rowFromY(y);
          if (clickedCol === this.activeCol && clickedRow === this.activeRow) {
            this.startCellEditExisting();
          }
        }
      });

      // Scroll (roda mouse) — Shift+roda = horizontal, roda biasa = vertikal.
      // Scroll horizontal diperlukan agar panel beku KOLOM punya arti: tanpa
      // scrollX yang bisa berubah, kolom beku dan kolom biasa tampak identik.
      this.canvas.addEventListener('wheel', (e) => {
        const horiz = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
        if (horiz) {
          const viewW = this.canvas.width - this.headerWidth;
          const maxX = Math.max(0, this.getColX(this.totalCols) - viewW);
          const step = e.deltaX || (e.deltaY > 0 ? 3 : -3) * this.colWidth;
          this.scrollX = Math.max(0, Math.min(maxX, this.scrollX + step));
        } else {
          this.scrollY = Math.max(0, this.scrollY + (e.deltaY > 0 ? 3 : -3) * this.rowHeight);
        }
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

      // ==== FREEZE PANE: BATAS REGION ====
      // fRows/fCols = jumlah baris/kolom beku. Saat keduanya 0, bodyX/bodyY
      // sama dengan headerWidth/headerHeight -> gambar identik versi lama.
      const fRows = Math.max(0, Math.min(this.totalRows, Math.round(this.frozenRows) || 0));
      const fCols = Math.max(0, Math.min(this.totalCols, Math.round(this.frozenCols) || 0));
      const fRight = this.freezeX();
      const fBottom = this.freezeY();
      const bodyX = fCols > 0 ? fRight : this.headerWidth;
      const bodyY = fRows > 0 ? fBottom : this.headerHeight;

      const paintColHeader = (c) => {
        const cw = this.getColWidth(c);
        const x = this.cellX(c);
        if (x + cw < this.headerWidth || x > width) return;

        ctx.fillStyle = (c === this.activeCol) ? '#e8f0fe' : '#f8f9fa';
        ctx.fillRect(x, 0, cw, this.headerHeight);
        ctx.strokeStyle = '#dadce0';
        ctx.strokeRect(x, 0, cw, this.headerHeight);

        ctx.fillStyle = (c === this.activeCol) ? '#1a73e8' : '#5f6368';
        ctx.fillText(this.colLabel(c), x + cw / 2, this.headerHeight / 2);
      };

      // Kolom beku digambar statis (tanpa scrollX); sisanya di-clip ke kanannya.
      for (let c = 0; c < fCols; c++) paintColHeader(c);
      ctx.save();
      ctx.beginPath();
      ctx.rect(bodyX, 0, Math.max(0, width - bodyX), this.headerHeight);
      ctx.clip();
      for (let c = fCols; c < this.totalCols; c++) paintColHeader(c);
      ctx.restore();

      // ==== PENGGAMBARAN SEL: DUA REGION (paritas Google Sheets freeze pane) ====
      // Region bebas (r > fRows) digambar dengan scrollY dan di-clip ke bawah
      // region beku. Region beku (r <= fRows) digambar statis dengan latar
      // legok. Saat fRows=0, bodyY=headerHeight -> identik versi lama.
      // startRow kini berbasis scrollY (memperbaiki bug kanvas kosong saat
      // scrollY > tinggi viewport — bug bawaan sebelum refactor ini).
      const paintRowHeader = (r) => {
        const y = this.cellY(r);
        if (y + this.rowHeight < this.headerHeight || y > height) return;
        ctx.fillStyle = (r === this.activeRow) ? '#e8f0fe' : '#f8f9fa';
        ctx.fillRect(0, y, this.headerWidth, this.rowHeight);
        ctx.strokeStyle = '#dadce0';
        ctx.strokeRect(0, y, this.headerWidth, this.rowHeight);
        ctx.fillStyle = (r === this.activeRow) ? '#1a73e8' : '#5f6368';
        ctx.fillText(r.toString(), this.headerWidth / 2, y + this.rowHeight / 2);
      };

      const paintCell = (r, c) => {
        const cw = this.getColWidth(c);
        const x = this.cellX(c);
        const y = this.cellY(r);
        if (x + cw < this.headerWidth || x > width) return;
        if (y + this.rowHeight < this.headerHeight || y > height) return;
        const coord = `${this.colLabel(c)}${r}`;
        const cell = this.cells[coord];

        if (r === this.activeRow || c === this.activeCol) {
          ctx.save();
          ctx.fillStyle = '#f1f8fe';
          ctx.fillRect(x + 1, y + 1, cw - 1, this.rowHeight - 1);
          ctx.restore();
        }
        if (cell && cell.bg) {
          ctx.save();
          ctx.fillStyle = cell.bg;
          ctx.fillRect(x + 1, y + 1, cw - 1, this.rowHeight - 1);
          ctx.restore();
        }
        ctx.strokeStyle = '#e8eaed';
        ctx.strokeRect(x, y, cw, this.rowHeight);

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
          if (typeof v === 'string' && /^#[A-Z0-9\\/?!]+/.test(v)) {
            ctx.fillStyle = '#d93025';
          }
          const label = isEditingThis ? v : this.formatDisplay(v, cell && cell.numFormat);
          let printX;
          if (align === 'center') {
            ctx.textAlign = 'center'; printX = x + cw / 2;
          } else if (align === 'right') {
            ctx.textAlign = 'right'; printX = x + cw - 8;
          } else {
            ctx.textAlign = 'left'; printX = x + 8;
          }
          ctx.fillText(label, printX, y + this.rowHeight / 2);
          ctx.restore();
        }
      };

      // --- EMPAT KUADRAN (paritas Google Sheets freeze pane) ---
      // Tiap kuadran di-clip ke kotaknya sendiri supaya sel yang ter-scroll
      // TIDAK PERNAH menimpa panel beku. cellX()/cellY() sudah membuat baris &
      // kolom beku mengabaikan scroll, jadi tiap kuadran cukup memakai rentang
      // baris/kolom yang tepat. Saat fRows=fCols=0 hanya kuadran 1 yang jalan
      // dan hasilnya identik dengan versi lama.
      const visCount = Math.ceil(height / this.rowHeight) + 2;
      const firstBodyRow = fRows + 1 + Math.max(0, Math.floor(this.scrollY / this.rowHeight));
      const lastBodyRow = Math.min(this.totalRows, firstBodyRow + visCount);
      const bodyFrom = Math.max(fRows + 1, firstBodyRow);

      // Header baris digambar terpisah: kolom header (x 0..headerWidth) berada
      // DI LUAR klip sel, jadi tidak boleh ikut terpotong oleh clip kuadran.
      const paintRowHeaders = (rFrom, rTo, cy, ch) => {
        if (ch <= 0 || rTo < rFrom) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, cy, this.headerWidth, ch);
        ctx.clip();
        for (let r = rFrom; r <= rTo; r++) paintRowHeader(r);
        ctx.restore();
      };

      const paintQuadrant = (rFrom, rTo, cFrom, cTo, cx, cy, cw, ch, opaque) => {
        if (cw <= 0 || ch <= 0 || rTo < rFrom || cTo < cFrom) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx, cy, cw, ch);
        ctx.clip();
        // Latar legok: menutup sel ter-scroll yang ada di bawahnya (anti-ghosting).
        if (opaque) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(cx, cy, cw, ch);
        }
        for (let r = rFrom; r <= rTo; r++) {
          for (let c = cFrom; c <= cTo; c++) paintCell(r, c);
        }
        ctx.restore();
      };

      // 1) Badan: r > fRows, c > fCols — satu-satunya area yang bergerak 2 arah.
      paintQuadrant(bodyFrom, lastBodyRow, fCols, this.totalCols - 1,
        bodyX, bodyY, width - bodyX, height - bodyY, false);
      // 2) Kolom beku: x statis, y ikut scroll.
      if (fCols > 0) {
        paintQuadrant(bodyFrom, lastBodyRow, 0, fCols - 1,
          this.headerWidth, bodyY, bodyX - this.headerWidth, height - bodyY, false);
      }
      // 3) Baris beku: y statis, x ikut scroll.
      if (fRows > 0) {
        paintQuadrant(1, fRows, fCols, this.totalCols - 1,
          bodyX, this.headerHeight, width - bodyX, bodyY - this.headerHeight, true);
      }
      // 4) Sudut beku: statis total (baris DAN kolom beku).
      if (fRows > 0 && fCols > 0) {
        paintQuadrant(1, fRows, 0, fCols - 1,
          this.headerWidth, this.headerHeight,
          bodyX - this.headerWidth, bodyY - this.headerHeight, true);
      }

      // Header baris: band badan (ter-scroll) lalu band beku (statis).
      paintRowHeaders(bodyFrom, lastBodyRow, bodyY, height - bodyY);
      if (fRows > 0) paintRowHeaders(1, fRows, this.headerHeight, bodyY - this.headerHeight);

      // ==== GARIS PEMBATAS FREEZE (paritas Google Sheets) ====
      if (fRows > 0) {
        ctx.save();
        ctx.strokeStyle = '#80868b'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, bodyY); ctx.lineTo(width, bodyY); ctx.stroke();
        ctx.restore();
      }
      if (fCols > 0) {
        ctx.save();
        ctx.strokeStyle = '#80868b'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(bodyX, 0); ctx.lineTo(bodyX, height); ctx.stroke();
        ctx.restore();
      }

      // ==== OVERLAY SELEKSI RENTANG (paritas Google Sheets) ====
      // Digambar SEBELUM border sel aktif. Warna & ukuran mengikuti Sheets asli:
      // isi biru transparan, tepi #1a73e8 2px, fill handle 6x6 di pojok kanan-bawah.
      const rb = this.getRangeBounds();
      const rangeMulti = (rb.minCol !== rb.maxCol || rb.minRow !== rb.maxRow);
      let handleX = 0, handleY = 0, handleVisible = false;

      if (rangeMulti) {
        const rx = this.cellX(rb.minCol);
        const ry = this.cellY(rb.minRow);
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
      const selX = this.cellX(this.activeCol);
      const selY = this.cellY(this.activeRow);

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

      // ==== PRATINJAU AUTOFILL (paritas Google Sheets) ====
      // Selama handle diseret, area perluasan digambar sebagai kotak putus-putus
      // biru supaya user melihat persis sel mana yang akan terisi SEBELUM
      // melepas mouse. Digambar di atas overlay seleksi, di bawah garis resize.
      if (this.isAutofilling && this.autofillTarget) {
        const t = this.autofillTarget;
        const px = this.cellX(t.minCol);
        const py = this.cellY(t.minRow);
        const pw = this.getColX(t.maxCol + 1) - this.getColX(t.minCol);
        const ph = (t.maxRow - t.minRow + 1) * this.rowHeight;
        ctx.save();
        ctx.beginPath();
        ctx.rect(this.headerWidth, this.headerHeight, width - this.headerWidth, height - this.headerHeight);
        ctx.clip();
        ctx.strokeStyle = '#1a73e8';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(px, py, pw, ph);
        ctx.setLineDash([]);
        // Label rentang tujuan (mis. "A1:A5") menempel di kotak, seperti Sheets.
        const tgtTxt = `${this.colLabel(t.minCol)}${t.minRow}:${this.colLabel(t.maxCol)}${t.maxRow}`;
        ctx.font = '600 11px Arial, sans-serif';
        const ttw = ctx.measureText(tgtTxt).width;
        const tbx = Math.min(px + 2, width - ttw - 12);
        const tby = Math.max(this.headerHeight + 2, py - 18);
        ctx.fillStyle = '#1a73e8';
        ctx.fillRect(tbx, tby, ttw + 10, 16);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(tgtTxt, tbx + 5, tby + 8);
        ctx.restore();
      }

      // ==== GARIS PANDUAN RESIZE KOLOM (paritas Google Sheets) ====
      // Digambar paling akhir supaya berada di atas grid, teks, dan overlay
      // seleksi. Hanya muncul selama drag berlangsung.
      if (this.isResizingCol && this.resizeColIdx >= 0) {
        const gx = this.cellX(this.resizeColIdx) + this.getColWidth(this.resizeColIdx);
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
