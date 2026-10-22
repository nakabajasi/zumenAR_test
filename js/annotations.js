// 注記（アノテーション）データの読み込み。three.js を使わないページ（注記一覧・照合ツール）からも使う。
//
// 台帳の annotations に書けるもの：
//   "data/x/annotations.json" … JSON で書いた注記（従来の形）
//   { "glb": "data/x/notes.glb", "table": "data/遺構一覧.csv", "key": "遺構番号", "layer": "種別", "note": "備考" }
//       … 図面のベクトルデータを Blender で 3D に置いて書き出した図形と、現場で作った遺構一覧表
//
// 考え方：
//   図形（GLB）から使うのは、形・位置とオブジェクト名（＝遺構番号）だけ。図面データの属性・カスタムプロパティ・色は使わない
//   文字はすべて遺構一覧表から取る。表は現場で作ったものをそのまま使い、注記のために作り直さない
//   図形と表は「オブジェクト名 = 表の key 列の値」でつなぐ。全角・半角、大文字・小文字、空白の違いは同じとみなす
//   1つの表を、複数の資料（GLB）で使い回せる。表にあって GLB に無い遺構は、その資料に載っていないだけなので問題にしない
//   GLB にあって表に無い図形は表示しない（調査区の境界線などの、注記でない線を混ぜないため）。照合ツールで確認できる
import { siteUrl } from './catalog.js';

const TYPE_JA = { Point: '点', Line: '線', Area: '面' };
// 色の指定が無いときの色。同じ種類のまとまりが複数あれば順に変える
const PALETTE = { Point: ['#ff3b30', '#ff9500', '#af52de'], Line: ['#1e90ff', '#00c7be', '#5856d6'], Area: ['#d6249f', '#34c759', '#ffcc00', '#5ac8fa'] };

// 遺構番号の照合に使う形：全角→半角、空白を除く、英字は大文字
export const normalizeKey = (v) => String(v == null ? '' : v).normalize('NFKC').replace(/\s+/g, '').toUpperCase();
// Blender が同じ名前に付ける .001 などを外す（1つの遺構を複数のオブジェクトで描いた場合に、1つにまとめる）
export const baseName = (name) => String(name).replace(/\.\d{3}$/, '');

