// D:\program\google\tool\formula.mjs
// Mesin kalkulasi formula spreadsheet (Google Sheets Ritz Engine Evaluator).
//
// Cakupan fungsi (paritas Google Sheets):
//   Agregat : SUM, AVERAGE/AVG, MIN, MAX, COUNT, COUNTA, PRODUCT, MEDIAN
//   Angka   : ROUND, INT, ABS, SQRT, POWER, MOD
//   Logika  : IF, AND, OR, NOT  (+ operator perbandingan > < >= <= = !=)
//   Teks    : CONCAT/CONCATENATE, UPPER, LOWER, TRIM, LEN  (+ operator &)
//   Referensi: sel tunggal (A1), rentang (C2:C4), literaltanpa tanda kutip
//   Deteksi circular dependency antar sel.

// Token kesalahan ala spreadsheet. Sel berisi salah satu ini harus
// DITERUSKAN oleh operasi yang memakainya, bukan diubah jadi 0/#VALUE!.
export const ERROR_TOKENS = ['#DIV/0!', '#VALUE!', '#NAME?', '#REF!', '#NUM!', '#N/A', '#ERROR!'];

export function isErrorToken(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim().toUpperCase();
  // Harus diakhiri '!' atau '?' agar "#tag" atau "#TAGAR" biasa tidak dianggap error.
  return /^#[A-Z0-9\/]+[!?]/.test(s);
}

// Cari token kesalahan pertama di dalam string ekspresi yang sudah
// disubstitusi (mis. '5+#DIV/0!' atau '"#REF!"*2').
function firstErrorToken(s) {
  const m = String(s).match(/#[A-Z0-9\/]+[!?]/);
  return m ? m[0] : null;
}

export function colLabelToIndex(colStr) {
  let idx = 0;
  const s = colStr.toUpperCase();
  for (let i = 0; i < s.length; i++) {
    idx = idx * 26 + (s.charCodeAt(i) - 64);
  }
  return idx - 1; // 0-based
}

export function indexToColLabel(idx) {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function parseCellCoord(coordStr) {
  const m = String(coordStr).trim().toUpperCase().match(/^([A-Z]+)([0-9]+)$/);
  if (!m) return null;
  return {
    col: m[1],
    colIdx: colLabelToIndex(m[1]),
    row: parseInt(m[2], 10)
  };
}

export function expandRange(rangeStr) {
  const parts = String(rangeStr).trim().toUpperCase().split(':');
  if (parts.length === 1) {
    return [parts[0]];
  }
  const start = parseCellCoord(parts[0]);
  const end = parseCellCoord(parts[1]);
  if (!start || !end) return [];

  const minCol = Math.min(start.colIdx, end.colIdx);
  const maxCol = Math.max(start.colIdx, end.colIdx);
  const minRow = Math.min(start.row, end.row);
  const maxRow = Math.max(start.row, end.row);

  const coords = [];
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      coords.push(`${indexToColLabel(c)}${r}`);
    }
  }
  return coords;
}

const MAX_ITER = 25;

function unquote(s) {
  return s.slice(1, -1).replace(/""/g, '"');
}

// Pisah argumen dengan menghormati tanda kurung bersarang & string literal.
// ('=IF(C2>100, SUM(A1:A5), 0)' -> ['C2>100', 'SUM(A1:A5)', '0'])
export function splitArgs(argsStr) {
  const out = [];
  let depth = 0, cur = '', inQuote = false;
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (inQuote) {
      cur += ch;
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') { inQuote = true; cur += ch; continue; }
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// Ambil nilai mentah sebuah sel; jika sel berisi formula, evaluasi rekursif.
// Rantai yang sudah dikunjungi dianggap referensi melingkar -> #REF!,
// BUKAN 0. Dulu flag `circular` dikembalikan tetapi tidak pernah dibaca
// pemanggil, sehingga =A1 di A1 diam-diam tampil 0 (menyembunyikan cacat).
function resolveRawValue(cellKey, cellGetter, visited) {
  const key = String(cellKey).toUpperCase();
  if (visited.has(key)) return { value: '#REF!', circular: true };

  const cellObj = cellGetter(key);
  if (!cellObj) return { value: undefined, empty: true };

  let v = cellObj.raw !== undefined ? cellObj.raw : cellObj.val;
  if (typeof v === 'string' && v.trim().startsWith('=')) {
    v = evaluateFormula(v, cellGetter, new Set(visited).add(key));
  }
  const empty = (v === undefined || v === null || String(v).trim() === '');
  return { value: v, empty };
}

function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(String(v).trim());
  return isNaN(n) ? 0 : n;
}

function numToStr(v) {
  const n = toNum(v);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6);
}

