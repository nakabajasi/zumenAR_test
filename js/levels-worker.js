// 図面画像から、近づいて見るための細かい見本を作る（AR の画面で、all.mind に入っていないときだけ使う）。
// 数秒かかるので、画面の動きを止めないよう別の処理として動かす。できた段から順に返す
import { toGray, makeZoomLevels } from './trackpoints.js?rev=local-20261026';

self.onmessage = async (e) => {
  const { url, targetIndex, sizes, targetWidth, targetHeight } = e.data;
  try {
    const response=await fetch(url,{cache:'no-cache'});
    if (!response.ok) throw new Error(`図面画像を読めません（HTTP ${response.status}）`);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const gray = toGray(data, bitmap.width, bitmap.height);
    const t0 = performance.now();
    makeZoomLevels(gray, bitmap.width, bitmap.height, {
      sizes, targetWidth, targetHeight,
      onLevel: (level) => self.postMessage({ targetIndex, level, ms: Math.round(performance.now() - t0) }, [level.data.buffer]),
    });
    bitmap.close();
    self.postMessage({ targetIndex, done: true, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ targetIndex, error: String((err && err.message) || err) });
  }
};
