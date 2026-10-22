// 台帳（data/items.json）の読み込みと整理。three.js を使わないページ（一覧・管理用）からも使う
//
// 台帳の形：
//   targets … 図面（認識の対象）。並び順が all.mind の中の順番になる
//   items   … 資料（3Dモデル1つ）。target に図面の id を書く。1枚の図面に複数の資料を置ける
// 旧形式（資料ごとに target の中身と targetIndex を書く形）も読める
const ROOT = new URL('..', import.meta.url);
export const siteUrl = (path) => new URL(path, ROOT).href;

export function normalizeCatalog(raw) {
  const c = JSON.parse(JSON.stringify(raw));
  c.site = c.site || {};
  if (!Array.isArray(c.targets)) {
    const legacy = c.items.slice().sort((a, b) => a.targetIndex - b.targetIndex);
    c.targets = legacy.map((it) => ({ id: it.id, title: it.title, ...it.target }));
    for (const it of c.items) it.target = it.id;
  }
  const byId = new Map();
  c.targets.forEach((t, i) => {
    if (byId.has(t.id)) throw new Error(`図面の id「${t.id}」が重複しています`);
    t.index = i;
    t.items = [];
    byId.set(t.id, t);
  });
  const ids = new Set();
  for (const it of c.items) {
    if (ids.has(it.id)) throw new Error(`資料の id「${it.id}」が重複しています`);
    ids.add(it.id);
    const t = byId.get(it.target);
    if (!t) throw new Error(`資料「${it.id}」の図面「${it.target}」が targets にありません`);
    it.drawing = t;
    it.targetIndex = t.index;
    t.items.push(it);
  }
  return c;
}

let pending = null;
export function loadCatalogRaw() {
  if (!pending) {
    pending = fetch(siteUrl('data/items.json'), { cache: 'no-cache' }).then((res) => {
      if (!res.ok) throw new Error(`data/items.json を読み込めません (${res.status})`);
      return res.json();
    });
  }
  return pending;
}
export async function loadCatalogData() { return normalizeCatalog(await loadCatalogRaw()); }

// 共有用の URL（注記まで指定できる）。note は「レイヤーの uid.番号」
export function shareUrl(page, { id, note, target } = {}) {
  const u = new URL(page, ROOT);
  if (id) u.searchParams.set('id', id);
  if (target) u.searchParams.set('t', target);
  if (note) u.searchParams.set('note', note);
  return u.href;
}