function cellNum(cellKey, getter, visited) {
  return toNum(resolveRawValue(cellKey, getter, visited).value);
}

// Skalar: satu argumen mentah -> nilai bertipe { kind, value }
function scalar(token, getter, visited) {
  const t = String(token === undefined ? '' : token).trim();
  if (t === '') return { kind: 'empty', value: '' };

  // String literal: "BESAR"
  if (/^".*"$/.test(t)) return { kind: 'string', value: unquote(t) };

  // Rentang: C2:C4
  if (/^[A-Z]+\d+\s*:\s*[A-Z]+\d+$/i.test(t)) {
    const coords = expandRange(t);
    if (coords.length) return { kind: 'range', coords };
  }

  // Referensi sel tunggal: C2
  if (parseCellCoord(t)) {
    const r = resolveRawValue(t, getter, new Set(visited));
    if (r.empty) return { kind: 'empty', value: '' };
    const v = r.value;
    if (typeof v === 'number') return { kind: 'number', value: v };
    const trimmed = String(v).trim();
    const n = Number(trimmed);
    if (trimmed !== '' && !isNaN(n)) return { kind: 'number', value: n };
    return { kind: 'string', value: String(v) };
  }

  if (/^(TRUE|FALSE)$/i.test(t)) return { kind: 'boolean', value: /^true$/i.test(t) };

  const n = Number(t);
  if (!isNaN(n)) return { kind: 'number', value: n };

  // Panggilan fungsi bersarang: SUM(A1:A5)
  if (/^[A-Z][A-Z0-9_]*\s*\([\s\S]*\)$/i.test(t)) {
    const v = evaluateFormula('=' + t, getter, new Set(visited));
    if (typeof v === 'number') return { kind: 'number', value: v };
    return { kind: 'string', value: String(v) };
  }

  return { kind: 'string', value: t };
}

// Kumpulkan angka; sel error di dalam rentang dilempar sebagai token error
// supaya SUM/AVERAGE/MIN/... mengembalikan error, bukan diam-diam mengabaikannya.
function collectNumbers(argTokens, getter, visited) {
  const nums = [];
  let err = null;
  for (const tok of argTokens) {
    const s = scalar(tok, getter, visited);
    if (s.kind === 'range') {
      for (const c of s.coords) {
        const r = resolveRawValue(c, getter, new Set(visited));
        if (isErrorToken(r.value)) { if (!err) err = r.value; continue; }
        if (!r.empty) nums.push(toNum(r.value));
      }
    } else if (s.kind === 'number') {
      nums.push(s.value);
    } else if (s.kind === 'boolean') {
      nums.push(s.value ? 1 : 0);
    } else if (isErrorToken(s.value)) {
      if (!err) err = s.value;
    }
  }
  if (err) throw new Error(err);
  return nums;
}

function collectNonEmpty(argTokens, getter, visited) {
  let n = 0;
  for (const tok of argTokens) {
    const s = scalar(tok, getter, visited);
    if (s.kind === 'range') {
      for (const c of s.coords) {
        if (!resolveRawValue(c, getter, new Set(visited)).empty) n++;
      }
    } else if (s.kind !== 'empty') {
      n++;
    }
  }
  return n;
}

