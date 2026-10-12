// 同梱MindAR 1.2.5の停止処理を補う。再起動時、旧Workerの返答が新しい処理へ混ざらないようにする。
export function disposeController(controller, tf = window.MINDAR?.IMAGE?.tf) {
  if (!controller || controller._releasedByApp) return;
  controller._releasedByApp = true;
  controller.stopProcessVideo();

  // 待機中のPromiseも終える。tracking.jsは停止を確認し、入力テンソルをfinallyで破棄する。
  const matchDone = controller.workerMatchDone;
  const trackDone = controller.workerTrackDone;
  controller.workerMatchDone = null;
  controller.workerTrackDone = null;
  controller.worker?.terminate();
  matchDone?.({ targetIndex: -1, modelViewTransform: null });
  trackDone?.({ modelViewTransform: null });
  controller.partialTracker?.dispose();
  controller.partialTracker = null;

  // このControllerに属する永続テンソルだけを解放する。共有の計算基盤は終了しない。
  if (tf) {
    const tracker = controller.tracker;
    tf.dispose([
      tracker?.featurePointsListT || [],
      tracker?.imagePixelsListT || [],
      tracker?.imagePropertiesListT || [],
      controller.cropDetector?.detector?.tensorCaches || {},
    ]);
    const loader = controller.inputLoader;
    if (loader?.tempPixelHandle) {
      tf.backend().disposeData(loader.tempPixelHandle.dataId);
      loader.tempPixelHandle = null;
    }
  }
}
