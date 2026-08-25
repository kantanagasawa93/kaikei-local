/**
 * PDF の 1 ページ目を JPEG 画像にラスタライズする (pdf.js 使用).
 *
 * kaikei のサムネ表示・OCR は画像前提なので、領収書 PDF をそのまま取り込むと
 * 「入るけど何も表示・読取されない」状態になる。取り込み時にこの関数で 1 ページ目を
 * JPEG 化して保存すれば、通常の画像領収書と同じ経路 (サムネ + Vision/AI OCR) に乗る。
 *
 * worker は public/pdf.worker.min.mjs に配置済み (静的 export で out/ 直下に出る)。
 */
export async function renderPdfFirstPageToJpeg(
  data: Uint8Array,
  opts: { scale?: number; quality?: number; maxWidth?: number } = {},
): Promise<Uint8Array> {
  const pdfjs = await import("pdfjs-dist");
  // 別 worker を使う (メインスレッドを塞がない)。URL はアプリ配信ルート。
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  // pdf.js は渡した ArrayBuffer を detach するのでコピーを渡す
  const bytes = new Uint8Array(data);
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    const page = await pdf.getPage(1);

    // OCR に効く解像度を狙う (既定 scale 2.0 ≒ 144dpi)。ただし巨大化を防ぐため
    // 目標最大幅を超えたら縮小する。
    let scale = opts.scale ?? 2.0;
    const maxWidth = opts.maxWidth ?? 2200;
    const base = page.getViewport({ scale: 1 });
    if (base.width * scale > maxWidth) {
      scale = maxWidth / base.width;
    }
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context を取得できませんでした");

    // PDF は背景が透明なことがあるので白で塗ってから描画 (JPEG は透明非対応)
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("JPEG エンコードに失敗しました"))),
        "image/jpeg",
        opts.quality ?? 0.9,
      );
    });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    try {
      await pdf.cleanup();
    } catch {
      /* cleanup 失敗は無視 */
    }
  }
}
