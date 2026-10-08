// 管理用：認識用データ（all.mind）の作成と、QRコードの生成
import { Compiler } from '../lib/mindar/mindar-image.prod.js';

const $ = (id) => document.getElementById(id);
const ROOT = new URL('..', import.meta.url);
// 判定の目安（追跡用の目印の数）。実機での確認に代わるものではない
const GOOD = 20;
const POOR = 10;

const catalog = await (await fetch(new URL('data/items.json', ROOT), { cache: 'no-cache' })).json();
const items = catalog.items.slice().sort((a, b) => a.targetIndex - b.targetIndex);

/* ---------- 1. 認識用データ ---------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${src} を読み込めません`));
    img.src = new URL(src, ROOT).href;
  });
}

function checkIndexes() {
  items.forEach((it, i) => {
    if (it.targetIndex !== i) throw new Error(`targetIndex は 0 から順に重複なく振ってください（${it.id} が ${it.targetIndex}、期待値は ${i}）`);
  });
}

async function compile() {
  const status = $('compile-status');
  const btn = $('btn-compile');
  btn.disabled = true;
  $('link-download').hidden = true;
  try {
    checkIndexes();
    status.textContent = '図面画像を読み込み中…';
    const images = await Promise.all(items.map((it) => loadImage(it.target.source)));
    const compiler = new Compiler();
    const data = await compiler.compileImageTargets(images, (p) => { status.textContent = `作成中… ${Math.round(p)}%`; });
    const buffer = await compiler.exportData();

    const tbody = $('compile-table').querySelector('tbody');
    tbody.innerHTML = '';
    data.forEach((d, i) => {
      // 検出用：図面を見つけるときの手がかり（いちばん細かい段階の数）
      const finest = d.matchingData.reduce((a, b) => (b.width > a.width ? b : a));
      const detect = finest.maximaPoints.length + finest.minimaPoints.length;
      // 追跡用：見つけたあと追い続けるときの手がかり（MindARが実際に使う段階の数）
      const track = d.trackingData[Math.min(1, d.trackingData.length - 1)].points.length;
      const verdict = track >= GOOD ? '十分' : track >= POOR ? 'やや少ない' : '少ない（枠・写真・文字を含めて作り直す）';
      const size = `${images[i].naturalWidth}×${images[i].naturalHeight}`;
      const mismatch = (items[i].target.widthPx !== images[i].naturalWidth || items[i].target.heightPx !== images[i].naturalHeight)
        ? '（台帳の widthPx / heightPx と不一致）' : '';
      const tr = document.createElement('tr');
      [[String(items[i].targetIndex), 'num'], [items[i].id], [size + mismatch], [String(detect), 'num'], [String(track), 'num'], [verdict]].forEach(([text, cls]) => {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        tr.append(td);
      });
      tbody.append(tr);
    });
    $('compile-table').hidden = false;

    const link = $('link-download');
    link.href = URL.createObjectURL(new Blob([buffer]));
    link.download = 'all.mind';
    link.hidden = false;
    status.textContent = `完了（${items.length}件、${(buffer.byteLength / 1024).toFixed(0)} KB）`;
    window.__compiled = { buffer, data }; // 確認用
  } catch (err) {
    console.error(err);
    status.textContent = `失敗：${err.message}`;
  } finally {
    btn.disabled = false;
  }
}
$('btn-compile').addEventListener('click', compile);

/* ---------- 2. QRコード ---------- */

function renderQr() {
  const grid = $('qr-grid');
  grid.innerHTML = '';
  let base = $('base-url').value.trim();
  if (!base) return;
  if (!base.endsWith('/')) base += '/';
  for (const it of items) {
    const target = `${base}ar.html?id=${encodeURIComponent(it.id)}`;
    const qr = window.qrcode(0, 'M');
    qr.addData(target);
    qr.make();
    const box = document.createElement('div');
    box.className = 'qr';
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    const p = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = it.title || it.id;
    p.append(strong, document.createTextNode(target));
    box.append(p);
    grid.append(box);
  }
}
$('base-url').value = ROOT.href;
$('base-url').addEventListener('input', renderQr);
renderQr();
