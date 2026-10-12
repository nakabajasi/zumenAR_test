// 管理用：認識用データ（all.mind）の作成と、QRコードの生成
import { Compiler } from '../lib/mindar/mindar-image.prod.js';
import { extractDense } from './trackpoints.js';
import { buildCloseFrame, CLOSE_FRAME_TAG } from './closepoints.js?rev=partial-tracking-1';

const $ = (id) => document.getElementById(id);
const ROOT = new URL('..', import.meta.url);
// 判定の目安（追跡用の手がかりの数）。実機での確認に代わるものではない。
// 実際に各コマで使えるのは、このうち半分弱（ぼけ・暗さ・傾きで減る）。姿勢の計算には6点以上が要る
const GOOD = 45;
const POOR = 20;

const catalog = await (await fetch(new URL('data/items.json', ROOT), { cache: 'no-cache' })).json();
const items = catalog.items.slice().sort((a, b) => a.targetIndex - b.targetIndex);

/* ---------- 1. 認識用データ ---------- */

async function loadImage(src) {
  const response = await fetch(new URL(src, ROOT), { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${src} を読み込めません（HTTP ${response.status}）`);
  const imageUrl = URL.createObjectURL(await response.blob());
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`${src} を画像として読み込めません`));
      img.src = imageUrl;
    });
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
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
    // 追跡用の手がかりを、間隔を詰めて選び直す（?dense=0 で標準のまま）
    const dense = new URLSearchParams(location.search).get('dense') !== '0';
    const standardCounts = data.map((d) => d.trackingData[Math.min(1, d.trackingData.length - 1)].points.length);
    if (dense) {
      for (const d of data) {
        const frame = d.trackingData[Math.min(1, d.trackingData.length - 1)];
        const points = extractDense(frame);
        if (points.length > frame.points.length) frame.points = points;
      }
    }
    for (let i = 0; i < data.length; i++) {
      status.textContent = `近接追跡用の特徴点を作成中… ${i + 1}/${data.length}`;
      await new Promise(resolve => setTimeout(resolve, 0));
      const d = data[i];
      d.trackingData = d.trackingData.filter(frame => frame.purpose !== CLOSE_FRAME_TAG);
      d.trackingData.push(buildCloseFrame(d.targetImage));
    }
    const buffer = await compiler.exportData();

    const tbody = $('compile-table').querySelector('tbody');
    tbody.innerHTML = '';
    data.forEach((d, i) => {
      // 検出用：図面を見つけるときの手がかり（いちばん細かい段階の数）
      const finest = d.matchingData.reduce((a, b) => (b.width > a.width ? b : a));
      const detect = finest.maximaPoints.length + finest.minimaPoints.length;
      // 追跡用：見つけたあと追い続けるときの手がかり（MindARが実際に使う段階の数）
      const track = d.trackingData[Math.min(1, d.trackingData.length - 1)].points.length;
      const close = d.trackingData.find(frame => frame.purpose === CLOSE_FRAME_TAG).points.length;
      const verdict = track >= GOOD ? '十分' : track >= POOR ? 'やや少ない' : '少ない（枠・写真・文字を含めて作り直す）';
      const size = `${images[i].naturalWidth}×${images[i].naturalHeight}`;
      const tr = document.createElement('tr');
      [[String(items[i].targetIndex), 'num'], [items[i].id], [size], [String(detect), 'num'], [dense ? `${track}（標準 ${standardCounts[i]}）` : String(track), 'num'], [String(close), 'num'], [verdict]].forEach(([text, cls]) => {
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
