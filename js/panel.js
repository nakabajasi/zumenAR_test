// 画面下の情報パネル（AR表示と通常ビューアで共通）
// ARは手ぶれで空中の文字が読めないので、文字はすべてここに固定して出す
import { typeLabel } from './common.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function fieldList(pairs) {
  const dl = el('dl', 'fields');
  for (const [label, value] of pairs) {
    if (value == null || String(value).trim() === '') continue; // 未入力の項目は出さない
    dl.append(el('dt', null, label), el('dd', null, String(value)));
  }
  return dl;
}

export function createPanel(root, { onLayerToggle, onClearSelection } = {}) {
  root.classList.add('panel');
  root.innerHTML = '';

  const head = el('button', 'panel-head');
  head.type = 'button';
  const title = el('span', 'panel-title', '');
  const chevron = el('span', 'panel-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  head.append(title, chevron);

  const body = el('div', 'panel-body');
  const selection = el('section', 'panel-selection');
  const layersBox = el('section', 'panel-layers');
  const metaBox = el('section', 'panel-meta');
  body.append(selection, layersBox, metaBox);
  root.append(head, body);

  function setOpen(open) {
    root.classList.toggle('is-open', open);
    head.setAttribute('aria-expanded', String(open));
  }
  // モデルを指でたたいてパネルが開いた直後は、同じ指の動きで出るクリックを無視する（開いてすぐ閉じるのを防ぐ）
  let openedByTapAt = -1e9;
  head.addEventListener('click', () => {
    if (performance.now() - openedByTapAt < 500) return;
    setOpen(!root.classList.contains('is-open'));
  });
  setOpen(false);

  function setItem(item, meta) {
    title.textContent = (meta && meta.title) || item.title || item.id;
    metaBox.innerHTML = '';
    const fields = (meta && meta.fields) || [];
    const dl = fieldList(fields.map((f) => [f.label, f.value]));
    if (dl.children.length) {
      metaBox.append(el('h2', null, '資料情報'), dl);
    } else {
      metaBox.append(el('p', 'muted', '資料情報は未入力です。'));
    }
    if (meta && meta.notice) metaBox.append(el('p', 'notice', meta.notice));
    showSelection(null);
  }

  function setLayers(layers) {
    layersBox.innerHTML = '';
    if (!layers.length) return;
    layersBox.append(el('h2', null, 'アノテーション'));
    const list = el('div', 'chips');
    for (const layer of layers) {
      const chip = el('button', 'chip is-on');
      chip.type = 'button';
      chip.setAttribute('aria-pressed', 'true');
      const dot = el('span', 'chip-dot');
      dot.style.background = layer.color;
      chip.append(dot, el('span', null, layer.name), el('span', 'chip-type', typeLabel(layer.type)));
      chip.addEventListener('click', () => {
        const on = !chip.classList.contains('is-on');
        chip.classList.toggle('is-on', on);
        chip.setAttribute('aria-pressed', String(on));
        onLayerToggle && onLayerToggle(layer, on);
      });
      list.append(chip);
    }
    layersBox.append(list);
  }

  function showSelection(entry) {
    selection.innerHTML = '';
    selection.hidden = !entry;
    if (!entry) return;
    const { layer } = entry;
    const top = el('div', 'selection-top');
    const dot = el('span', 'chip-dot');
    dot.style.background = layer.color;
    const name = el('strong', null, entry.label ? `${layer.name}／${entry.label}` : layer.name);
    const close = el('button', 'selection-close', '閉じる');
    close.type = 'button';
    close.addEventListener('click', () => onClearSelection && onClearSelection());
    top.append(dot, name, el('span', 'chip-type', typeLabel(layer.type)), close);
    selection.append(top);
    if (entry.note) selection.append(el('p', null, entry.note));
    selection.append(fieldList(Object.entries(layer.metadata)));
    if (!root.classList.contains('is-open')) openedByTapAt = performance.now();
    setOpen(true);
  }

  return { setItem, setLayers, showSelection, setOpen, setTitle: (t) => { title.textContent = t; } };
}
