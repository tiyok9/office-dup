// D:\program\google\tool\gws_classifier.mjs
// Modul klasifikasi arsitektur Google Workspace berdasarkan artefak empiris

export function classifyPayload(htmlOrText) {
  if (!htmlOrText || typeof htmlOrText !== 'string') {
    return { status: 'INVALID', reason: 'Payload kosong atau bukan string' };
  }
  const text = htmlOrText.toLowerCase();

  // 1. Deteksi Soft-404 (Google menyajikan status 200 tetapi isi halaman tidak ditemukan)
  const soft404Signals = [
    'halaman tidak ditemukan',
    'page not found',
    'unable to open the file',
    'sorry, unable to open the file'
  ];
  for (const sig of soft404Signals) {
    if (text.includes(sig)) {
      return {
        status: 'SOFT_404',
        valid: false,
        reason: `Terdeteksi penanda soft-404: "${sig}"`,
        engine: 'NONE'
      };
    }
  }

  // 2. Deteksi Engine berdasarkan DOM tokens & modul
  const isKix = text.includes('kix-canvas-tile-content') || text.includes('kix-page') || text.includes('kix_core');
  const isPunch = text.includes('punch-viewer') || text.includes('punch-filmstrip') || text.includes('punch-slide');
  const isRitz = text.includes('grid4-inner-container') || text.includes('waffle-canvas') || text.includes('ritzmaestro') || text.includes('calcworker');

  if (isKix) {
    return {
      status: 'VALID_DOCUMENT',
      valid: true,
      app: 'Google Docs',
      engine: 'Kix',
      paradigm: 'Multi-Canvas Tile Virtualization',
      expectedSurface: { canvasMin: 1, svgMax: 5, primaryRenderer: 'CANVAS_TILE' }
    };
  }
  if (isPunch) {
    return {
      status: 'VALID_DOCUMENT',
      valid: true,
      app: 'Google Slides',
      engine: 'Punch',
      paradigm: 'Pure Vector SVG Scene Graph',
      expectedSurface: { canvas: 0, svgMin: 10, primaryRenderer: 'SVG_VECTOR' }
    };
  }
  if (isRitz) {
    return {
      status: 'VALID_DOCUMENT',
      valid: true,
      app: 'Google Sheets',
      engine: 'Ritz / Waffle',
      paradigm: 'Single Canvas Grid + Dedicated Calc Worker',
      expectedSurface: { canvas: 1, primaryRenderer: 'SINGLE_CANVAS_GRID' }
    };
  }

  return {
    status: 'UNKNOWN',
    valid: true,
    engine: 'UNKNOWN',
    reason: 'Dokumen terakses tetapi tidak cocok dengan signature khas Kix/Punch/Ritz'
  };
}

export function classifyArtifact(artifactJson) {
  const b = artifactJson.before || {};
  const canvasCount = b.canvas ?? 0;
  const svgCount = b.svg ?? 0;
  const nodes = b.nodes ?? 0;
  const wt = artifactJson.workerTargets || [];
  const sv = artifactJson.scrollVerdict || {};

  // Pisahkan service worker ekstensi dari app worker asli
  const realWorkers = wt.filter(w => {
    const u = w.url || w.selfLocation || '';
    return !u.startsWith('chrome-extension://');
  });

  let engine = 'UNKNOWN';
  let architecture = '';

  if (canvasCount >= 2) {
    engine = 'Kix (Docs)';
    architecture = 'Multi-Canvas Tile Virtualization';
  } else if (canvasCount === 0 && svgCount >= 10) {
    engine = 'Punch (Slides)';
    architecture = 'Pure Vector SVG Scene Graph';
  } else if (canvasCount === 1) {
    engine = 'Ritz / Waffle (Sheets)';
    architecture = 'Single Canvas Grid';
  }

  return {
    title: b.title || '(untitled)',
    engine,
    architecture,
    surfaceMetrics: { nodes, canvas: canvasCount, svg: svgCount, iframe: b.iframe ?? 0 },
    workerMetrics: {
      totalTargets: wt.length,
      realAppWorkers: realWorkers.length,
      extensionWorkers: wt.length - realWorkers.length,
      realWorkerList: realWorkers
    },
    scrollEvaluation: {
      axis: sv.axis || 'none',
      scrollMoved: !!sv.scrollMoved,
      contentChanged: !!sv.contentChanged,
      canvasDelta: (sv.canvasAfter ?? 0) - (sv.canvasBefore ?? 0),
      nodesDelta: sv.nodesDelta ?? 0,
      interpretation: sv.scrollMoved
        ? 'Scroll memicu perubahan rendering canvas/tile'
        : 'Scroll programatik DOM tidak menggeser kanvas (input di-intercept secara internal)'
    }
  };
}
