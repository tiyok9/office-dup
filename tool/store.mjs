// D:\program\google\tool\store.mjs
// Penyimpanan dokumen lokal (JSON persistence) untuk Docs, Sheets, Slides

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = process.env.WORKSPACE_STORE_DIR
  ? path.resolve(process.env.WORKSPACE_STORE_DIR)
  : path.resolve(__dirname, 'store');
const INDEX_FILE = path.join(STORE_DIR, 'index.json');

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

function loadIndex() {
  ensureDir();
  if (!fs.existsSync(INDEX_FILE)) {
    return { version: 1, files: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return { version: 1, files: [] };
  }
}

function saveIndex(idx) {
  ensureDir();
  const tmp = INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf8');
  fs.renameSync(tmp, INDEX_FILE);
}

function docPath(id) {
  return path.join(STORE_DIR, `${id}.json`);
}

export function listDocuments() {
  return loadIndex().files;
}

export function getDocument(id) {
  const meta = loadIndex().files.find(f => f.id === id);
  if (!meta) return null;
  const p = docPath(id);
  if (fs.existsSync(p)) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { ...meta, data };
    } catch {
      return meta;
    }
  }
  return meta;
}

export function saveDocument(id, { title, data, type, starred }) {
  const index = loadIndex();
  let meta = index.files.find(f => f.id === id);
  const now = new Date().toISOString();
  if (!meta) {
    const finalType = type || (id.startsWith('sheets-') ? 'sheets' : id.startsWith('slides-') ? 'slides' : 'docs');
    meta = { id, title: title || 'Dokumen Baru', type: finalType, createdAt: now, updatedAt: now };
    if (starred !== undefined) meta.starred = !!starred;
    index.files.push(meta);
  } else {
    if (title) meta.title = title;
    if (type) meta.type = type;
    if (starred !== undefined) meta.starred = !!starred;
    meta.updatedAt = now;
  }
  saveIndex(index);
  if (data !== undefined) {
    fs.writeFileSync(docPath(id), JSON.stringify(data, null, 2), 'utf8');
  }
  return { ...meta, data };
}

// Ambil tipe dokumen (dipakai untuk validasi payload sebelum menyimpan).
export function getDocumentType(id) {
  const meta = loadIndex().files.find(f => f.id === id);
  return meta ? meta.type : null;
}

export function setDocumentStar(id, starred) {
  const index = loadIndex();
  const meta = index.files.find(f => f.id === id);
  if (!meta) return null;
  meta.starred = !!starred;
  saveIndex(index);
  return meta;
}

export function deleteDocument(id) {
  const index = loadIndex();
  const idx = index.files.findIndex(f => f.id === id);
  if (idx !== -1) {
    index.files.splice(idx, 1);
    saveIndex(index);
  }
  const p = docPath(id);
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch {}
  }
  return true;
}

