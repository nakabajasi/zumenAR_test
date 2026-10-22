// 管理用：認識用データ（all.mind）の作成、資料ごとの位置合わせへの入口、QRコードと展示用シート
import { Compiler } from '../lib/mindar/mindar-image.prod.js';
import { extractDense } from './trackpoints.js';
import { loadCatalogData } from '../js/catalog.js';

const $ = (id) => document.getElementById(id);
const ROOT = new URL('..', import.meta.url);
// 判定の目安（追跡用の手がかりの数）。実機での確認に代わるものではない。
// 実際に各コマで使えるのは、このうち半分弱（ぼけ・暗さ・傾きで減る）。姿勢の計算には6点以上が要る
const GOOD = 45;
const POOR = 20;

const catalog = await loadCatalogData();
const targets = catalog.targets; // この並び順が all.mind の中の順番になる

/* ---------- 1. 認識用データ ---------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${src} を読み込めません`));
    img.src = new URL(src, ROOT).href;
  });
}

async function compile() {
  const status = $('compile-status');
  const btn = $('btn-compile');
  btn.disabled = true;
  $('link-download').hidden = true;
  try {
    status.textContent = '図面画像を読み込み中…';
    const images = await Promise.all(targets.map((t) => loadImage(t.source)));
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
      const mismatch = (targets[i].widthPx !== images[i].naturalWidth || targets[i].heightPx !== images[i].naturalHeight)
        ? '（台帳の widthPx / heightPx と不一致）' : '';
      const tr = document.createElement('tr');
      [[String(i), 'num'], [targets[i].id], [size + mismatch], [String(detect), 'num'], [dense ? `${track}（標準 ${standardCounts[i]}）` : String(track), 'num'], [verdict]].forEach(([text, cls]) => {
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
    status.textContent = `完了（図面${targets.length}枚、${(buffer.byteLength / 1024).toFixed(0)} KB）`;
    window.__compiled = { buffer, data }; // 確認用
  } catch (err) {
    console.error(err);
    status.textContent = `失敗：${err.message}`;
  } finally {
    btn.disabled = false;
  }
}
$('btn-compile').addEventListener('click', compile);

/* ---------- 2. 位置合わせ ---------- */

{
  const tbody = $('align-table').querySelector('tbody');
  for (const it of catalog.items) {
    const tr = document.createElement('tr');
    const d = it.display || {};
    const cells = [it.drawing.id, it.title || it.id, d.mode || 'stand', Array.isArray(d.at) ? `${d.at.map((v) => Math.round(v)).join(', ')}` : '未設定'];
    for (const text of cells) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
    const td = document.createElement('td');
    const a = document.createElement('a');
    a.href = `align.html?id=${encodeURIComponent(it.id)}`;
    a.textContent = '位置合わせ';
    td.append(a);
    tr.append(td);
    tbody.append(tr);
  }
}

/* ---------- 3. QRコードと展示用シート ---------- */

function baseUrl() {
  let base = $('base-url').value.trim();
  if (base && !base.endsWith('/')) base += '/';
  return base;
}

function renderQr() {
  const grid = $('qr-grid');
  grid.innerHTML = '';
  const base = baseUrl();
  $('link-sheet').href = `sheet.html?base=${encodeURIComponent(base)}`;
  if (!base) return;
  for (const t of targets) {
    const target = `${base}ar.html?t=${encodeURIComponent(t.id)}`;
    const qr = window.qrcode(0, 'M');
    qr.addData(target);
    qr.make();
    const box = document.createElement('div');
    box.className = 'qr';
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    const p = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = t.title || t.id;
    p.append(strong, document.createTextNode(target));
    box.append(p);
    grid.append(box);
  }
}
$('base-url').value = ROOT.href;
$('base-url').addEventListener('input', renderQr);
renderQr();
