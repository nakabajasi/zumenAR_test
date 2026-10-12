// 配置に使う寸法と追跡に使うデータを、同じall.mindから読み込む。
import { Compiler } from '../lib/mindar/mindar-image.prod.js';

export async function loadDrawingTargets(src) {
  let response;
  try {
    // 同名ファイルを差し替えたときも、ブラウザの保存済みデータを再検証する。
    response = await fetch(src, { cache: 'no-cache' });
  } catch {
    throw new Error('認識データ all.mind を読み込めません。通信状態とファイルの配置を確認してください');
  }
  if (!response.ok) {
    throw new Error(`認識データ all.mind を読み込めません（HTTP ${response.status}）。targets/all.mind の配置を確認してください`);
  }
  let buffer, dimensions;
  try {
    buffer = await response.arrayBuffer();
    const data = new Compiler().importData(buffer);
    if (!Array.isArray(data) || data.length === 0) throw new Error('empty');
    dimensions = data.map(({ targetImage }) => {
      const width = targetImage?.width, height = targetImage?.height;
      if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) throw new Error('dimensions');
      return [width, height];
    });
  } catch {
    throw new Error('認識データ all.mind が無効です。管理用ページで作り直して、targets/all.mind を置き換えてください');
  }
  return { buffer, dimensions };
}
