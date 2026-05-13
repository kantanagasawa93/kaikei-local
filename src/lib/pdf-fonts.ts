/**
 * PDF 生成用の日本語フォント読み込みユーティリティ。
 * Tauri 環境ではリソースディレクトリからフォントを読み、
 * ブラウザ環境では public/ からフェッチする。
 */

import { PDFDocument, PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

let cachedRegular: Uint8Array | null = null;
let cachedBold: Uint8Array | null = null;

async function loadFontBytes(name: string): Promise<Uint8Array> {
  // Tauri 環境: appDataDir 等からは読めないので、
  // Next.js の static export で out/ に含まれる public/fonts/ から fetch する
  // Tauri の webview は tauri://localhost/ をオリジンとするので相対パスで OK
  try {
    const res = await fetch(`/fonts/${name}`);
    if (res.ok) {
      return new Uint8Array(await res.arrayBuffer());
    }
  } catch {}

  // フォールバック: 別パス
  try {
    const res = await fetch(`./fonts/${name}`);
    if (res.ok) {
      return new Uint8Array(await res.arrayBuffer());
    }
  } catch {}

  throw new Error(`Font ${name} not found`);
}

export async function getRegularFont(): Promise<Uint8Array> {
  if (!cachedRegular) {
    cachedRegular = await loadFontBytes("NotoSansJP-Regular.ttf");
  }
  return cachedRegular;
}

export async function getBoldFont(): Promise<Uint8Array> {
  if (!cachedBold) {
    cachedBold = await loadFontBytes("NotoSansJP-Bold.ttf");
  }
  return cachedBold;
}

/**
 * PDFDocument に日本語フォントを登録して返す.
 *
 * 注意: subset: true は pdf-lib + fontkit + Noto Sans JP の組合せで
 * グリフを取りこぼし、英字 lowercase や一部漢字が「ところどころ消える」
 * 壊れた PDF になる事案あり (請求書 PDF #001 で実際に発生)。
 * 安全側に倒して subset: false (フォント丸ごと埋込) にする。
 * 結果: 1 PDF あたり ~10MB 増えるが、確実に読めることを優先。
 */
export async function embedJapaneseFonts(
  pdf: PDFDocument
): Promise<{ regular: PDFFont; bold: PDFFont }> {
  pdf.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await Promise.all([
    getRegularFont(),
    getBoldFont(),
  ]);
  const regular = await pdf.embedFont(regularBytes, { subset: false });
  const bold = await pdf.embedFont(boldBytes, { subset: false });
  return { regular, bold };
}
