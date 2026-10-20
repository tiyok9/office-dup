// D:\program\google\tool\engine_prototypes.mjs
// Prototipe referensi ketiga engine rendering berdasarkan temuan reverse-engineering

/**
 * 1. KIX ENGINE PROTOTYPE (Google Docs)
 * Paradigma: Multi-Canvas Tile Virtualization.
 * Halaman dibagi per page container (.kix-page). Elemen canvas dibuat dinamis
 * berdasarkan jangkauan viewport (culling). Teks digambar manual ke canvas.
 */
export class KixTileEngine {
  constructor(pageCount = 10, pageSize = { width: 816, height: 1056 }, pageGap = 20) {
    this.pageCount = pageCount;
    this.pageSize = pageSize;
    this.pageGap = pageGap;
    this.viewport = { y: 0, height: 900 };
    this.mountedTiles = new Map(); // pageIndex -> canvas descriptor
    this.hiddenInputBuffer = ''; // docs-texteventtarget-iframe buffer
    this.totalDomNodes = 50; // base shell chrome
    this.updateVisibleTiles();
  }

  // Intersep pengetikan via hidden text event target
  handleKeystroke(char) {
    this.hiddenInputBuffer += char;
    // Trigger repaint pada tile aktif saat ini
    const activePage = Math.floor(this.viewport.y / (this.pageSize.height + this.pageGap));
    return { bufferLength: this.hiddenInputBuffer.length, targetPage: activePage };
  }

  // Culling dan mount/unmount tile canvas sesuai scroll Y
  scrollTo(y) {
    const prevY = this.viewport.y;
    this.viewport.y = Math.max(0, y);
    const moved = prevY !== this.viewport.y;
    const tileChange = this.updateVisibleTiles();
    return {
      scrollMoved: moved,
      currentY: this.viewport.y,
      mountedCanvasCount: this.mountedTiles.size,
      totalDomNodes: this.totalDomNodes,
      tileMountedDelta: tileChange.mountedDelta,
      visiblePages: Array.from(this.mountedTiles.keys())
    };
  }

  updateVisibleTiles() {
    const vTop = this.viewport.y;
    const vBottom = this.viewport.y + this.viewport.height;
    const oldKeys = new Set(this.mountedTiles.keys());
    const newKeys = new Set();

    let cursorY = 0;
    for (let i = 0; i < this.pageCount; i++) {
      const pageTop = cursorY;
      const pageBottom = cursorY + this.pageSize.height;

      // Cek apakah halaman berada di dalam jendela viewport (dengan buffer)
      if (pageBottom >= vTop - 100 && pageTop <= vBottom + 100) {
        newKeys.add(i);
        if (!this.mountedTiles.has(i)) {
          this.mountedTiles.set(i, {
            pageIndex: i,
            top: pageTop,
            canvasClass: 'kix-canvas-tile-content',
            renderedLines: 40
          });
          this.totalDomNodes += 2; // Tambahan div.kix-page & canvas tile
        }
      }
      cursorY = pageBottom + this.pageGap;
    }

    // Unmount halaman yang keluar jauh dari viewport
    for (const key of oldKeys) {
      if (!newKeys.has(key)) {
        this.mountedTiles.delete(key);
        this.totalDomNodes -= 2;
      }
    }

    return { mountedDelta: newKeys.size - oldKeys.size };
  }
}

/**
 * 2. PUNCH ENGINE PROTOTYPE (Google Slides)
 * Paradigma: Pure Vector SVG Scene Graph.
 * 0 canvas. Semua slide dirender menggunakan elemen SVG murni (<g>, <rect>, <text>).
 * Model deck paged (pergantian slide aktif via index).
 */
export class PunchSvgEngine {
  constructor(slideCount = 5) {
    this.slideCount = slideCount;
    this.activeSlideIndex = 0;
    this.canvasCount = 0; // Strict: 0 canvas
    this.slides = Array.from({ length: slideCount }, (_, idx) => ({
      id: `slide_${idx + 1}`,
      viewBox: '0 0 960 540',
      shapes: [
        { type: 'rect', x: 50, y: 50, width: 860, height: 440, fill: '#ffffff' },
        { type: 'text', x: 100, y: 150, textContent: `Slide ${idx + 1}: Agenda`, fontSize: 32 },
        { type: 'path', d: 'M100 200 L800 200', stroke: '#4285f4', strokeWidth: 3 }
      ]
    }));
  }