// Definisi kanonik data awal (3 dokumen contoh). Diletakkan di lingkup modul
// supaya isi seed bisa DIPULIHKAN persis seperti aslinya lewat resetSeedData()
// setelah pengujian otomatis mengetik & menyimpan dokumen sungguhan.
const SEED_DOCS = [
      {
        id: 'docs-2002-nominee',
        type: 'docs',
        title: '2002 Nominee List (1).docx',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        data: {
          pages: [
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
          ]
        }
      },
      {
        id: 'sheets-example',
        type: 'sheets',
        title: 'Example Spreadsheet',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        data: {
          cells: {
            'A1': { val: 'Item Pengeluaran', raw: 'Item Pengeluaran' },
            'B1': { val: 'Kategori', raw: 'Kategori' },
            'C1': { val: 250, raw: '=SUM(C2:C4)' },
            'D1': { val: 'Status', raw: 'Status' },
            'A2': { val: 'Server Cloud Pro', raw: 'Server Cloud Pro' },
            'B2': { val: 'Infrastruktur', raw: 'Infrastruktur' },
            'C2': { val: 120, raw: '120' },
            'D2': { val: 'Aktif', raw: 'Aktif' },
            'A3': { val: 'Bandwidth Egress', raw: 'Bandwidth Egress' },
            'B3': { val: 'Jaringan', raw: 'Jaringan' },
            'C3': { val: 45, raw: '45' },
            'D3': { val: 'Aktif', raw: 'Aktif' },
            'A4': { val: 'Cluster Database', raw: 'Cluster Database' },
            'B4': { val: 'Penyimpanan', raw: 'Penyimpanan' },
            'C4': { val: 85, raw: '85' },
            'D4': { val: 'Backup', raw: 'Backup' },
            'A5': { val: 'TOTAL', raw: 'TOTAL' },
            'B5': { val: 'Formula SUM', raw: 'Formula SUM' },
            'C5': { val: 250, raw: '=SUM(C2:C4)' },
            'D5': { val: 'VERIFIED', raw: 'VERIFIED' }
          }
        }
      },
      {
        id: 'slides-krusevac',
        type: 'slides',
        title: 'KRUŠEVAC NEKRETNINE',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        data: {
          slides: [
            {
              id: 1,
              title: 'Slide 1: Cover',
              elements: [
                { id: 'el-1', type: 'rect', x: 0, y: 0, width: 960, height: 12, fill: '#f29900' },
                { id: 'el-2', type: 'rect', x: 60, y: 60, width: 840, height: 420, fill: '#f8f9fa', stroke: '#ebebeb', rx: 8 },
                { id: 'el-3', type: 'text', x: 100, y: 160, text: 'KRUŠEVAC NEKRETNINE', font: 'Google Sans, Arial', size: 38, weight: 'bold', fill: '#1a73e8' },
                { id: 'el-4', type: 'text', x: 100, y: 210, text: 'Eksklusivna Ponuda Stanova i Poslovnog Prostora 2026', font: 'Arial', size: 20, weight: 'normal', fill: '#5f6368' },
                { id: 'el-5', type: 'rect', x: 100, y: 280, width: 220, height: 110, fill: '#e8f0fe', stroke: '#4285f4', rx: 6 },
                { id: 'el-6', type: 'text', x: 120, y: 330, text: 'Lokasi Prima', font: 'Arial', size: 16, weight: 'bold', fill: '#1a73e8' },
                { id: 'el-7', type: 'text', x: 120, y: 360, text: 'Centar grada, Zona 1', font: 'Arial', size: 13, weight: 'normal', fill: '#5f6368' },
                { id: 'el-8', type: 'rect', x: 350, y: 280, width: 220, height: 110, fill: '#e6f4ea', stroke: '#0f9d58', rx: 6 },
                { id: 'el-9', type: 'text', x: 370, y: 330, text: 'Kualitas Bangunan', font: 'Arial', size: 16, weight: 'bold', fill: '#0f9d58' },
                { id: 'el-10', type: 'text', x: 370, y: 360, text: 'A+ Energetski Pasoš', font: 'Arial', size: 13, weight: 'normal', fill: '#5f6368' }
              ]
            },
            {
              id: 2,
              title: 'Slide 2: Aksesibilitas',
              elements: [
                { id: 'el-21', type: 'rect', x: 0, y: 0, width: 960, height: 12, fill: '#f29900' },
                { id: 'el-22', type: 'text', x: 80, y: 80, text: 'Lokasi & Aksesibilitas Properti', font: 'Google Sans, Arial', size: 28, weight: 'bold', fill: '#202124' },
                { id: 'el-23', type: 'circle', cx: 200, cy: 260, r: 100, fill: '#fef7e0', stroke: '#f29900', strokeWidth: 3 },
                { id: 'el-24', type: 'text', x: 145, y: 265, text: 'Radius 500m', font: 'Arial', size: 16, weight: 'bold', fill: '#b06000' },
                { id: 'el-25', type: 'text', x: 380, y: 190, text: '• 5 Menit ke Pusat Perbelanjaan', font: 'Arial', size: 18, weight: 'normal', fill: '#202124' },
                { id: 'el-26', type: 'text', x: 380, y: 240, text: '• Akses Langsung Jalan Protokol', font: 'Arial', size: 18, weight: 'normal', fill: '#202124' },
                { id: 'el-27', type: 'text', x: 380, y: 290, text: '• Kawasan Bebas Banjir & Asri', font: 'Arial', size: 18, weight: 'normal', fill: '#202124' }
              ]
            }
          ]
        }
      }
];

// Isi store dengan 3 dokumen contoh — HANYA bila store masih kosong.
export function initSeedData() {
  ensureDir();
  const index = loadIndex();
  if (index.files.length === 0) {
    SEED_DOCS.forEach(doc => {
      index.files.push({
        id: doc.id,
        type: doc.type,
        title: doc.title,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt
      });
      fs.writeFileSync(docPath(doc.id), JSON.stringify(doc.data, null, 2), 'utf8');
    });
    saveIndex(index);
  }
}

// Pulihkan ISI 3 dokumen contoh ke bentuk kanonik. Pengujian E2E mengetik dan
// menyimpan lewat autosave nyata sehingga isi seed ikut berubah; fungsi ini
// mengembalikan demo ke keadaan rapi tanpa menghapus dokumen lain milik user.
export function resetSeedData() {
  ensureDir();
  const index = loadIndex();
  const now = new Date().toISOString();
  SEED_DOCS.forEach(doc => {
    const meta = index.files.find(f => f.id === doc.id);
    if (meta) {
      meta.type = doc.type;
      meta.title = doc.title;
      meta.updatedAt = now;
    } else {
      index.files.push({
        id: doc.id,
        type: doc.type,
        title: doc.title,
        createdAt: doc.createdAt,
        updatedAt: now
      });
    }
    fs.writeFileSync(docPath(doc.id), JSON.stringify(doc.data, null, 2), 'utf8');
  });
  saveIndex(index);
  return SEED_DOCS.length;
}
