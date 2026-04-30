/**
 * 領収書画像を OCR / Storage アップロード前に縮小する。
 *
 * iPhone のカメラで撮ると 1 枚 3〜5MB の HEIC/JPEG が普通に出てくるが、
 * Claude OCR は長辺 1568px 程度までしか活用しないため、それ以上のサイズは
 * 単にアップロード時間 (= 体感の遅さ) を増やすだけになる。
 *
 * 方針:
 * - 長辺を MAX_LONG_EDGE_PX に揃える (それ以下なら何もしない)
 * - JPEG quality 0.85 で再エンコード
 * - 元ファイルが既に十分小さい (< SKIP_BYTES) 場合はそのまま返す
 * - Canvas が失敗した場合 (HEIC など) は元ファイルを返してフォールバック
 *
 * Storage にも縮小版を保存する設計。原本を保ちたい場合は呼び出し側で
 * 分岐する (現状そのニーズはない)。
 */

const MAX_LONG_EDGE_PX = 1600;
const JPEG_QUALITY = 0.85;
const SKIP_BYTES = 500 * 1024; // 500KB 未満はスキップ

export interface CompressionResult {
  /** 縮小後のファイル (圧縮できなかった場合は入力そのまま) */
  file: File;
  /** 圧縮が実際に行われたか */
  compressed: boolean;
  /** 元サイズ (byte) */
  originalBytes: number;
  /** 結果サイズ (byte) */
  resultBytes: number;
}

/**
 * Canvas で画像を縮小して JPEG File を返す。
 * ブラウザ (Tauri WebView 含む) で動作。
 */
export async function compressImageForOcr(file: File): Promise<CompressionResult> {
  const originalBytes = file.size;

  // 既に小さければスキップ
  if (originalBytes < SKIP_BYTES) {
    return { file, compressed: false, originalBytes, resultBytes: originalBytes };
  }

  // 画像でなければスキップ (PDF など将来の拡張に備えた安全策)
  if (!file.type.startsWith("image/")) {
    return { file, compressed: false, originalBytes, resultBytes: originalBytes };
  }

  let bitmap: ImageBitmap | null = null;
  try {
    // createImageBitmap は Img タグより速く、orientation も尊重する
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // HEIC や壊れた画像など。元ファイルで処理続行。
    return { file, compressed: false, originalBytes, resultBytes: originalBytes };
  }

  const { width: srcW, height: srcH } = bitmap;
  const longEdge = Math.max(srcW, srcH);

  // 既に縮小済みサイズなら、再エンコードのみで済むか判断
  if (longEdge <= MAX_LONG_EDGE_PX && originalBytes < 1.5 * 1024 * 1024) {
    bitmap.close?.();
    return { file, compressed: false, originalBytes, resultBytes: originalBytes };
  }

  const scale = Math.min(1, MAX_LONG_EDGE_PX / longEdge);
  const dstW = Math.round(srcW * scale);
  const dstH = Math.round(srcH * scale);

  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(dstW, dstH)
      : Object.assign(document.createElement("canvas"), { width: dstW, height: dstH });

  const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) {
    bitmap.close?.();
    return { file, compressed: false, originalBytes, resultBytes: originalBytes };
  }
  ctx.drawImage(bitmap, 0, 0, dstW, dstH);
  bitmap.close?.();

  const blob: Blob | null = await (async () => {
    if (canvas instanceof OffscreenCanvas) {
      try {
        return await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
      } catch {
        return null;
      }
    }
    return new Promise<Blob | null>((resolve) =>
      (canvas as HTMLCanvasElement).toBlob(resolve, "image/jpeg", JPEG_QUALITY)
    );
  })();

  if (!blob) {
    return { file, compressed: false, originalBytes, resultBytes: originalBytes };
  }

  // 元の名前を保ちつつ拡張子を .jpg に揃える (Storage で混乱しないよう)
  const baseName = file.name.replace(/\.[^.]+$/, "") || "receipt";
  const outFile = new File([blob], `${baseName}.jpg`, {
    type: "image/jpeg",
    lastModified: Date.now(),
  });

  // 圧縮後の方が大きい (= 元が既に高効率エンコード) なら元を返す
  if (outFile.size >= originalBytes) {
    return { file, compressed: false, originalBytes, resultBytes: originalBytes };
  }

  return {
    file: outFile,
    compressed: true,
    originalBytes,
    resultBytes: outFile.size,
  };
}