function numOf(token, getter, visited) {
  const s = scalar(token, getter, visited);
  if (s.kind === 'number') return s.value;
  if (s.kind === 'boolean') return s.value ? 1 : 0;
  if (s.kind === 'range') {
    let sum = 0;
    for (const c of s.coords) {
      const r = resolveRawValue(c, getter, new Set(visited));
      // Sel error di dalam rentang harus DITERUSKAN, bukan dihitung 0.
      if (isErrorToken(r.value)) return r.value;
      if (!r.empty) sum += toNum(r.value);
    }
    return sum;
  }
  // Nilai yang sudah berupa token error (mis. "#DIV/0!") diteruskan apa adanya.
  if (isErrorToken(s.value)) return s.value;
  return toNum(s.value);
}

function textOf(token, getter, visited) {
  const s = scalar(token, getter, visited);
  if (s.kind === 'range') {
    return s.coords
      .map(c => {
        const r = resolveRawValue(c, getter, new Set(visited));
        return r.empty ? '' : String(r.value);
      })
      .join('');
  }
  if (s.kind === 'number') return numToStr(s.value);
  if (s.kind === 'boolean') return s.value ? 'TRUE' : 'FALSE';
  return s.value === undefined ? '' : String(s.value);
}

// Cari indeks ')' yang memasangkan '(' pada openIdx, dengan menghormati
// string literal (tanda kurung di dalam "..." tidak dihitung).
function matchParen(s, openIdx) {
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Ganti panggilan fungsi terdalam dengan hasil evaluasinya (mendukung nesting).
function inlineNestedCalls(expr, getter, visited) {
  let out = expr;
  let guard = 0;
  const re = /([A-Z][A-Z0-9_]*)\s*\(([^()]*)\)/gi;
  while (guard++ < MAX_ITER && re.test(out)) {
    re.lastIndex = 0;
    out = out.replace(re, (m, name, argsText) => {
      const v = evaluateFormula('=' + name + '(' + argsText + ')', getter, new Set(visited));
      if (typeof v === 'number') return String(v);
      // Token error diteruskan TANPA tanda kutip supaya jalur aritmetika /
      // konkatenasi di luar dapat mendeteksi dan meneruskannya.
      if (isErrorToken(v)) return v;
      return JSON.stringify(String(v));
    });
  }
  return out;
}

// Ganti referensi sel dengan literalnya, tanpa menyentuh isi string literal.
function inlineRefs(expr, getter, visited) {
  const parts = expr.split('"');
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/[A-Za-z]+\d+/g, (ref) => {
      if (!parseCellCoord(ref)) return ref;
      const r = resolveRawValue(ref, getter, new Set(visited));
      if (r.empty) return '0';
      const v = r.value;
      if (typeof v === 'number') return String(v);
      // Token error lolos apa adanya (tanpa tanda kutip) agar dapat diteruskan
      // oleh operator di luarnya, bukan berubah menjadi #VALUE! atau 0.
      if (isErrorToken(v)) return v;
      const trimmed = String(v).trim();
      const n = Number(trimmed);
      if (trimmed !== '' && !isNaN(n)) return String(n);
      return JSON.stringify(String(v));
    });
  }
  return parts.join('"');
}

