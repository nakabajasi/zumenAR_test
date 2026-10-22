// 一覧。three.js を読み込まずに済むよう、台帳だけを読む
import { loadCatalogData, shareUrl } from './catalog.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

if (/Line\/|FBAN|FBAV|Instagram|Twitter|MicroMessenger/i.test(navigator.userAgent)) {
  document.getElementById('inapp').hidden = false;
}

const box = document.getElementById('items');
try {
  const catalog = await loadCatalogData();
  const { site } = catalog;
  if (site.title) { document.getElementById('site-title').textContent = site.title; document.title = site.title; }
  if (site.lead) document.getElementById('site-lead').textContent = site.lead;
  if (site.notice) { const n = document.getElementById('notice'); n.textContent = site.notice; n.hidden = false; }
  const stamp = [site.edition ? `データ版 ${site.edition}` : '', site.cite || ''].filter(Boolean).join('　');
  if (stamp) document.getElementById('edition').textContent = `${stamp}。`;

  box.innerHTML = '';
  for (const t of catalog.targets) {
    const group = el('section', 'drawing-group');
    group.append(el('h3', 'drawing-title', t.title || t.id));
    const list = el('ul', 'items');
    for (const item of t.items) {
      const li = el('li', 'item');
      li.append(el('h3', null, item.title || item.id));
      li.append(el('p', 'sub', item.subtitle || item.id));
      const actions = el('div', 'actions');
      const ar = el('a', 'btn btn-primary', 'かざして見る');
      ar.href = shareUrl('ar.html', { id: item.id });
      const viewer = el('a', 'btn', '3Dだけ見る');
      viewer.href = shareUrl('viewer.html', { id: item.id });
      const notes = el('a', 'btn', '注記');
      notes.href = shareUrl('notes.html', { id: item.id });
      actions.append(ar, viewer, notes);
      li.append(actions);
      list.append(li);
    }
    group.append(list);
    box.append(group);
  }
} catch (err) {
  box.innerHTML = '';
  box.append(el('p', 'callout', err.message));
}