export async function loadAnnotationData(item) {
  const spec = item.annotations;
  if (!spec) return null;
  if (typeof spec === 'string' && !/\.glb$/i.test(spec)) {
    const res = await fetch(siteUrl(spec), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${spec} を読み込めません (${res.status})`);
    return res.json();
  }
  const src = await loadAnnotationSources(item, { tableRequired: false });
  const data = fromDrawing(src.nodes, src.table, src.spec);
  if (src.spec.table && !src.table) data.warnings.unshift(`表 ${src.spec.table} を読み込めません。図形だけを表示しています`);
  return data;
}

// 図形（GLB）と表を読む。照合ツールからも使う
export async function loadAnnotationSources(item, { tableRequired = true } = {}) {
  const spec = typeof item.annotations === 'string' ? { glb: item.annotations } : { ...item.annotations };
  const [glb, table] = await Promise.all([
    fetch(siteUrl(spec.glb), { cache: 'no-cache' }).then((res) => {
      if (!res.ok) throw new Error(`${spec.glb} を読み込めません (${res.status})`);
      return res.arrayBuffer();
    }),
    spec.table ? fetch(siteUrl(spec.table), { cache: 'no-cache' }).then((res) => {
      if (res.ok) return res.arrayBuffer();
      if (tableRequired) throw new Error(`${spec.table} を読み込めません (${res.status})`);
      return null;
    }) : null,
  ]);
  const decoded = table ? decodeText(table) : null;
  return {
    spec,
    nodes: readGlb(glb, spec.glb),
    table: decoded ? { ...parseTable(decoded.text, spec), encoding: decoded.encoding } : null,
  };
}

/* ---------- 表（CSV・TSV） ---------- */

// Excel で保存した CSV は Shift_JIS のことが多いので、UTF-8 で読めなければ Shift_JIS として読む
export function decodeText(buffer) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, ''), encoding: 'UTF-8' };
  } catch (err) {
    return { text: new TextDecoder('shift_jis').decode(buffer), encoding: 'Shift_JIS' };
  }
}

function splitCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = firstLine.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * 遺構一覧表を読む。spec.key（遺構番号の列名）を見出しに含む行を見出し行とみなすので、
 * 表の上に表題や作成日の行があってもよい。spec.key が無ければ、最初の空でない行を見出し、左端の列を key とする
 */
export function parseTable(text, spec = {}) {
  const raw = splitCsv(text);
  const nonEmpty = raw.map((r, i) => [r, i]).filter(([r]) => r.some((v) => v.trim() !== ''));
  if (!nonEmpty.length) throw new Error('表が空です');
  const want = spec.key ? normalizeKey(spec.key) : null;
  const found = want ? nonEmpty.find(([r]) => r.some((v) => normalizeKey(v) === want)) : nonEmpty[0];
  if (!found) throw new Error(`表に「${spec.key}」の列が見つかりません（台帳の annotations.key と表の見出しを確かめてください）`);
  const [header, headerIndex] = found;
  // 見出しの重複には番号を足す。空の見出しの列は使わない
  const seenTitle = new Map();
  const titles = header.map((h) => {
    const t = h.trim();
    if (!t) return '';
    const n = (seenTitle.get(t) || 0) + 1;
    seenTitle.set(t, n);
    return n > 1 ? `${t}(${n})` : t;
  });
  const col = (name) => (name ? titles.findIndex((t) => normalizeKey(t) === normalizeKey(name)) : -1);
  const keyCol = want ? col(spec.key) : titles.findIndex((t) => t);
  const roles = { label: col(spec.label), note: col(spec.note), layer: col(spec.layer) };
  for (const [role, i] of Object.entries(roles)) {
    if (spec[role] && i < 0) throw new Error(`表に「${spec[role]}」の列が見つかりません（台帳の annotations.${role}）`);
  }
  const rows = [];
  for (let r = headerIndex + 1; r < raw.length; r++) {
    const cells = raw[r];
    const key = (cells[keyCol] || '').trim();
    if (!key) continue;
    const fields = {};
    titles.forEach((t, i) => {
      if (!t || i === keyCol || i === roles.label || i === roles.note || i === roles.layer) return;
      const v = (cells[i] || '').trim();
      if (v) fields[t] = v;
    });
    rows.push({
      key, line: r + 1,
      label: roles.label >= 0 ? (cells[roles.label] || '').trim() : key,
      note: roles.note >= 0 ? (cells[roles.note] || '').trim() : '',
      layer: roles.layer >= 0 ? (cells[roles.layer] || '').trim() : '',
      fields,
    });
  }
  return { keyTitle: titles[keyCol], headerLine: headerIndex + 1, columns: titles.filter(Boolean), rows };
}

/* ---------- GLB（three.js を使わずに読む） ---------- */

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const ARRAYS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

function readGlb(buffer, path) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`${path} は GLB ではありません`);
  let offset = 12, json = null, bin = null;
  while (offset < buffer.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, offset + 8, length)));
    else if (type === 0x004e4942) bin = new Uint8Array(buffer, offset + 8, length);
    offset += 8 + length;
  }
  const used = json.extensionsRequired || [];
  if (used.length) throw new Error(`${path} は圧縮などの拡張（${used.join(', ')}）を使っています。注記の GLB は圧縮せずに書き出してください`);

  const accessor = (index) => {
    const a = json.accessors[index];
    const n = COMPONENTS[a.type];
    const Arr = ARRAYS[a.componentType];
    const out = new Float64Array(a.count * n);
    if (a.bufferView == null) return { data: out, n, count: a.count };
    const bv = json.bufferViews[a.bufferView];
    const stride = bv.byteStride || n * Arr.BYTES_PER_ELEMENT;
    const base = bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0);
    for (let i = 0; i < a.count; i++) {
      const src = new Arr(bin.buffer, base + i * stride, n);
      for (let k = 0; k < n; k++) out[i * n + k] = src[k];
    }
    return { data: out, n, count: a.count };
  };

  // 各ノードの位置・向き・大きさを、シーンの原点から見た 4×4 行列（列ごとに並べたもの）にする
  const mul = (A, B) => {
    const C = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) C[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k];
    return C;
  };
  const local = (node) => {
    if (node.matrix) return node.matrix.slice();
    const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale || [1, 1, 1];
    const [tx, ty, tz] = node.translation || [0, 0, 0];
    return [
      (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
      2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
      tx, ty, tz, 1,
    ];
  };
  const nodes = [];
  const walk = (index, parent) => {
    const node = json.nodes[index];
    const world = mul(parent, local(node));
    const geo = { points: [], segments: [], triangles: [], positions: [] };
    if (node.mesh != null) {
      for (const prim of json.meshes[node.mesh].primitives) {
        if (prim.attributes.POSITION == null) continue;
        const pos = accessor(prim.attributes.POSITION);
        const base = geo.positions.length;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.data[i * 3], y = pos.data[i * 3 + 1], z = pos.data[i * 3 + 2];
          geo.positions.push([
            world[0] * x + world[4] * y + world[8] * z + world[12],
            world[1] * x + world[5] * y + world[9] * z + world[13],
            world[2] * x + world[6] * y + world[10] * z + world[14],
          ]);
        }
        const idx = prim.indices != null ? Array.from(accessor(prim.indices).data, (v) => v + base)
          : Array.from({ length: pos.count }, (_, i) => i + base);
        const mode = prim.mode == null ? 4 : prim.mode;
        if (mode === 0) geo.points.push(...idx);
        else if (mode === 1) for (let i = 0; i + 1 < idx.length; i += 2) geo.segments.push([idx[i], idx[i + 1]]);
        else if (mode === 2 || mode === 3) {
          for (let i = 0; i + 1 < idx.length; i++) geo.segments.push([idx[i], idx[i + 1]]);
          if (mode === 2 && idx.length > 2) geo.segments.push([idx[idx.length - 1], idx[0]]);
        } else if (mode === 4) for (let i = 0; i + 2 < idx.length; i += 3) geo.triangles.push([idx[i], idx[i + 1], idx[i + 2]]);
        else if (mode === 5) for (let i = 0; i + 2 < idx.length; i++) geo.triangles.push(i % 2 ? [idx[i + 1], idx[i], idx[i + 2]] : [idx[i], idx[i + 1], idx[i + 2]]);
        else if (mode === 6) for (let i = 1; i + 1 < idx.length; i++) geo.triangles.push([idx[0], idx[i], idx[i + 1]]);
      }
    }
    nodes.push({ name: node.name || `node${index}`, world, children: (node.children || []).length, geo });
    for (const child of node.children || []) walk(child, world);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = json.scenes[json.scene || 0];
  for (const root of scene.nodes) walk(root, identity);
  return nodes;
}

/* ---------- 形から注記を作る ---------- */

const keyOf = (p) => p.map((v) => Math.round(v * 1e6)).join(',');

// 位置が同じ点を1つにまとめる（Blender は UV などの都合で同じ位置の点を分けて書き出す）
function weld(positions) {
  const map = new Map();
  const remap = positions.map((p) => {
    const k = keyOf(p);
    if (!map.has(k)) map.set(k, map.size);
    return map.get(k);
  });
  const unique = new Array(map.size);
  positions.forEach((p, i) => { unique[remap[i]] = p; });
  return { remap, unique };
}

// 辺をつないで線にする。戻り値は { points, closed } の一覧
function chain(segments) {
  const adj = new Map();
  const add = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
  for (const [a, b] of segments) if (a !== b) { add(a, b); add(b, a); }
  const used = new Set();
  const edge = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const out = [];
  const starts = [...adj.keys()].sort((a, b) => (adj.get(a).length === 1 ? 0 : 1) - (adj.get(b).length === 1 ? 0 : 1));
  for (const s of starts) {
    for (;;) {
      const first = adj.get(s).find((n) => !used.has(edge(s, n)));
      if (first == null) break;
      const line = [s];
      let cur = s, next = first, closed = false;
      while (next != null) {
        used.add(edge(cur, next));
        if (next === s) { closed = true; break; }
        line.push(next);
        cur = next;
        next = adj.get(cur).find((n) => !used.has(edge(cur, n)));
      }
      out.push({ points: line, closed });
    }
  }
  return out;
}

function shapeOf(node, type) {
  const g = node.geo;
  const { remap, unique } = weld(g.positions);
  const segs = g.segments.map(([a, b]) => [remap[a], remap[b]]);
  const tris = g.triangles.map((t) => t.map((i) => remap[i]));
  const toPaths = (chains) => chains.map((c) => ({ points: c.points.map((i) => unique[i]), closed: c.closed }));

  if (type === 'Point') {
    if (!unique.length) return { position: [node.world[12], node.world[13], node.world[14]] };
    const c = [0, 0, 0];
    for (const p of unique) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    return { position: c.map((v) => v / unique.length) };
  }
  if (type === 'Area' && tris.length) {
    // 塗った面：三角形のまま使い、輪郭（1枚の三角形にしか使われていない辺）を線にする
    const count = new Map();
    for (const t of tris) for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3], key = a < b ? `${a}-${b}` : `${b}-${a}`;
      count.set(key, (count.get(key) || 0) + 1);
    }
    const border = [...count].filter(([, n]) => n === 1).map(([key]) => key.split('-').map(Number));
    return { paths: toPaths(chain(border)), fill: { positions: unique, triangles: tris } };
  }
  const paths = toPaths(chain(segs));
  if (!paths.length && tris.length) {
    // 太さを付けたカーブなど、線を面で作ったもの：面の辺から線を拾えないので、面のまま出す
    return { paths: [], fill: { positions: unique, triangles: tris }, solid: true };
  }
  return { paths };
}

function inferType(node) {
  const g = node.geo;
  if (!g.positions.length) return node.children ? null : 'Point';   // 子を持つエンプティは入れ物とみなす
  if (g.triangles.length) return 'Area';
  if (g.segments.length) return chain(g.segments).every((c) => c.closed) ? 'Area' : 'Line';
  return 'Point';
}


/* ---------- 図形と表をつなぐ ---------- */

/**
 * GLB のオブジェクトを、遺構番号ごとにまとめる。同じ番号（SI01 と SI01.001 など）は1つの注記にする。
 * 種類は形だけで決まる（エンプティ・1点＝点、開いた線＝線、閉じた線・面＝面）。
 * まとめたオブジェクトの中に面があれば面、閉じた線だけなら面、開いた線があれば線とする
 */
export function collectUnits(nodes) {
  const units = new Map();
  for (const node of nodes) {
    if (!node.geo.positions.length && node.children) continue;   // 子を持つエンプティは入れ物
    const name = baseName(node.name);
    const id = normalizeKey(name);
    if (!units.has(id)) units.set(id, { id, name, nodes: [] });
    units.get(id).nodes.push(node);
  }
  const rank = { Point: 0, Line: 1, Area: 2 };
  for (const u of units.values()) {
    const types = u.nodes.map(inferType).filter(Boolean);
    // 輪郭（閉じた線）と断面線（開いた線）を同じ番号で描いた場合は、輪郭を優先して面にする
    u.type = types.includes('Area') ? 'Area' : types.sort((a, b) => rank[b] - rank[a])[0] || null;
  }
  return [...units.values()].filter((u) => u.type);
}

// まとめたオブジェクトの形を1つにする（同じ線が重なっていれば1本にする）
function shapeOfUnit(unit, type) {
  const shapes = unit.nodes.map((n) => shapeOf(n, type));
  if (type === 'Point') return shapes[0];
  const out = { paths: [], fill: null, solid: false };
  const seen = new Set();
  const sig = (p) => p.points.map((q) => q.map((v) => Math.round(v * 1e5)).join(',')).join(';');
  for (const sh of shapes) {
    for (const p of sh.paths) {
      const k = sig(p);
      if (seen.has(k) || seen.has(sig({ points: p.points.slice().reverse() }))) continue;
      seen.add(k);
      out.paths.push(p);
    }
    if (sh.fill) {
      if (!out.fill) out.fill = { positions: [], triangles: [] };
      const base = out.fill.positions.length;
      out.fill.positions.push(...sh.fill.positions);
      out.fill.triangles.push(...sh.fill.triangles.map((t) => t.map((i) => i + base)));
    }
    if (sh.solid) out.solid = true;
  }
  return out;
}

// 図形と表の対応を調べる（表示と照合ツールで共通）
export function matchDrawing(nodes, table) {
  const units = collectUnits(nodes);
  const rowsByKey = new Map();
  const duplicates = [];
  for (const row of table ? table.rows : []) {
    const k = normalizeKey(row.key);
    if (rowsByKey.has(k)) { duplicates.push(row); continue; }
    rowsByKey.set(k, row);
  }
  const matched = [], drawingOnly = [];
  for (const u of units) {
    const row = rowsByKey.get(u.id);
    if (row) matched.push({ unit: u, row }); else drawingOnly.push(u);
  }
  const used = new Set(matched.map((m) => m.row));
  const tableOnly = table ? [...rowsByKey.values()].filter((r) => !used.has(r)) : [];
  return { units, matched, drawingOnly, tableOnly, duplicates };
}

function fromDrawing(nodes, table, spec) {
  const warnings = [];
  const { units, matched, drawingOnly, duplicates } = matchDrawing(nodes, table);
  for (const d of duplicates) warnings.push(`表の ${d.line} 行目「${d.key}」は、同じ番号がすでにあります（後の行は使いません）`);
  // 表があれば、表に載っている図形だけを注記にする。無ければ、図形をすべてオブジェクト名で出す（確認用）
  const entries = table ? matched : units.map((unit) => ({ unit, row: null }));
  if (table && drawingOnly.length) {
    warnings.push(`表に無いので表示しない図形：${drawingOnly.map((u) => u.name).join('、')}（照合ツール tools/match.html で確かめられます）`);
  }

  const layers = new Map();
  for (const { unit, row } of entries) {
    const type = unit.type;
    const shape = shapeOfUnit(unit, type);
    if (type !== 'Point' && !shape.paths.length && !shape.fill) {
      warnings.push(`「${unit.name}」に線がありません（Blender の書き出しで「ルーズエッジ」を入れたか確かめてください）`);
      continue;
    }
    const layerName = (row && row.layer) || TYPE_JA[type];
    const lkey = `${type}:${layerName}`;
    if (!layers.has(lkey)) {
      const sameType = [...layers.values()].filter((l) => l.Annotation_Type === type).length;
      layers.set(lkey, {
        uid: layerName, name: layerName, Annotation_Type: type,
        color: PALETTE[type][sameType % PALETTE[type].length], metadata: {}, items: [],
      });
    }
    // 共有リンクに使う名前は、表に書かれた遺構番号そのもの（表が無ければオブジェクト名）
    const item = {
      key: row ? row.key : unit.name,
      label: row ? row.label : unit.name,
      note: row ? row.note : '',
      fields: row ? { ...row.fields } : {},
    };
    if (spec && spec.key && row && item.label !== row.key) item.fields = { [table.keyTitle]: row.key, ...item.fields };
    if (type === 'Point') item.position = shape.position;
    else {
      item.paths = shape.paths;
      item.points = shape.paths[0] ? shape.paths[0].points : [];
      if (shape.fill) item.fill = shape.fill;
      if (shape.solid) item.solid = true;
    }
    layers.get(lkey).items.push(item);
  }
  if (warnings.length) console.warn(warnings.join('\n'));
  return { coordinate: 'glb', layers: [...layers.values()], warnings };
}

/* ---------- 長さ・面積（注記一覧で使う） ---------- */

export function pathLength(points, closed) {
  let sum = 0;
  const n = points.length;
  for (let i = 1; i < n + (closed ? 1 : 0); i++) {
    const a = points[i - 1], b = points[i % n];
    sum += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return sum;
}

export function surfaceArea(fill) {
  let sum = 0;
  for (const [a, b, c] of fill.triangles) {
    const p = fill.positions[a], q = fill.positions[b], r = fill.positions[c];
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    sum += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return sum;
}