  selectSlide(index) {
    if (index >= 0 && index < this.slideCount) {
      this.activeSlideIndex = index;
      return { success: true, activeSlide: index, svgRootCount: 1, canvasCount: 0 };
    }
    return { success: false, error: 'Indeks slide di luar batas' };
  }

  // Generate string representasi SVG scene graph
  renderActiveSlideSvg() {
    const s = this.slides[this.activeSlideIndex];
    const elements = s.shapes.map(sh => {
      if (sh.type === 'rect') return `  <rect x="${sh.x}" y="${sh.y}" width="${sh.width}" height="${sh.height}" fill="${sh.fill}"/>`;
      if (sh.type === 'text') return `  <text x="${sh.x}" y="${sh.y}" font-size="${sh.fontSize}">${sh.textContent}</text>`;
      if (sh.type === 'path') return `  <path d="${sh.d}" stroke="${sh.stroke}" stroke-width="${sh.strokeWidth}"/>`;
      return '';
    }).join('\n');

    return `<svg class="punch-viewer-svg" viewBox="${s.viewBox}">\n<g transform="matrix(1 0 0 1 0 0)">\n${elements}\n</g>\n</svg>`;
  }
}

/**
 * 3. RITZ / WAFFLE ENGINE PROTOTYPE (Google Sheets)
 * Paradigma: Single Canvas Virtual Grid + Worker Calculation.
 * 1 canvas tunggal untuk seluruh grid. Scroll diatur secara virtual internal.
 */
export class RitzGridEngine {
  constructor(totalRows = 10000, totalCols = 26) {
    this.totalRows = totalRows;
    this.totalCols = totalCols;
    this.canvasCount = 1; // Strict: 1 single canvas
    this.scrollX = 0;
    this.scrollY = 0;
    this.rowHeight = 24;
    this.colWidth = 100;
    this.viewport = { width: 1280, height: 900 };
    this.cellData = new Map(); // "R,C" -> { value, formula }
  }

  // Intersep custom scroll virtual (bukan DOM native scroll)
  handleVirtualScroll(deltaX, deltaY) {
    this.scrollX = Math.max(0, this.scrollX + deltaX);
    this.scrollY = Math.max(0, this.scrollY + deltaY);

    const startCol = Math.floor(this.scrollX / this.colWidth);
    const endCol = Math.min(this.totalCols, startCol + Math.ceil(this.viewport.width / this.colWidth));
    const startRow = Math.floor(this.scrollY / this.rowHeight);
    const endRow = Math.min(this.totalRows, startRow + Math.ceil(this.viewport.height / this.rowHeight));

    return {
      scrollMoved: true,
      canvasCount: this.canvasCount, // Tetap 1 (invarian)
      visibleWindow: { startRow, endRow, startCol, endCol },
      visibleCellCount: (endRow - startRow) * (endCol - startCol)
    };
  }

  // Simulasi offloading kalkulasi rumus ke dedicated calc worker
  async dispatchCalculation(cellCoord, formula, cellValues) {
    // Sederhana: hitung operasi matematika dasar
    return new Promise(resolve => {
      setTimeout(() => {
        let result = '#ERROR!';
        if (formula.startsWith('=')) {
          const expr = formula.substring(1).trim();
          if (expr.startsWith('SUM(')) {
            const vals = expr.slice(4, -1).split(',').map(s => Number(s.trim()) || 0);
            result = vals.reduce((a, b) => a + b, 0);
          } else {
            // Evaluasi aritmatika aman sederhana tanpa eval
            const match = expr.match(/^(\d+(?:\.\d+)?)\s*([\+\-\*\/])\s*(\d+(?:\.\d+)?)$/);
            if (match) {
              const a = parseFloat(match[1]);
              const op = match[2];
              const b = parseFloat(match[3]);
              if (op === '+') result = a + b;
              else if (op === '-') result = a - b;
              else if (op === '*') result = a * b;
              else if (op === '/' && b !== 0) result = a / b;
            } else {
              result = '42'; // Safe mock fallback
            }
          }
        }
        this.cellData.set(cellCoord, { formula, value: result });
        resolve({ cellCoord, formula, calculatedValue: result, processedBy: 'CalcWorkerHost' });
      }, 5);
    });
  }
}
