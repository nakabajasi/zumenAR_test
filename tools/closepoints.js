// 図面全体の座標を保った、近接追跡用の参照画像と特徴点。
import { extractDense } from './trackpoints.js';

export const CLOSE_FRAME_TAG = 'close-up-v1';

export function buildCloseFrame(source, target = source) {
  const short = Math.min(640, source.width, source.height, target.width, target.height);
  const scale = short / Math.min(target.width, target.height);
  const width = Math.round(target.width * scale), height = Math.round(target.height * scale);
  const data = new Uint8Array(width * height);
  // 面積平均。細線を間引きで消さず、元図面全体と同じ範囲を使う。
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * source.height / height);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * source.height / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * source.width / width);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * source.width / width));
      let sum = 0, count = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        sum += source.data[sy * source.width + sx]; count++;
      }
      data[y * width + x] = Math.round(sum / count);
    }
  }
  const frame = { width, height, scale, data, purpose: CLOSE_FRAME_TAG };
  frame.points = extractDense(frame, { spacing: 5, candidateRatio: 0.06 });
  return frame;
}
