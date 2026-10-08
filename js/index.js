// 一覧。three.js を読み込まずに済むよう、台帳だけを直接読む
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

if (/Line\/|FBAN|FBAV|Instagram|Twitter|MicroMessenger/i.test(navigator.userAgent)) {
  document.getElementById('inapp').hidden = false;
}

const list = document.getElementById('items');
try {
  const res = await fetch('data/items.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`data/items.json を読み込めません (${res.status})`);
  const catalog = await res.json();
  if (catalog.site) {
    if (catalog.site.title) { document.getElementById('site-title').textContent = catalog.site.title; document.title = catalog.site.title; }
    if (catalog.site.lead) document.getElementById('site-lead').textContent = catalog.site.lead;
  }
  list.innerHTML = '';
  for (const item of catalog.items) {
    const li = el('li', 'item');
    li.append(el('h3', null, item.title || item.id));
    li.append(el('p', 'sub', item.subtitle || item.id));
    const actions = el('div', 'actions');
    const ar = el('a', 'btn btn-primary', 'かざして見る');
    ar.href = `ar.html?id=${encodeURIComponent(item.id)}`;
    const viewer = el('a', 'btn', '3Dだけ見る');
    viewer.href = `viewer.html?id=${encodeURIComponent(item.id)}`;
    actions.append(ar, viewer);
    li.append(actions);
    list.append(li);
  }
} catch (err) {
  list.innerHTML = '';
  list.append(el('li', 'callout', err.message));
}
