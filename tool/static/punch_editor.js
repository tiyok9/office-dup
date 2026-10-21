// D:\program\google\tool\static\punch_editor.js
// Punch Engine (Google Slides Pure Vector SVG Scene Graph Editor)
// Mendukung: rect / circle / line / text, teks anak di dalam shape,
// drag & drop, double-click edit teks, tambah & duplikat & hapus slide,
// warna latar slide, dan hapus elemen terpilih.

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

  let uidCounter = 0;
  function uid(prefix) {
    uidCounter += 1;
    return `${prefix}-${Date.now()}-${uidCounter}`;
  }

  // ==== TEMA (paritas "Theme" Google Slides) ====
  const THEMES = {
    light:  { name: 'Terang Klasik', bg: '#ffffff', text: '#202124', accent: '#1a73e8' },
    dark:   { name: 'Gelap Elegan',  bg: '#202124', text: '#f8f9fa', accent: '#8ab4f8' },
    sunset: { name: 'Sunset Hangat', bg: '#fff7ed', text: '#431407', accent: '#ea580c' },
    mint:   { name: 'Mint Modern',   bg: '#f0fdf4', text: '#064e3b', accent: '#059669' }
  };

  // ==== TATA LETAK (paritas "Layout" Google Slides) ====
  // Tiap template adalah daftar elemen yang MENGGANTIKAN isi slide. Elemen
  // ber-"role" akan diwarnai ulang mengikuti tema yang sedang aktif.
  const LAYOUTS = {
    blank: [],
    title: [
      { type: 'text', x: 100, y: 200, text: 'Judul Slide', font: 'Google Sans, Arial', size: 40, weight: 'bold', role: 'title' },
      { type: 'text', x: 100, y: 270, text: 'Subjudul presentasi', font: 'Arial', size: 20, weight: 'normal', role: 'subtitle' }
    ],
    title_body: [
      { type: 'rect', x: 0, y: 0, width: 960, height: 10, role: 'accent' },
      { type: 'text', x: 60, y: 50, text: 'Judul Slide', font: 'Google Sans, Arial', size: 30, weight: 'bold', role: 'title' },
      { type: 'text', x: 60, y: 130, text: 'Poin isi slide', font: 'Arial', size: 18, weight: 'normal', role: 'body' }
    ],
    two_column: [
      { type: 'text', x: 60, y: 50, text: 'Judul Slide', font: 'Google Sans, Arial', size: 30, weight: 'bold', role: 'title' },
      { type: 'rect', x: 60, y: 120, width: 400, height: 300, role: 'colA' },
      { type: 'rect', x: 500, y: 120, width: 400, height: 300, role: 'colB' },
      { type: 'text', x: 84, y: 156, text: 'Kolom kiri', font: 'Arial', size: 18, weight: 'normal', role: 'labelA' },
      { type: 'text', x: 524, y: 156, text: 'Kolom kanan', font: 'Arial', size: 18, weight: 'normal', role: 'labelB' }
    ]
  };

  class PunchSlidesEditor {
    constructor(stageSvgId, filmstripContainerId, onSlideChange) {
      this.stage = document.getElementById(stageSvgId);
      this.filmstrip = document.getElementById(filmstripContainerId);
      this.onSlideChange = onSlideChange;

      this.slides = [];
      this.activeSlideIdx = 0;
      this.selectedElementId = null;

      // State Drag & Drop elemen di SVG
      this.isDragging = false;
      this.dragTargetId = null;
      this.dragStartX = 0;
      this.dragStartY = 0;
      this.elemStartX = 0;
      this.elemStartY = 0;

      // State ubah-ukuran (8 handle ala Google Slides)
      this.isResizing = false;
      this.resizeHandle = null;
      this.resizeStartBox = null;
      this.resizeStartPt = null;

      this.onChange = null;
      this._lastClickTs = 0;
      this._lastClickId = null;
      this.initEvents();
    }

    setSlides(slidesArray) {
      if (Array.isArray(slidesArray) && slidesArray.length > 0) {
        this.slides = JSON.parse(JSON.stringify(slidesArray));
      } else {
        this.slides = [
          {
            id: 1,
            title: 'Slide 1: Cover',
            background: '#ffffff',
            elements: [
              { id: 'el-1', type: 'rect', x: 0, y: 0, width: 960, height: 12, fill: '#f29900' },
              { id: 'el-2', type: 'rect', x: 60, y: 60, width: 840, height: 420, fill: '#f8f9fa', stroke: '#ebebeb', rx: 8 },
              { id: 'el-3', type: 'text', x: 100, y: 160, text: 'KRUŠEVAC NEKRETNINE', font: 'Google Sans, Arial', size: 38, weight: 'bold', fill: '#1a73e8' },
              { id: 'el-4', type: 'text', x: 100, y: 210, text: 'Eksklusivna Ponuda Stanova i Poslovnog Prostora 2026', font: 'Arial', size: 20, weight: 'normal', fill: '#5f6368' }
            ]
          }
        ];
      }
      this.activeSlideIdx = 0;
      this.selectedElementId = null;
      this.render();
    }

    getSlides() {
      return this.slides;
    }

    getActiveSlide() {
      return this.slides[this.activeSlideIdx];
    }

    // ==== GEOMETRI ELEMEN ====
    // Teks anak (punya parentId) memakai koordinat relatif (dx, dy) terhadap
    // induknya, sehingga ikut bergerak saat shape induk digeser.
    parentOf(el, slide) {
      if (!el || !el.parentId) return null;
      return slide.elements.find(x => x.id === el.parentId) || null;
    }

    baseXY(el, slide) {
      const parent = this.parentOf(el, slide);
      if (!parent) return { x: el.x || 0, y: el.y || 0 };
      if (parent.type === 'circle') return { x: parent.cx, y: parent.cy };
      return { x: parent.x, y: parent.y };
    }

    absX(el, slide) {
      const p = this.parentOf(el, slide);
      if (!p) return el.x || 0;
      return Math.round(this.baseXY(el, slide).x + (el.dx || 0));
    }

    absY(el, slide) {
      const p = this.parentOf(el, slide);
      if (!p) return el.y || 0;
      return Math.round(this.baseXY(el, slide).y + (el.dy || 0));
    }

    initEvents() {
      // Dragging element pada SVG stage
      this.stage.addEventListener('mousedown', (e) => {
        const handle = e.target.closest('[data-handle]');
        const elem = e.target.closest('[data-element-id]');
        const now = Date.now();
        // Elemen acuan klik: elemen yang diklik langsung, atau elemen TERPILIH
        // bila yang diklik sebuah HANDLE (handle tidak membawa data-element-id
        // sendiri, padahal ia milik elemen terpilih).
        const elemId = elem
          ? elem.getAttribute('data-element-id')
          : (handle && this.selectedElementId ? this.selectedElementId : null);

        // Deteksi double-click MANUAL dijalankan SEBELUM cabang ubah-ukuran.
        // Alasan nyata (terbukti di probe): setelah klik pertama, 8 handle
        // digambar tepat di tepi kotak teks — sehingga klik kedua pada area
        // yang sama mendarat di HANDLE, bukan di teks. Bila cabang ubah-ukuran
        // diperiksa lebih dulu, klik kedua berubah menjadi mode resize dan
        // editor teks tidak pernah terbuka. Event `dblclick` native tidak
        // dipakai karena renderStage() mengganti seluruh node SVG sehingga
        // target klik-1 != klik-2 dan browser membatalkan sintesis dblclick.
        // Dibatasi pada elemen TEKS saja: pada shape, klik-beruntun pada handle
        // tetap harus berarti ubah-ukuran (bukan memicu editor teks).
        const targetIsText = (() => {
          const s = this.getActiveSlide();
          const el = elemId && s ? s.elements.find(x => x.id === elemId) : null;
          return !!(el && el.type === 'text');
        })();
        if (elemId && targetIsText && this._lastClickId === elemId && (now - this._lastClickTs) < 450) {
          // Aksi BAWAAN mousedown (memindahkan fokus ke dokumen) berjalan setelah
          // handler selesai dan akan mem-blur input yang baru dibuat -> editor
          // in-place tertutup seketika. preventDefault menahan aksi itu.
          e.preventDefault();
          this._lastClickTs = 0;
          this._lastClickId = null;
          this.isDragging = false;
          this.dragTargetId = null;
          this.isResizing = false;
          this.resizeHandle = null;
          this.editElementText(elemId);
          return;
        }
        this._lastClickTs = now;
        this._lastClickId = elemId;

        // Handle ubah-ukuran diprioritaskan atas drag elemen: ia berada DI ATAS
        // elemen, jadi harus diperiksa lebih dulu agar tidak terbaca sebagai drag.
        if (handle) {
          const box = this.selectionBox();
          if (box) {
            this.isResizing = true;
            this.resizeHandle = handle.getAttribute('data-handle');
            this.resizeStartBox = box;
            this.resizeStartPt = this.getSvgCoords(e);
            this.isDragging = false;
            this.dragTargetId = null;
          }
          return;
        }

        if (elem) {
          const id = elem.getAttribute('data-element-id');
          this.selectedElementId = id;
          this.isDragging = true;
          this.dragTargetId = id;

          const pt = this.getSvgCoords(e);
          this.dragStartX = pt.x;
          this.dragStartY = pt.y;

          const slide = this.getActiveSlide();
          const targetEl = slide.elements.find(el => el.id === id);
          if (targetEl) {
            const base = this.baseXY(targetEl, slide);
            this.elemStartX = base.x;
            this.elemStartY = base.y;
          }
          this.renderStage();
        } else {
          this.selectedElementId = null;
          this.isDragging = false;
          this.dragTargetId = null;
          this.renderStage();
        }
      });

      window.addEventListener('mousemove', (e) => {
        if (this.isResizing && this.resizeHandle) {
          this.applyResize(this.getSvgCoords(e));
          this.renderStage();
          return;
        }
        if (!this.isDragging || !this.dragTargetId) return;
        const pt = this.getSvgCoords(e);
        const dx = pt.x - this.dragStartX;
        const dy = pt.y - this.dragStartY;

        const slide = this.getActiveSlide();
        const el = slide.elements.find(item => item.id === this.dragTargetId);
        if (el) {
          const nx = Math.round(this.elemStartX + dx);
          const ny = Math.round(this.elemStartY + dy);
          if (el.type === 'line') {
            el.x1 = nx;
            el.y1 = ny;
            el.x2 = nx + (el.width || 300);
            el.y2 = ny;
          } else if (el.type === 'circle') {
            el.cx = nx;
            el.cy = ny;
          } else {
            el.x = nx;
            el.y = ny;
          }
          this.renderStage();
        }
      });

      window.addEventListener('mouseup', () => {
        if (this.isResizing) {
          this.isResizing = false;
          this.resizeHandle = null;
          this.resizeStartBox = null;
          this.renderStage();
          if (typeof this.onChange === 'function') this.onChange(this.slides);
          return;
        }
        if (this.isDragging) {
          this.isDragging = false;
          this.dragTargetId = null;
          if (typeof this.onChange === 'function') {
            this.onChange(this.slides);
          }
        }
      });

      // Hapus elemen terpilih dengan tombol Delete/Backspace
      window.addEventListener('keydown', (e) => {
        if (window.currentApp !== 'slides') return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        if (!this.selectedElementId) return;
        e.preventDefault();
        this.deleteSelectedElement();
      });
    }

    // ==== KOTAK SELEKSI & HANDLE UBAH-UKURAN (8 titik ala Google Slides) ====
    // Mengembalikan bounding box absolut elemen terpilih + daftar handle.
    // Teks diukur dari panjang teks karena SVG text tidak punya width sendiri.
    selectionBox() {
      const slide = this.getActiveSlide();
      if (!slide || !this.selectedElementId) return null;
      const el = slide.elements.find(x => x.id === this.selectedElementId);
      if (!el) return null;

      if (el.type === 'rect') {
        return { el, x: el.x, y: el.y, w: el.width, h: el.height, kind: 'rect' };
      }
      if (el.type === 'circle') {
        return { el, x: el.cx - el.r, y: el.cy - el.r, w: el.r * 2, h: el.r * 2, kind: 'circle' };
      }
      if (el.type === 'line') {
        const x = Math.min(el.x1, el.x2), y = Math.min(el.y1, el.y2);
        return {
          el, x, y,
          w: Math.abs(el.x2 - el.x1) || 1,
          h: Math.abs(el.y2 - el.y1) || 1,
          kind: 'line'
        };
      }
      if (el.type === 'text') {
        const size = el.size || 14;
        const w = Math.max(40, (el.text || '').length * size * 0.55);
        return { el, x: this.absX(el, slide), y: this.absY(el, slide) - size, w, h: size + 8, kind: 'text' };
      }
      if (el.type === 'group') {
        return { el, x: el.x, y: el.y, w: el.width, h: el.height, kind: 'group' };
      }
      return null;
    }

    // Menerapkan perubahan ukuran berdasar handle yang sedang digeser.
    // Koordinat asal disimpan di resizeStartBox sehingga hasilnya deterministik
    // (tidak menumpuk galat pembulatan antar-frame).
    applyResize(pt) {
      const el = this.selectedElementId
        ? this.getActiveSlide()?.elements.find(x => x.id === this.selectedElementId)
        : null;
      const b = this.resizeStartBox;
      const start = this.resizeStartPt;
      if (!el || !b || !start) return;

      const dx = pt.x - start.x;
      const dy = pt.y - start.y;
      const h = this.resizeHandle;
      const MIN = 16;

      if (b.kind === 'rect') {
        let { x, y, w, hh } = { x: b.x, y: b.y, w: b.w, hh: b.h };
        if (h.includes('e')) w = b.w + dx;
        if (h.includes('w')) { w = b.w - dx; x = b.x + dx; }
        if (h.includes('s')) hh = b.h + dy;
        if (h.includes('n')) { hh = b.h - dy; y = b.y + dy; }
        el.width = Math.max(MIN, Math.round(w));
        el.height = Math.max(MIN, Math.round(hh));
        if (!h.includes('w')) el.x = Math.round(x);
        if (!h.includes('n')) el.y = Math.round(y);
        if (h.includes('w')) el.x = Math.round(b.x + b.w - el.width);
        if (h.includes('n')) el.y = Math.round(b.y + b.h - el.height);
      } else if (b.kind === 'circle') {
        // Radius mengikuti perubahan terjauh dari sumbu handle.
        const sx = h.includes('e') ? dx : (h.includes('w') ? -dx : 0);
        const sy = h.includes('s') ? dy : (h.includes('n') ? -dy : 0);
        const delta = Math.max(sx, sy);
        el.r = Math.max(MIN / 2, Math.round(b.el.r + delta));
      } else if (b.kind === 'line') {
        // Handle 'e'/'s' menggerakkan titik akhir; 'w'/'n' menggerakkan titik awal.
        if (h.includes('w') || h.includes('n')) {
          el.x1 = Math.round(b.el.x1 + dx);
          el.y1 = Math.round(b.el.y1 + dy);
        } else {
          el.x2 = Math.round(b.el.x2 + dx);
          el.y2 = Math.round(b.el.y2 + dy);
        }
        el.width = Math.abs(el.x2 - el.x1);
      } else if (b.kind === 'text') {
        // Skala ukuran font proporsional terhadap perubahan tinggi kotak.
        const factor = (b.h + dy) / b.h;
        el.size = Math.max(8, Math.round((b.el.size || 14) * factor));
      }
      return el;
    }

    editElementText(elemId) {
      const slide = this.getActiveSlide();
      const el = slide && slide.elements.find(x => x.id === elemId);
      if (!el || el.type !== 'text') return false;
      // Editor teks DI TEMPAT: input melayang tepat di atas elemen, bukan
      // dialog prompt bawaan browser. Enter komit, Escape batal.
      this.openInlineTextEditor(el);
      return true;
    }

    openInlineTextEditor(el) {
      this.closeInlineTextEditor();
      const slide = this.getActiveSlide();
      const rect = this.stage.getBoundingClientRect();
      const scaleX = rect.width / 960;
      const scaleY = rect.height / 540;
      const ax = this.absX(el, slide);
      const ay = this.absY(el, slide);

      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'punchInlineTextInput';
      input.value = el.text || '';
      input.style.cssText = [
        'position:absolute',
        `left:${Math.round(rect.left + ax * scaleX)}px`,
        `top:${Math.round(rect.top + (ay - (el.size || 14)) * scaleY)}px`,
        `width:${Math.max(140, Math.round(((el.text || '').length + 12) * (el.size || 14) * 0.55 * scaleX))}px`,
        `font-size:${Math.round((el.size || 14) * scaleY)}px`,
        'z-index:100001',
        'border:2px solid #1a73e8',
        'border-radius:2px',
        'padding:2px 4px',
        'background:#fff'
      ].join(';');
      input.className = 'punch-inline-editor';

      const commit = () => {
        // Penjaga reentrancy: melepas node input dapat memicu `blur` secara
        // SINKRON, dan handler blur di bawah juga memanggil commit(). Tanpa
        // penjaga ini, commit() bersarang memanggil removeChild pada node yang
        // sedang dilepas -> NotFoundError "no longer a child ... moved in a
        // 'blur' event handler".
        if (this._inlineCommitInFlight) return;
        this._inlineCommitInFlight = true;
        try {
          el.text = input.value;
          this.closeInlineTextEditor();
          this.render();
          if (typeof this.onChange === 'function') this.onChange(this.slides);
        } finally {
          this._inlineCommitInFlight = false;
        }
      };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); this.closeInlineTextEditor(); }
        ev.stopPropagation();
      });
      // Klik ke luar = komit juga (perilaku user nyata: tidak semua orang
      // menekan Enter sebelum berpindah fokus).
      input.addEventListener('blur', () => {
        if (this._inlineCommitInFlight) return;
        if (document.getElementById('punchInlineTextInput') === input) commit();
      });

      document.body.appendChild(input);
      // Fokus ditunda satu tick: sisa aksi bawaan mousedown berjalan setelah
      // handler sehingga focus() langsung bisa langsung ter-blur.
      setTimeout(() => { input.focus(); input.select(); }, 0);
    }

    closeInlineTextEditor() {
      const old = document.getElementById('punchInlineTextInput');
      if (!old) return;
      // Defensif: node bisa sudah dilepas oleh commit() bersarang. removeChild
      // pada node yang bukan lagi anak akan melempar NotFoundError dan
      // menghentikan alur sunting, jadi kegagalan lepas diabaikan dengan aman.
      try {
        if (old.parentNode) old.parentNode.removeChild(old);
      } catch (e) {
        /* sudah terlepas — bukan kondisi yang perlu menghentikan alur */
      }
    }

    getSvgCoords(e) {
      const rect = this.stage.getBoundingClientRect();
      const scaleX = 960 / rect.width;
      const scaleY = 540 / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      };
    }

    // ==== SLIDE OPERATIONS ====
    addNewSlide() {
      const num = this.slides.length + 1;
      const stamp = Date.now();
      const newSlide = {
        id: stamp,
        title: `Slide ${num}: Lembar Baru`,
        background: '#ffffff',
        elements: [
          { id: `el-${stamp}-1`, type: 'rect', x: 0, y: 0, width: 960, height: 12, fill: '#f29900' },
          { id: `el-${stamp}-2`, type: 'text', x: 80, y: 100, text: `Judul Slide ${num}`, font: 'Google Sans, Arial', size: 32, weight: 'bold', fill: '#202124' },
          { id: `el-${stamp}-3`, type: 'text', x: 80, y: 160, text: 'Klik ganda untuk menyunting teks atau geser elemen di layar.', font: 'Arial', size: 16, weight: 'normal', fill: '#5f6368' }
        ]
      };
      this.slides.push(newSlide);
      this.activeSlideIdx = this.slides.length - 1;
      this.selectedElementId = null;
      this.render();
      if (typeof this.onChange === 'function') {
        this.onChange(this.slides);
      }
      return newSlide;
    }

    deleteActiveSlide() {
      if (this.slides.length <= 1) {
        if (window.workspaceApp && window.workspaceApp.showToast) {
          window.workspaceApp.showToast('Presentasi harus memiliki minimal 1 slide.');
        } else {
          // Fallback non-blocking: alert() membekukan event loop dan tidak
          // bisa ditutup otomasi CDP. Jalur utama tetap showToast di atas.
          console.warn('Presentasi harus memiliki minimal 1 slide.');
        }
        return false;
      }
      this.slides.splice(this.activeSlideIdx, 1);
      this.activeSlideIdx = Math.max(0, this.activeSlideIdx - 1);
      this.selectedElementId = null;
      this.render();
      if (typeof this.onChange === 'function') {
        this.onChange(this.slides);
      }
      return true;
    }

    duplicateActiveSlide() {
      const src = this.getActiveSlide();
      if (!src) return null;
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = Date.now();
      copy.title = `${src.title} (salinan)`;
      // Beri ID baru agar elemen salinan tidak bertabrakan dengan aslinya.
      copy.elements = copy.elements.map(el => ({ ...el, id: uid('el') }));
      // Petakan ulang parentId teks anak ke ID elemen baru.
      const idMap = {};
      src.elements.forEach((el, i) => { idMap[el.id] = copy.elements[i].id; });
      copy.elements.forEach(el => {
        if (el.parentId && idMap[el.parentId]) el.parentId = idMap[el.parentId];
      });

      this.slides.splice(this.activeSlideIdx + 1, 0, copy);
      this.activeSlideIdx = this.activeSlideIdx + 1;
      this.selectedElementId = null;
      this.render();
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return copy;
    }

    // Memindah slide aktif naik/turun di dalam urutan (paritas "Move slide").
    // Mengembalikan index baru, atau -1 bila tidak mungkin dipindah.
    moveSlide(delta) {
      const from = this.activeSlideIdx;
      const to = from + delta;
      if (from < 0 || to < 0 || to >= this.slides.length) return -1;
      const [moved] = this.slides.splice(from, 1);
      this.slides.splice(to, 0, moved);
      this.activeSlideIdx = to;
      this.selectedElementId = null;
      this.render();
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return to;
    }

    setSlideBackground(color) {
      const slide = this.getActiveSlide();
      if (!slide) return false;
      slide.background = color;
      this.render();
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return true;
    }

    // ==== TEMA (paritas "Theme" Google Slides) ====
    // Menerapkan tema ke SEMUA slide: latar mengikuti tema, dan elemen ber-role
    // diwarnai ulang sesuai peran (judul/subbab/aksen). Elemen tanpa role
    // (mis. teks biasa) hanya disesuaikan bila warnanya masih warna bawaan,
    // supaya pilihan warna manual user tidak ditimpa.
    static getThemes() {
      return THEMES;
    }

    getTheme() {
      return (this.slides[0] && this.slides[0].theme) || 'light';
    }

    applyTheme(themeKey) {
      const t = THEMES[themeKey];
      if (!t) return false;
      for (const slide of this.slides) {
        slide.theme = themeKey;
        slide.background = t.bg;
        for (const el of slide.elements) {
          if (el.role === 'title' || el.role === 'body' || el.role === 'subtitle' || el.role === 'labelA' || el.role === 'labelB') {
            el.fill = t.text;
          } else if (el.role === 'accent') {
            el.fill = t.accent;
          } else if (el.role === 'colA' || el.role === 'colB') {
            el.fill = (themeKey === 'dark') ? '#2d2e30' : '#f8f9fa';
            el.stroke = t.accent;
            el.strokeWidth = 2;
          } else if (el.type === 'text' && !el.role) {
            // Teks tanpa role: hanya ikut tema bila warna masih bawaan lama.
            if (!el.fill || el.fill === '#202124' || el.fill === '#5f6368' || el.fill === '#f8f9fa' || el.fill === '#431407' || el.fill === '#064e3b') {
              el.fill = t.text;
            }
          }
        }
      }
      this.render();
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return true;
    }

    // ==== TATA LETAK (paritas "Layout" Google Slides) ====
    // Mengganti isi slide dengan template; warna elemen mengikuti tema aktif.
    applyLayout(layoutKey) {
      const slide = this.getActiveSlide();
      const tpl = LAYOUTS[layoutKey];
      if (!slide || !tpl) return false;
      const themeKey = slide.theme || this.getTheme();
      const t = THEMES[themeKey] || THEMES.light;
      const stamp = Date.now();
      slide.elements = tpl.map((spec, i) => {
        const el = { ...spec, id: `el-${stamp}-${i}` };
        if (spec.role === 'title' || spec.role === 'body' || spec.role === 'subtitle' || spec.role === 'labelA' || spec.role === 'labelB') el.fill = t.text;
        if (spec.role === 'accent') el.fill = t.accent;
        if (spec.role === 'colA' || spec.role === 'colB') {
          el.fill = (themeKey === 'dark') ? '#2d2e30' : '#f8f9fa';
          el.stroke = t.accent;
          el.strokeWidth = 2;
        }
        if (el.type === 'line' && !el.stroke) el.stroke = t.text;
        return el;
      });
      slide.background = t.bg;
      slide.layout = layoutKey;
      this.selectedElementId = null;
      this.render();
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return true;
    }

    getLayout() {
      const slide = this.getActiveSlide();
      return slide ? (slide.layout || 'blank') : 'blank';
    }

    // ==== SHAPES & ELEMEN ====
    // kind: 'rect' | 'circle' | 'line'
    insertShape(kind) {
      const slide = this.getActiveSlide();
      if (!slide) return null;
      const stamp = Date.now();
      let el = null;

      if (kind === 'circle') {
        el = { id: `el-${stamp}`, type: 'circle', cx: 300, cy: 270, r: 90, fill: '#e8f0fe', stroke: '#1a73e8', strokeWidth: 2 };
      } else if (kind === 'line') {
        el = { id: `el-${stamp}`, type: 'line', x1: 150, y1: 420, x2: 450, y2: 420, width: 300, stroke: '#202124', strokeWidth: 3 };
      } else {
        el = { id: `el-${stamp}`, type: 'rect', x: 200, y: 180, width: 300, height: 180, fill: '#e8f0fe', stroke: '#1a73e8', strokeWidth: 2 };
      }

      slide.elements.push(el);

      // Tambahkan label teks di dalam shape baru agar bisa langsung disunting.
      const label = { id: uid('el'), type: 'text', parentId: el.id, dx: 24, dy: 40, text: 'Teks baru', font: 'Arial', size: 18, weight: 'bold', fill: '#1a73e8' };
      slide.elements.push(label);

      this.selectedElementId = el.id;
      this.render();
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return el;
    }

    insertTextElement() {
      const slide = this.getActiveSlide();
      if (!slide) return null;
      const el = { id: uid('el'), type: 'text', x: 160, y: 300, text: 'Teks baru', font: 'Arial', size: 20, weight: 'normal', fill: '#202124' };
      slide.elements.push(el);
      this.selectedElementId = el.id;
      this.render();
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return el;
    }

    deleteSelectedElement() {
      const slide = this.getActiveSlide();
      if (!slide || !this.selectedElementId) return false;
      const id = this.selectedElementId;
      // Hapus elemen beserta seluruh teks anaknya.
      slide.elements = slide.elements.filter(el => el.id !== id && el.parentId !== id);
      this.selectedElementId = null;
      this.render();
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return true;
    }

    // ==== Z-ORDER (paritas "Urutkan" Google Slides) ====
    // Elemen anak (label teks hasil insertShape) ikut bergerak bersama induknya
    // supaya label tidak tertinggal di belakang saat shape dibawa ke depan.
    _zTargets() {
      const slide = this.getActiveSlide();
      if (!slide || !this.selectedElementId) return null;
      const id = this.selectedElementId;
      const kids = slide.elements.filter(el => el.parentId === id);
      const main = slide.elements.find(el => el.id === id);
      if (!main) return null;
      return { slide, group: [main, ...kids] };
    }

    _zBounds(slide) {
      let min = 0, max = 0;
      for (const el of slide.elements) {
        if (typeof el.z === 'number') { min = Math.min(min, el.z); max = Math.max(max, el.z); }
      }
      return { min, max };
    }

    bringToFront() {
      const t = this._zTargets();
      if (!t) return false;
      const { max } = this._zBounds(t.slide);
      // +1 per elemen agar urutan internal grup (shape lalu label) terjaga.
      t.group.forEach((el, i) => { el.z = max + 1 + i; });
      this.render();
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return true;
    }

    sendToBack() {
      const t = this._zTargets();
      if (!t) return false;
      const { min } = this._zBounds(t.slide);
      const n = t.group.length;
      t.group.forEach((el, i) => { el.z = min - n + i; });
      this.render();
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return true;
    }

    // ==== ROTASI ELEMEN (paritas Google Slides) ====
    // angle dalam derajat, searah jarum jam. Disimpan di el.angle.
    rotateElement(degrees) {
      const slide = this.getActiveSlide();
      if (!slide || !this.selectedElementId) return false;
      const el = slide.elements.find(x => x.id === this.selectedElementId);
      if (!el) return false;
      el.angle = ((el.angle || 0) + degrees) % 360;
      this.render();
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return true;
    }

    setElementAngle(degrees) {
      const slide = this.getActiveSlide();
      if (!slide || !this.selectedElementId) return false;
      const el = slide.elements.find(x => x.id === this.selectedElementId);
      if (!el) return false;
      el.angle = degrees % 360;
      this.render();
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return true;
    }

    // ==== GROUP / UNGROUP ELEMEN (paritas Google Slides) ====
    // groupElements: gabungkan elemen-elemen terpilih menjadi satu grup.
    // IDs = array of element ids to group.
    groupElements(ids) {
      const slide = this.getActiveSlide();
      if (!slide || !ids || ids.length < 2) return false;
      const children = [];
      const remaining = [];
      for (const el of slide.elements) {
        if (ids.includes(el.id)) children.push(el);
        else remaining.push(el);
      }
      if (children.length < 2) return false;
      // Hitung bounding box grup
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const el of children) {
        const bx = el.x !== undefined ? el.x : (el.cx !== undefined ? el.cx - (el.r || 0) : 0);
        const by = el.y !== undefined ? el.y : (el.cy !== undefined ? el.cy - (el.r || 0) : 0);
        const bw = el.width || (el.r ? el.r * 2 : 0) || 0;
        const bh = el.height || (el.r ? el.r * 2 : 0) || 0;
        minX = Math.min(minX, bx);
        minY = Math.min(minY, by);
        maxX = Math.max(maxX, bx + bw);
        maxY = Math.max(maxY, by + bh);
      }
      const groupEl = {
        id: 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        type: 'group',
        x: minX, y: minY,
        width: maxX - minX, height: maxY - minY,
        children: children
      };
      remaining.push(groupEl);
      slide.elements = remaining;
      this.selectedElementId = groupEl.id;
      this.render();
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return groupEl.id;
    }

    ungroupElements() {
      const slide = this.getActiveSlide();
      if (!slide || !this.selectedElementId) return false;
      const idx = slide.elements.findIndex(x => x.id === this.selectedElementId);
      if (idx < 0) return false;
      const el = slide.elements[idx];
      if (el.type !== 'group' || !el.children) return false;
      // Splice children back
      slide.elements.splice(idx, 1, ...el.children);
      this.selectedElementId = null;
      this.render();
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return true;
    }

    // ==== TRANSISI SLIDE (paritas Google Slides) ====
    setSlideTransition(type, durationMs) {
      const slide = this.getActiveSlide();
      if (!slide) return false;
      const validTypes = ['none', 'fade', 'slide-left', 'slide-right', 'zoom'];
      slide.transition = validTypes.includes(type) ? type : 'none';
      slide.transitionDuration = typeof durationMs === 'number' && durationMs > 0 ? durationMs : 500;
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return true;
    }

    getSlideTransition() {
      const slide = this.getActiveSlide();
      if (!slide) return { type: 'none', duration: 500 };
      return {
        type: slide.transition || 'none',
        duration: slide.transitionDuration || 500
      };
    }

    updateSelectedColor(color) {
      const slide = this.getActiveSlide();
      if (!slide || !this.selectedElementId) return false;
      const el = slide.elements.find(x => x.id === this.selectedElementId);
      if (!el) return false;
      if (el.type === 'text') el.fill = color;
      else el.fill = color;
      this.render();
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return true;
    }

    selectSlide(idx) {
      if (idx >= 0 && idx < this.slides.length) {
        this.activeSlideIdx = idx;
        this.selectedElementId = null;
        this.closeInlineTextEditor();
        this.render();
        if (typeof this.onSlideChange === 'function') this.onSlideChange(idx);
      }
    }

    // ==== CATATAN PEMBICARA (Speaker Notes) ====
    getSpeakerNotes() {
      const slide = this.getActiveSlide();
      return slide ? (slide.notes || '') : '';
    }

    setSpeakerNotes(text) {
      const slide = this.getActiveSlide();
      if (!slide) return false;
      slide.notes = text || '';
      if (typeof this.onChange === 'function') this.onChange(this.slides);
      return true;
    }

    render() {
      this.renderFilmstrip();
      this.renderStage();
    }

    renderFilmstrip() {
      if (!this.filmstrip) return;
      this.filmstrip.innerHTML = '';

      const addBtn = document.createElement('div');
      addBtn.style.cssText = 'padding: 6px 10px; background: #e8f0fe; color: #1a73e8; border: 1px dashed #4285f4; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; text-align: center; margin-bottom: 8px; user-select: none;';
      addBtn.innerHTML = '+ Slide Baru';
      addBtn.onclick = () => this.addNewSlide();
      this.filmstrip.appendChild(addBtn);

      this.slides.forEach((slide, idx) => {
        const item = document.createElement('div');
        item.className = `filmstrip-item ${idx === this.activeSlideIdx ? 'active' : ''}`;
        item.style.cssText = `position: relative; border: 2px solid ${idx === this.activeSlideIdx ? '#f29900' : '#dadce0'}; border-radius: 6px; margin-bottom: 10px; cursor: pointer; background: #fff; padding: 4px; overflow: hidden;`;

        const firstText = slide.elements.find(el => el.type === 'text');
        const previewText = firstText ? firstText.text : `Slide ${idx + 1}`;

        item.innerHTML = `
          <div style="height: 60px; display: flex; align-items: center; justify-content: center; background: #fafafa; font-size: 10px; color: #3c4043; font-weight: bold; padding: 4px; text-align: center; overflow: hidden;">
            ${escapeXml(previewText)}
          </div>
          <span style="position: absolute; bottom: 2px; left: 4px; font-size: 10px; font-weight: bold; color: #5f6368;">${idx + 1}</span>
        `;

        item.onclick = () => this.selectSlide(idx);
        this.filmstrip.appendChild(item);
      });
    }

    // Bungkus SVG markup dengan transform rotate jika el.angle !== 0
    _wrapRotation(el, svgMarkup) {
      const angle = el.angle || 0;
      if (!angle) return svgMarkup;
      // Hitung pusat rotasi dari bounding box elemen
      let cx, cy;
      if (el.type === 'rect') { cx = el.x + el.width / 2; cy = el.y + el.height / 2; }
      else if (el.type === 'circle') { cx = el.cx; cy = el.cy; }
      else if (el.type === 'line') { cx = (el.x1 + el.x2) / 2; cy = (el.y1 + el.y2) / 2; }
      else if (el.type === 'text') { cx = el.x || 0; cy = el.y || 0; }
      else { cx = (el.x || 0) + (el.width || 0) / 2; cy = (el.y || 0) + (el.height || 0) / 2; }
      return `<g transform="rotate(${angle}, ${cx}, ${cy})">${svgMarkup}</g>`;
    }

    elementToSvg(el, slide) {
      const isSelected = el.id === this.selectedElementId;
      const selStroke = isSelected ? 'stroke="#1a73e8" stroke-width="2" stroke-dasharray="4 2"' : '';
      const opacity = el.opacity !== undefined ? `opacity="${el.opacity}"` : '';

      // ==== GROUP RENDERING ====
      if (el.type === 'group' && el.children) {
        let inner = '';
        for (const child of el.children) {
          inner += this.elementToSvg(child, slide);
        }
        const angle = el.angle || 0;
        if (angle) {
          const cx = el.x + el.width / 2;
          const cy = el.y + el.height / 2;
          return `<g data-element-id="${el.id}" transform="rotate(${angle}, ${cx}, ${cy})" style="cursor: move;">${inner}</g>`;
        }
        return `<g data-element-id="${el.id}" style="cursor: move;">${inner}</g>`;
      }

      if (el.type === 'rect') {
        const rx = el.rx ? `rx="${el.rx}"` : '';
        const stroke = el.stroke ? `stroke="${escapeXml(el.stroke)}" stroke-width="${el.strokeWidth || 1}"` : '';
        return this._wrapRotation(el, `<rect data-element-id="${el.id}" x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" fill="${escapeXml(el.fill || '#ffffff')}" ${rx} ${stroke} ${opacity} style="cursor: move;"/>`);
      }
      if (el.type === 'circle') {
        const stroke = el.stroke ? `stroke="${escapeXml(el.stroke)}" stroke-width="${el.strokeWidth || 1}"` : '';
        return this._wrapRotation(el, `<circle data-element-id="${el.id}" cx="${el.cx}" cy="${el.cy}" r="${el.r}" fill="${escapeXml(el.fill || '#ffffff')}" ${stroke} ${opacity} style="cursor: move;"/>`);
      }
      if (el.type === 'line') {
        return this._wrapRotation(el, `<line data-element-id="${el.id}" x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="${escapeXml(el.stroke || '#202124')}" stroke-width="${el.strokeWidth || 2}" stroke-linecap="round" ${opacity} style="cursor: move;"/>`);
      }
      if (el.type === 'text') {
        const ax = this.absX(el, slide);
        const ay = this.absY(el, slide);
        const font = el.font ? `font-family="${escapeXml(el.font)}"` : 'font-family="Arial"';
        const size = el.size ? `font-size="${el.size}"` : 'font-size="14"';
        const weight = el.weight ? `font-weight="${escapeXml(el.weight)}"` : 'font-weight="normal"';
        // Kotak hit transparan seukuran kotak teks (perilaku Google Slides:
        // kotak teks dapat diklik/di-drag di MANA SAJA, bukan hanya tepat pada
        // goresan huruf). Tanpa ini, klik pada celah antarhuruf atau di dalam
        // kotak kosong tidak pernah mengenai elemen — baik bagi user maupun uji.
        const numSize = el.size || 14;
        const hitW = Math.max(40, (el.text || '').length * numSize * 0.55);
        const hitH = numSize + 8;
        const hitBox = `<rect data-element-id="${el.id}" x="${ax}" y="${ay - numSize}" width="${hitW}" height="${hitH}" fill="#000000" fill-opacity="0" pointer-events="all" style="cursor: move;"/>`;
        return this._wrapRotation(el, hitBox + `<text data-element-id="${el.id}" x="${ax}" y="${ay}" fill="${escapeXml(el.fill || '#202124')}" ${font} ${size} ${weight} ${opacity} style="cursor: move; user-select: none;">${escapeXml(el.text)}</text>`);
      }
      return '';
    }

    renderStage() {
      const slide = this.getActiveSlide();
      if (!slide) return;

      const bg = slide.background || '#ffffff';
      let svgHtml = `<rect x="0" y="0" width="960" height="540" fill="${escapeXml(bg)}"/>`;

      // Shape digambar lebih dulu, lalu teks, agar teks selalu di atas.
      // Setelah user memakai "Bawa ke Depan"/"Kirim ke Belakang", properti `z`
      // mengambil alih urutan. Sort-nya STABLE (tiebreak = indeks asli) supaya
      // slide yang belum pernah di-z-order tergambar persis seperti sebelumnya.
      const ordered = slide.elements
        .map((el, i) => ({ el, i, z: typeof el.z === 'number' ? el.z : 0 }))
        .sort((a, b) => (a.z - b.z) || (a.i - b.i))
        .map(x => x.el);

      const shapes = ordered.filter(el => el.type !== 'text');
      const texts = ordered.filter(el => el.type === 'text');

      shapes.forEach(el => { svgHtml += this.elementToSvg(el, slide); });
      texts.forEach(el => { svgHtml += this.elementToSvg(el, slide); });

      // Kotak seleksi + 8 handle ubah-ukuran (ala Google Slides)
      const box = this.selectionBox();
      if (box) {
        svgHtml += `<rect x="${box.x - 4}" y="${box.y - 4}" width="${box.w + 8}" height="${box.h + 8}" fill="none" stroke="#1a73e8" stroke-width="1.5" stroke-dasharray="3 3" pointer-events="none"/>`;

        // Kisi 3x3 dibuang bagian tengah → 8 handle (4 sudut + 4 sisi).
        // Posisi handle DIJEPIT ke dalam area slide: tanpa ini, handle pada
        // elemen yang menyentuh tepi (mis. banner 0,0,960x12) jatuh di luar
        // viewBox dan ter-clip oleh .slides-viewport{overflow:hidden} sehingga
        // tidak pernah bisa di-mousedown. Dijepit, bukan dihilangkan.
        const clampX = (v) => Math.min(955, Math.max(5, v));
        const clampY = (v) => Math.min(535, Math.max(5, v));
        const handles = [
          ['nw', box.x - 4, box.y - 4],
          ['n', box.x + box.w / 2, box.y - 4],
          ['ne', box.x + box.w + 4, box.y - 4],
          ['e', box.x + box.w + 4, box.y + box.h / 2],
          ['se', box.x + box.w + 4, box.y + box.h + 4],
          ['s', box.x + box.w / 2, box.y + box.h + 4],
          ['sw', box.x - 4, box.y + box.h + 4],
          ['w', box.x - 4, box.y + box.h / 2]
        ];
        for (const [name, hxRaw, hyRaw] of handles) {
          const hx = clampX(hxRaw);
          const hy = clampY(hyRaw);
          const cursor = (name === 'nw' || name === 'se') ? 'nwse-resize'
            : (name === 'ne' || name === 'sw') ? 'nesw-resize'
            : (name === 'n' || name === 's') ? 'ns-resize' : 'ew-resize';
          // Halo transparan 15x15 memperbesar area tangkap (target sentuh kecil
          // pada 7x7 sulit diklik user), lalu kotak putih 7x7 digambar di atasnya.
          svgHtml += `<rect data-handle="${name}" x="${hx - 7.5}" y="${hy - 7.5}" width="15" height="15" fill="#1a73e8" fill-opacity="0" pointer-events="all" style="cursor:${cursor};"/>`;
          svgHtml += `<rect x="${hx - 3.5}" y="${hy - 3.5}" width="7" height="7" fill="#ffffff" stroke="#1a73e8" stroke-width="1.5" pointer-events="none" style="cursor:${cursor};"/>`;
        }
      }

      svgHtml += `<text x="30" y="525" font-family="monospace" font-size="11" fill="#9aa0a6">[Punch Engine · Pure Vector SVG Scene Graph · 0 Canvas]</text>`;

      this.stage.innerHTML = svgHtml;
    }

    // Ekspor scene graph slide aktif sebagai dokumen SVG mandiri.
    exportSvg() {
      const slide = this.getActiveSlide();
      if (!slide) return '';
      const bg = slide.background || '#ffffff';
      let inner = `<rect x="0" y="0" width="960" height="540" fill="${bg}"/>`;
      slide.elements.forEach(el => { inner += this.elementToSvg(el, slide); });
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540" width="960" height="540">${inner}</svg>`;
    }

    startPresentationMode() {
      let overlay = document.getElementById('slidesPresentOverlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'slidesPresentOverlay';
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: #000; z-index: 99999; display: flex; flex-direction: column; align-items: center; justify-content: center;';
        document.body.appendChild(overlay);

        window.addEventListener('keydown', (e) => {
          if (overlay.style.display !== 'flex') return;
          if (e.key === 'Escape') {
            overlay.style.display = 'none';
          } else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') {
            if (this.activeSlideIdx < this.slides.length - 1) {
              this.activeSlideIdx++;
              this.render();
              updateOverlay();
            }
          } else if (e.key === 'ArrowLeft') {
            if (this.activeSlideIdx > 0) {
              this.activeSlideIdx--;
              this.render();
              updateOverlay();
            }
          }
        });
      }

      const updateOverlay = (direction) => {
        const slide = this.slides[this.activeSlideIdx];
        const trans = slide ? (slide.transition || 'none') : 'none';
        const dur = slide ? (slide.transitionDuration || 500) : 500;
        const animStyle = trans === 'none' ? ''
          : trans === 'fade' ? `animation: punchFadeIn ${dur}ms ease;`
          : trans === 'slide-left' ? `animation: punchSlideLeft ${dur}ms ease;`
          : trans === 'slide-right' ? `animation: punchSlideRight ${dur}ms ease;`
          : trans === 'zoom' ? `animation: punchZoomIn ${dur}ms ease;`
          : '';
        overlay.innerHTML = `
          <style>
            @keyframes punchFadeIn { from { opacity: 0; } to { opacity: 1; } }
            @keyframes punchSlideLeft { from { transform: translateX(100%); } to { transform: translateX(0); } }
            @keyframes punchSlideRight { from { transform: translateX(-100%); } to { transform: translateX(0); } }
            @keyframes punchZoomIn { from { transform: scale(0.5); opacity: 0; } to { transform: scale(1); opacity: 1; } }
          </style>
          <div style="position: absolute; top: 16px; right: 24px; color: #fff; font-size: 13px; font-family: sans-serif; display: flex; gap: 16px; align-items: center; z-index: 100000;">
            <span>Slide ${this.activeSlideIdx + 1} / ${this.slides.length}</span>
            <span style="background: rgba(255,255,255,0.2); padding: 4px 10px; border-radius: 4px; cursor: pointer;" onclick="document.getElementById('slidesPresentOverlay').style.display='none'">Tutup (Esc)</span>
          </div>
          <div style="width: 90vw; max-width: 1200px; aspect-ratio: 16/9; background: #fff; box-shadow: 0 10px 40px rgba(0,0,0,0.8); border-radius: 4px; overflow: hidden; ${animStyle}">
            <svg viewBox="0 0 960 540" style="width: 100%; height: 100%;">
              ${this.stage.innerHTML}
            </svg>
          </div>
        `;
      };

      overlay.style.display = 'flex';
      updateOverlay();
    }
  }

  window.PunchSlidesEditor = PunchSlidesEditor;
})(window);