// Evaluasi kondisi logika: IF(C2>100, ...), AND(...), OR(...)
function evalCondition(exprStr, getter, visited) {
  let s = String(exprStr === undefined ? '' : exprStr).trim();
  if (s === '') return false;

  if (s.includes('(')) s = inlineNestedCalls(s, getter, visited);
  s = inlineRefs(s, getter, visited);

  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  if (/^".*"$/.test(s)) return unquote(s) !== '';
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s) !== 0;

  // '=' tunggal ala spreadsheet -> '==', tanpa merusak '>=', '<=', '!='
  const jsExpr = s.replace(/([^<>!=])=([^=])/g, '$1==$2');
  if (!/^[\s0-9A-Za-z_\u00C0-\u024F\.\+\-\*\/\(\)<>=!"'&%]+$/.test(jsExpr)) return false;
  try {
    return !!Function(`"use strict"; return (${jsExpr});`)();
  } catch {
    return false;
  }
}

function truthyOf(token, getter, visited) {
  const s = scalar(token, getter, visited);
  if (s.kind === 'boolean') return s.value;
  if (s.kind === 'number') return s.value !== 0;
  if (s.kind === 'empty') return false;
  if (s.kind === 'string') {
    const t = String(s.value).trim();
    if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
    if (t !== '' && !isNaN(Number(t))) return Number(t) !== 0;
    if (/[<>=!]/.test(t)) return evalCondition(t, getter, visited);
    return t !== '';
  }
  return true; // range
}

function branchValue(token, getter, visited) {
  const s = scalar(token, getter, visited);
  if (s.kind === 'empty') return '';
  if (s.kind === 'range') return textOf(token, getter, visited);
  return s.value;
}

function roundTo(v, d) {
  const digits = Math.max(0, Math.min(10, Math.floor(d)));
  const f = Math.pow(10, digits);
  return Math.round(toNum(v) * f) / f;
}

// matchesCriteria: Google Sheets criteria — ">100", "<=5", "<>abc", "abc", 100
function matchesCriteria(cellValue, criteria) {
  const cStr = String(criteria).trim();
  // Operator prefix
  const opMatch = cStr.match(/^(<>|>=|<=|>|<|=)(.*)$/);
  if (opMatch) {
    const [, op, rest] = opMatch;
    const cv = typeof cellValue === 'number' ? cellValue : toNum(cellValue);
    const rv = rest.trim() === '' ? 0 : (isNaN(Number(rest)) ? String(rest).toLowerCase() : Number(rest));
    const cvCmp = typeof rv === 'string' ? String(cellValue).toLowerCase() : cv;
    switch (op) {
      case '>':  return cvCmp > rv;
      case '<':  return cvCmp < rv;
      case '>=': return cvCmp >= rv;
      case '<=': return cvCmp <= rv;
      case '<>': return cvCmp !== rv;
      case '=':  return cvCmp === rv;
    }
  }
  // Exact match (case-insensitive for strings)
  if (typeof cellValue === 'number' && !isNaN(Number(cStr))) return cellValue === Number(cStr);
  return String(cellValue).toLowerCase() === cStr.toLowerCase();
}

const FUNCTIONS = {
  SUM: (a, g, v) => collectNumbers(a, g, v).reduce((x, y) => x + y, 0),
  AVERAGE: (a, g, v) => {
    const n = collectNumbers(a, g, v);
    return n.length === 0 ? 0 : n.reduce((x, y) => x + y, 0) / n.length;
  },
  MIN: (a, g, v) => {
    const n = collectNumbers(a, g, v);
    return n.length === 0 ? 0 : Math.min(...n);
  },
  MAX: (a, g, v) => {
    const n = collectNumbers(a, g, v);
    return n.length === 0 ? 0 : Math.max(...n);
  },
  COUNT: (a, g, v) => collectNumbers(a, g, v).length,
  COUNTA: (a, g, v) => collectNonEmpty(a, g, v),
  PRODUCT: (a, g, v) => {
    const n = collectNumbers(a, g, v);
    return n.length === 0 ? 0 : n.reduce((x, y) => x * y, 1);
  },
  MEDIAN: (a, g, v) => {
    const n = collectNumbers(a, g, v).slice().sort((x, y) => x - y);
    if (n.length === 0) return 0;
    const mid = Math.floor(n.length / 2);
    return n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2;
  },
  ROUND: (a, g, v) => roundTo(numOf(a[0], g, v), a.length > 1 ? numOf(a[1], g, v) : 0),
  INT: (a, g, v) => Math.floor(numOf(a[0], g, v)),
  ABS: (a, g, v) => Math.abs(numOf(a[0], g, v)),
  SQRT: (a, g, v) => {
    const n = numOf(a[0], g, v);
    return n < 0 ? '#NUM!' : Math.sqrt(n);
  },
  POWER: (a, g, v) => Math.pow(numOf(a[0], g, v), numOf(a[1], g, v)),
  MOD: (a, g, v) => {
    const d = numOf(a[1], g, v);
    return d === 0 ? '#DIV/0!' : numOf(a[0], g, v) % d;
  },
  IF: (a, g, v) => (evalCondition(a[0], g, v) ? branchValue(a[1], g, v) : branchValue(a[2], g, v)),
  AND: (a, g, v) => a.every(t => truthyOf(t, g, v)),
  OR: (a, g, v) => a.some(t => truthyOf(t, g, v)),
  NOT: (a, g, v) => !truthyOf(a[0], g, v),
  CONCAT: (a, g, v) => a.map(t => textOf(t, g, v)).join(''),
  UPPER: (a, g, v) => textOf(a[0], g, v).toUpperCase(),
  LOWER: (a, g, v) => textOf(a[0], g, v).toLowerCase(),
  TRIM: (a, g, v) => textOf(a[0], g, v).trim().replace(/\s+/g, ' '),
  LEN: (a, g, v) => textOf(a[0], g, v).length,
  LEFT: (a, g, v) => textOf(a[0], g, v).slice(0, Math.max(0, a.length > 1 ? numOf(a[1], g, v) : 1)),
  RIGHT: (a, g, v) => {
    const t = textOf(a[0], g, v);
    const n = Math.max(0, a.length > 1 ? numOf(a[1], g, v) : 1);
    return n === 0 ? '' : t.slice(-n);
  },
  MID: (a, g, v) => {
    const t = textOf(a[0], g, v);
    const start = Math.max(1, numOf(a[1], g, v));
    const len = Math.max(0, numOf(a[2], g, v));
    return t.slice(start - 1, start - 1 + len);
  },
  CEILING: (a, g, v) => {
    const x = numOf(a[0], g, v);
    const sig = a.length > 1 ? numOf(a[1], g, v) : 1;
    return sig === 0 ? 0 : Math.ceil(x / sig) * sig;
  },
  FLOOR: (a, g, v) => {
    const x = numOf(a[0], g, v);
    const sig = a.length > 1 ? numOf(a[1], g, v) : 1;
    return sig === 0 ? 0 : Math.floor(x / sig) * sig;
  },

  // --- CONDITIONAL AGGREGATES ---
  COUNTIF: (a, g, v) => {
    const s = scalar(a[0], g, v);
    if (s.kind !== 'range') return '#VALUE!';
    const crit = textOf(a[1], g, v);
    let count = 0;
    for (const c of s.coords) {
      const r = resolveRawValue(c, g, new Set(v));
      if (!r.empty && matchesCriteria(r.value, crit)) count++;
    }
    return count;
  },
  COUNTIFS: (a, g, v) => {
    // COUNTIFS(range1, criteria1, range2, criteria2, ...)
    if (a.length < 2 || a.length % 2 !== 0) return '#VALUE!';
    const pairs = [];
    for (let i = 0; i < a.length; i += 2) {
      const s = scalar(a[i], g, v);
      if (s.kind !== 'range') return '#VALUE!';
      pairs.push({ coords: s.coords, crit: textOf(a[i + 1], g, v) });
    }
    const len = pairs[0].coords.length;
    if (pairs.some(p => p.coords.length !== len)) return '#VALUE!';
    let count = 0;
    for (let i = 0; i < len; i++) {
      let allMatch = true;
      for (const p of pairs) {
        const r = resolveRawValue(p.coords[i], g, new Set(v));
        if (r.empty || !matchesCriteria(r.value, p.crit)) { allMatch = false; break; }
      }
      if (allMatch) count++;
    }
    return count;
  },
  SUMIF: (a, g, v) => {
    const s = scalar(a[0], g, v);
    if (s.kind !== 'range') return '#VALUE!';
    const crit = textOf(a[1], g, v);
    const sumRange = a.length > 2 ? scalar(a[2], g, v) : s;
    const sumCoords = sumRange.kind === 'range' ? sumRange.coords : s.coords;
    let sum = 0;
    for (let i = 0; i < s.coords.length; i++) {
      const r = resolveRawValue(s.coords[i], g, new Set(v));
      if (!r.empty && matchesCriteria(r.value, crit)) {
        const sv = i < sumCoords.length
          ? resolveRawValue(sumCoords[i], g, new Set(v))
          : { value: 0 };
        sum += toNum(sv.value);
      }
    }
    return sum;
  },
  SUMIFS: (a, g, v) => {
    // SUMIFS(sum_range, criteria_range1, criteria1, ...)
    if (a.length < 3 || a.length % 2 !== 1) return '#VALUE!';
    const sumS = scalar(a[0], g, v);
    if (sumS.kind !== 'range') return '#VALUE!';
    const pairs = [];
    for (let i = 1; i < a.length; i += 2) {
      const s = scalar(a[i], g, v);
      if (s.kind !== 'range') return '#VALUE!';
      pairs.push({ coords: s.coords, crit: textOf(a[i + 1], g, v) });
    }
    const len = sumS.coords.length;
    if (pairs.some(p => p.coords.length !== len)) return '#VALUE!';
    let sum = 0;
    for (let i = 0; i < len; i++) {
      let allMatch = true;
      for (const p of pairs) {
        const r = resolveRawValue(p.coords[i], g, new Set(v));
        if (r.empty || !matchesCriteria(r.value, p.crit)) { allMatch = false; break; }
      }
      if (allMatch) {
        const sv = resolveRawValue(sumS.coords[i], g, new Set(v));
        sum += toNum(sv.value);
      }
    }
    return sum;
  },

  // --- LOOKUP ---
  VLOOKUP: (a, g, v) => {
    const searchVal = scalar(a[0], g, v);
    const tableRange = scalar(a[1], g, v);
    const colIdx = Math.floor(numOf(a[2], g, v));
    const approx = a.length > 3 ? truthyOf(a[3], g, v) : true;
    if (tableRange.kind !== 'range') return '#VALUE!';
    // Tentukan dimensi tabel: butuh hitung kolom dari range
    const first = parseCellCoord(tableRange.coords[0]);
    const last = parseCellCoord(tableRange.coords[tableRange.coords.length - 1]);
    if (!first || !last) return '#REF!';
    const numCols = last.colIdx - first.colIdx + 1;
    const numRows = (last.row - first.row + 1);
    if (colIdx < 1 || colIdx > numCols) return '#REF!';
    const sv = searchVal.kind === 'number' ? searchVal.value
             : searchVal.kind === 'string' ? searchVal.value
             : searchVal.kind === 'boolean' ? (searchVal.value ? 1 : 0) : '';
    let bestRow = -1;
    for (let r = 0; r < numRows; r++) {
      const coordIdx = r * numCols; // first col of this row
      const cellVal = resolveRawValue(tableRange.coords[coordIdx], g, new Set(v));
      const cv = cellVal.empty ? '' : cellVal.value;
      if (approx) {
        // Approximate: find largest value <= searchVal
        if (typeof sv === 'number' && toNum(cv) <= sv) bestRow = r;
      } else {
        // Exact match
        if (String(cv).toLowerCase() === String(sv).toLowerCase()) { bestRow = r; break; }
      }
    }
    if (bestRow < 0) return '#N/A';
    const resultCoord = tableRange.coords[bestRow * numCols + (colIdx - 1)];
    const result = resolveRawValue(resultCoord, g, new Set(v));
    return result.empty ? '' : result.value;
  },
  INDEX: (a, g, v) => {
    const arr = scalar(a[0], g, v);
    const rowNum = Math.floor(numOf(a[1], g, v));
    const colNum = a.length > 2 ? Math.floor(numOf(a[2], g, v)) : 1;
    if (arr.kind !== 'range') return '#VALUE!';
    const first = parseCellCoord(arr.coords[0]);
    const last = parseCellCoord(arr.coords[arr.coords.length - 1]);
    if (!first || !last) return '#REF!';
    const numCols = last.colIdx - first.colIdx + 1;
    if (rowNum < 1 || colNum < 1) return '#REF!';
    const idx = (rowNum - 1) * numCols + (colNum - 1);
    if (idx < 0 || idx >= arr.coords.length) return '#REF!';
    const r = resolveRawValue(arr.coords[idx], g, new Set(v));
    return r.empty ? '' : r.value;
  },
  MATCH: (a, g, v) => {
    const searchVal = scalar(a[0], g, v);
    const arr = scalar(a[1], g, v);
    const matchType = a.length > 2 ? Math.floor(numOf(a[2], g, v)) : 1;
    if (arr.kind !== 'range') return '#VALUE!';
    const sv = searchVal.kind === 'number' ? searchVal.value : String(searchVal.value);
    let bestIdx = -1;
    for (let i = 0; i < arr.coords.length; i++) {
      const r = resolveRawValue(arr.coords[i], g, new Set(v));
      const cv = r.empty ? '' : r.value;
      if (matchType === 0) {
        if (String(cv).toLowerCase() === String(sv).toLowerCase()) return i + 1;
      } else if (matchType === 1) {
        if (toNum(cv) <= toNum(sv)) bestIdx = i;
      } else if (matchType === -1) {
        if (toNum(cv) >= toNum(sv)) bestIdx = i;
      }
    }
    return bestIdx >= 0 ? bestIdx + 1 : '#N/A';
  },

  // --- DATE/TIME ---
  TODAY: () => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  },
  NOW: () => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  },
  RANDBETWEEN: (a, g, v) => {
    const lo = Math.ceil(numOf(a[0], g, v));
    const hi = Math.floor(numOf(a[1], g, v));
    if (lo > hi) return '#NUM!';
    return Math.floor(Math.random() * (hi - lo + 1)) + lo;
  }
};
FUNCTIONS.CONCATENATE = FUNCTIONS.CONCAT;
FUNCTIONS.AVG = FUNCTIONS.AVERAGE;

