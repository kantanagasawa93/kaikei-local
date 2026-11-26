/**
 * PDF を JPEG 画像にラスタライズする (pdf.js 使用)。
 *
 * kaikei のサムネ表示・OCR は画像前提なので、領収書 PDF をそのまま取り込むと
 * 「入るけど何も表示・読取されない」状態になる。取り込み時にこの関数で画像化して
 * 保存すれば、通常の画像領収書と同じ経路 (サムネ + Vision/AI OCR) に乗る。
 *
 * - 複数ページの PDF は、先頭から maxPages ページまでを縦に連結した 1 枚にする。
 *   (以前は 1 ページ目だけで、請求書の 2 ページ目以降の明細・合計が画像に残らなかった)
 * - 画像はあくまで閲覧・OCR 用のプレビュー。元の PDF は呼び出し側が原本として
 *   別途保存すること (電子取引データは受け取った形式のまま保存する必要がある)。
 * - 日本語フォントを埋め込んでいない PDF は CMap が無いと文字が描画されないので、
 *   pdf.js 同梱の cmaps / standard_fonts を /pdfjs/ から読ませる
 *   (scripts/sync-pdfjs-assets.mjs がビルド前に public/ へコピーする)。
 *
 * worker は public/pdf.worker.min.mjs (静的 export で out/ 直下に出る)。
 */

/** WebKit の canvas は 1 辺 16384px が上限。余裕を持って抑える。 */
const MAX_CANVAS_HEIGHT = 15000;

export interface RenderedPdf {
  jpeg: Uint8Array;
  /** PDF の総ページ数 */
  pageCount: number;
  /** 画像に含めたページ数 (maxPages で打ち切った場合は pageCount より小さい) */
  renderedPages: number;
}

/**
 * ページ寸法から描画倍率を決める (純関数。テスト用に切り出し)。
 * 幅が maxWidth を超えない範囲で baseScale を使い、連結後の高さが上限を超える時は
 * 全ページを同じ比率で縮める。
 */
export function planPdfRender(
  pages: { width: number; height: number }[],
  opts: { baseScale?: number; maxWidth?: number; maxHeight?: number } = {},
): { scale: number; width: number; height: number } {
  const baseScale = opts.baseScale ?? 2.0;
  const maxWidth = opts.maxWidth ?? 2200;
  const maxHeight = opts.maxHeight ?? MAX_CANVAS_HEIGHT;
  if (pages.length === 0) return { scale: baseScale, width: 0, height: 0 };

  const widest = Math.max(...pages.map((p) => p.width));
  const totalHeight = pages.reduce((s, p) => s + p.height, 0);
  let scale = baseScale;
  if (widest * scale > maxWidth) scale = maxWidth / widest;
  if (totalHeight * scale > maxHeight) scale = maxHeight / totalHeight;
  return {
    scale,
    width: Math.ceil(widest * scale),
    height: Math.ceil(totalHeight * scale),
  };
}

export async function renderPdfToJpeg(
  data: Uint8Array,
  opts: { scale?: number; quality?: number; maxWidth?: number; maxPages?: number } = {},
): Promise<RenderedPdf> {
  const pdfjs = await import("pdfjs-dist");
  // 別 worker を使う (メインスレッドを塞がない)。URL はアプリ配信ルート。
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  // pdf.js は渡した ArrayBuffer を detach するのでコピーを渡す
  const bytes = new Uint8Array(data);
  const pdf = await pdfjs.getDocument({
    data: bytes,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
  try {
    const pageCount = pdf.numPages;
    const renderedPages = Math.min(pageCount, Math.max(1, opts.maxPages ?? 6));

    const pages = [];
    for (let i = 1; i <= renderedPages; i++) {
      pages.push(await pdf.getPage(i));
    }
    const sizes = pages.map((p) => {
      const v = p.getViewport({ scale: 1 });
      return { width: v.width, height: v.height };
    });
    const plan = planPdfRender(sizes, { baseScale: opts.scale, maxWidth: opts.maxWidth });

    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context を取得できませんでした");

    // PDF は背景が透明なことがあるので白で塗ってから描画 (JPEG は透明非対応)
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 1 ページずつ個別の canvas に描いてから貼る (pdf.js は canvas 全体を使う前提のため)
    let offsetY = 0;
    for (const page of pages) {
      const viewport = page.getViewport({ scale: plan.scale });
      const pageCanvas = document.createElement("canvas");
      pageCanvas.width = Math.ceil(viewport.width);
      pageCanvas.height = Math.ceil(viewport.height);
      const pageCtx = pageCanvas.getContext("2d");
      if (!pageCtx) throw new Error("canvas 2d context を取得できませんでした");
      pageCtx.fillStyle = "#ffffff";
      pageCtx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      await page.render({ canvasContext: pageCtx, viewport }).promise;
      ctx.drawImage(pageCanvas, 0, offsetY);
      offsetY += pageCanvas.height;
      // ページ canvas のメモリを早めに返す
      pageCanvas.width = 0;
      pageCanvas.height = 0;
    }

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("JPEG エンコードに失敗しました"))),
        "image/jpeg",
        opts.quality ?? 0.9,
      );
    });
    return {
      jpeg: new Uint8Array(await blob.arrayBuffer()),
      pageCount,
      renderedPages,
    };
  } finally {
    try {
      await pdf.cleanup();
    } catch {
      /* cleanup 失敗は無視 */
    }
  }
}
