/**
 * PDF 生成用の日本語フォント読み込みユーティリティ。
 * Tauri 環境ではリソースディレクトリからフォントを読み、
 * ブラウザ環境では public/ からフェッチする。
 */

import { PDFDocument, PDFFont, StandardFonts } from "pdf-lib";
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
 * PDFDocument に「日本語用」と「ASCII 用」の両方のフォントを登録して返す.
 *
 * なぜ 2 系統か:
 *   Noto Sans JP は半角数字・英字も「全角幅 (= 1em)」で設計されているため、
 *   `Subtotal 110,000 JPY` を Noto Sans JP で描くと数字 1 つ 1 つに大きな
 *   advance が乗って `1 1 0 ,0 0 0` のように間延びする (PDF #26 で発生)。
 *   そのため:
 *     - ASCII のみの文字列 → pdf-lib の StandardFonts.Helvetica で proportional に
 *     - 日本語を含む文字列 → Noto Sans JP (CID フォントとして CMap が必要)
 *   呼び出し側 (invoice-pdf.ts) で文字列に非 ASCII が含まれるかで使い分ける。
 *
 * subset: false にしているのは、subset: true だと一部グリフを取りこぼして
 * 壊れた PDF を吐く既知バグがあるため (PDF #001 で発生)。
 * 結果として 1 PDF あたり ~10MB 増えるが、確実に読めることを優先。
 */
export async function embedJapaneseFonts(
  pdf: PDFDocument
): Promise<{
  regular: PDFFont;
  bold: PDFFont;
  asciiRegular: PDFFont;
  asciiBold: PDFFont;
}> {
  pdf.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await Promise.all([
    getRegularFont(),
    getBoldFont(),
  ]);
  const regular = await pdf.embedFont(regularBytes, { subset: false });
  const bold = await pdf.embedFont(boldBytes, { subset: false });
  // ASCII 用 (proportional な数字 / 英字)。pdf-lib 標準で埋込不要 (Type1 base font)。
  const asciiRegular = await pdf.embedFont(StandardFonts.Helvetica);
  const asciiBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  return { regular, bold, asciiRegular, asciiBold };
}

/** 文字列に非 ASCII (日本語等) が含まれるかどうか. */
export function containsNonAscii(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(s);
}