export function evaluateFormula(formulaStr, cellGetter, visited = new Set()) {
  if (typeof formulaStr !== 'string') return formulaStr;
  const raw = formulaStr.trim();
  if (!raw.startsWith('=')) {
    const num = Number(raw);
    return isNaN(num) || raw === '' ? raw : num;
  }

  const expr = raw.slice(1).trim();
  if (expr === '') return '';

  // 1. Seluruh ekspresi berupa panggilan fungsi: NAME(args...)
  //    WAJIB memakai pemindaian paren seimbang. Regex `^NAME\(.*\)$` bersifat
  //    greedy sehingga keliru menelan ekspresi majemuk seperti
  //    SUM(C2:C4)+ABS(-10) menjadi satu argumen -> hasil 0 (salah).
  const headMatch = expr.match(/^([A-Z][A-Z0-9_]*)\s*\(/i);
  if (headMatch) {
    const openIdx = expr.indexOf('(', headMatch[1].length);
    const closeIdx = matchParen(expr, openIdx);
    if (closeIdx === expr.length - 1) {
      const funcName = headMatch[1].toUpperCase();
      const argsStr = expr.slice(openIdx + 1, closeIdx).trim();
      const argTokens = argsStr.length > 0 ? splitArgs(argsStr) : [];
      const fn = FUNCTIONS[funcName];
      if (fn) {
        try {
          return fn(argTokens, cellGetter, visited);
        } catch (e) {
          // collectNumbers melempar token error (mis. #DIV/0!) agar
          // SUM/AVERAGE/MIN/... meneruskannya alih-alih mengembalikan 0.
          const msg = e && e.message ? String(e.message).trim() : '';
          return isErrorToken(msg) ? msg : '#ERROR!';
        }
      }
      return `#NAME? (Fungsi ${funcName} belum didukung)`;
    }
  }

  // 2. Operator konkatenasi teks: =A1 & " unit"
  if (expr.includes('&')) {
    const parts = expr.split('&').map(part => textOf(part.trim(), cellGetter, visited));
    // Rangkaian teks yang memuat sel error harus meneruskan error itu.
    const errPart = parts.map(p => firstErrorToken(p)).find(Boolean);
    if (errPart) return errPart;
    return parts.join('');
  }

  // 3. Ekspresi aritmatika: A1 + B1, SUM(C2:C4) * 2
  let substituted = expr;
  if (substituted.includes('(')) {
    substituted = inlineNestedCalls(substituted, cellGetter, visited);
  }
  substituted = inlineRefs(substituted, cellGetter, visited);

  // Sel error yang terlibat operasi aritmetika harus diteruskan apa adanya
  // (#DIV/0! tetap #DIV/0!, bukan berubah menjadi #VALUE!).
  const subErr = firstErrorToken(substituted);
  if (subErr) return subErr;

  if (!/^[0-9\s\+\-\*\/\(\)\.]+$/.test(substituted)) {
    return '#VALUE!';
  }

  try {
    const res = Function(`"use strict"; return (${substituted});`)();
    // Pembagian dengan nol menghasilkan Infinity/NaN, BUKAN lemparan error.
    // Tanpa pemeriksaan ini sel menampilkan "Infinity" — Google Sheets
    // menampilkan #DIV/0!. (Substitusi hanya mengizinkan angka + operator,
    // jadi NaN/Infinity di sini pasti berasal dari pembagian nol.)
    if (typeof res !== 'number' || !isFinite(res)) return '#DIV/0!';
    return Math.round(res * 1000) / 1000;
  } catch {
    return '#ERROR!';
  }
}

export function evaluateAllSheetCells(cellsMap) {
  const result = {};
  const baseGetter = (k) => cellsMap[k] || null;

  // Cache nilai sel FORMULA yang sudah final. Tanpa ini setiap sel menelusuri
  // ulang seluruh rantai dependensinya -> O(n^2) (rantai 500 sel = ~570ms).
  // HANYA nilai angka final yang di-cache: nilai error/siklus tidak pernah
  // di-cache supaya deteksi siklus tetap benar dari titik masuk mana pun.
  const finalNums = new Map();
  const getter = (k) => {
    const key = String(k).toUpperCase();
    const cell = baseGetter(key);
    if (!cell) return null;
    const raw = cell.raw !== undefined ? cell.raw : cell.val;
    const isFormula = typeof raw === 'string' && raw.trim().startsWith('=');
    if (isFormula && finalNums.has(key)) return { raw: finalNums.get(key) };
    return cell;
  };

  for (const [coord, cell] of Object.entries(cellsMap)) {
    const raw = cell.raw !== undefined ? cell.raw : (cell.val !== undefined ? cell.val.toString() : '');
    const evaluated = evaluateFormula(raw, getter, new Set());
    if (typeof raw === 'string' && raw.trim().startsWith('=') &&
        typeof evaluated === 'number' && isFinite(evaluated)) {
      finalNums.set(String(coord).toUpperCase(), evaluated);
    }
    const out = { raw, val: evaluated };
    // Pertahankan metadata formatting sel agar tidak hilang saat evaluasi massal.
    for (const key of Object.keys(cell)) {
      if (key !== 'raw' && key !== 'val') out[key] = cell[key];
    }
    result[coord] = out;
  }
  return result;
}
