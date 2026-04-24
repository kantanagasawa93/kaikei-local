/**
 * e-Tax で使うコード・列挙値をまとめる。
 *
 * 税務署コードは膨大 (全国 500 以上) あるので、
 * 実データは別途 e-tax07 (手続一覧) や国税庁の公開 CSV から取り込む。
 * ここでは型定義とユーティリティを用意する。
 */

import type { EraName, WarekiDate } from "./types";

/**
 * 暦年 → 令和 年 変換。
 *   2019 → {era:"令和", yy:1}
 *   2025 → {era:"令和", yy:7}
 *
 * 2019年5月1日から令和開始だが、e-Tax では年単位で扱うため
 * 2019 = 令和1 として扱う。
 */
export function yearToWareki(ce: number): { era: EraName; yy: number } {
  if (ce >= 2019) return { era: "令和", yy: ce - 2018 };
  if (ce >= 1989) return { era: "平成", yy: ce - 1988 };
  if (ce >= 1926) return { era: "昭和", yy: ce - 1925 };
  if (ce >= 1912) return { era: "大正", yy: ce - 1911 };
  return { era: "明治", yy: ce - 1867 };
}

/**
 * YYYY-MM-DD → WarekiDate 変換。
 */
export function isoToWareki(iso: string): WarekiDate {
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  const { era, yy } = yearToWareki(y);
  return { era, yy, mm: m, dd: d };
}

/**
 * 数値を日本語形式の金額文字列 (カンマ区切り) に。プレビュー用。
 */
export function formatYen(amount: number): string {
  return amount.toLocaleString("ja-JP");
}

/**
 * 和暦を「令和7年1月1日」形式に。プレビュー用。
 */
export function formatWareki(d: WarekiDate): string {
  return `${d.era}${d.yy}年${d.mm}月${d.dd}日`;
}

/**
 * 手続 ID 一覧。XTX のルート要素 (DATA の子) 名として使う。
 *
 * 注意: 所得税関係は「申告書」「青色決算書」等の帳票が別々ではなく、
 * RKO0010 (所得税及び復興特別所得税申告) という1つの手続の中に
 * KOA020 (申告書) / KOA210 (青色決算書) / KOA140 (収支内訳書) 等が
 * 兄弟要素として入る。
 *
 * 消費税は RSH0010 (一般) と RSH0030 (簡易) が別手続き。
 */
export const PROCEDURE_CODES = {
  /** 所得税及び復興特別所得税申告 (確定申告書・青色申告決算書を包含する大枠) */
  SHOTOKU_SHINKOKU: "RKO0010",
  /** 消費税及び地方消費税申告 (一般・個人) */
  SHOHI_KOJIN_IPPAN: "RSH0010",
  /** 消費税及び地方消費税申告 (簡易課税・個人) */
  SHOHI_KOJIN_KANI: "RSH0030",
} as const;

export type ProcedureCode = (typeof PROCEDURE_CODES)[keyof typeof PROCEDURE_CODES];

/**
 * 令和7年分 (2025年分) で使う帳票バージョン。
 *
 * 手続:
 *   - RKO0010: 25.0.0 (2025-08-15) 所得税申告 手続ID wrapper (令和7年分)
 *   - RSH0010: 23.2.0 (2023-11-27) 消費税 (一般・個人) ※令和7年分未公開、最新流用
 *   - RSH0030: 23.2.0 (2023-11-27) 消費税 (簡易・個人) ※同上
 *
 * 内包帳票:
 *   - KOA020: 23.0 (2025-08-15) 申告書第一表・第二表 (令和7年分)
 *   - KOA210: 11.0 (2023-09-27) 青色申告決算書 (一般用) ※安定版
 */
export const FORM_VERSIONS = {
  [PROCEDURE_CODES.SHOTOKU_SHINKOKU]: "25.0.0",
  [PROCEDURE_CODES.SHOHI_KOJIN_IPPAN]: "23.2.0",
  [PROCEDURE_CODES.SHOHI_KOJIN_KANI]: "23.2.0",
} as const;

/**
 * 帳票個別部分のバージョン (RKO0010 内に埋め込むサブ帳票用)
 */
export const EMBEDDED_FORM_VERSIONS = {
  KOA020: "23.0",
  KOA210: "11.0",
} as const;

/**
 * XTX 名前空間 URI。
 */
export const NAMESPACES = {
  general: "http://xml.e-tax.nta.go.jp/XSD/general",
  shotoku: "http://xml.e-tax.nta.go.jp/XSD/shotoku",
  shohi: "http://xml.e-tax.nta.go.jp/XSD/shohi",
  kyotsu: "http://xml.e-tax.nta.go.jp/XSD/kyotsu",
  somu: "http://xml.e-tax.nta.go.jp/XSD/somu",
  dsig: "http://www.w3.org/2000/09/xmldsig#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
} as const;

/**
 * softNM 属性値を構築。仕様上は "ソフト名△会社名" で △ は半角スペース。
 */
export function buildSoftNM(softName: string, vendor: string): string {
  return `${softName} ${vendor}`;
}

/**
 * 推奨ファイル名を生成。e-Tax Web版でアップロードしやすい形式。
 *   KOA020_令和7年分_20260220.xtx
 */
export function buildXtxFileName(
  procedureCode: string,
  fiscalYear: number,
  sakuseiDay: string
): string {
  const wy = yearToWareki(fiscalYear);
  const d = sakuseiDay.replace(/-/g, "");
  return `${procedureCode}_${wy.era}${wy.yy}年分_${d}.xtx`;
}
