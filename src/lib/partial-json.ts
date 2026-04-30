/**
 * Claude OCR のストリーミング応答から、完了済みフィールドを早期に取り出す。
 *
 * Claude は最終的に下記のような JSON を返すが、ストリーミング中はテキストが
 * 文字単位で流れてくる:
 *
 *   {
 *     "vendor_name": "セブンイレブン",
 *     "amount": 432,
 *     "date": "2026-04-30",
 *     ...
 *   }
 *
 * 完全な JSON パーサを書くのはオーバキル。各フィールドの「閉じ」が
 * 検出できる時点で抽出すれば十分なので、正規表現で済ませる。
 *
 * 部分的に取れたフィールドだけを返し、未確定のフィールドは undefined にする。
 * UI 側はフィールドが届く度に setState すればよい。
 */

export interface PartialOcrFields {
  vendor_name?: string;
  amount?: number | null;
  date?: string;
}

/**
 * 蓄積されたテキストから、完了済みのフィールド値を抽出する。
 * 同じテキストに対して複数回呼ばれても結果は idempotent。
 */
export function extractOcrFields(accumulated: string): PartialOcrFields {
  const out: PartialOcrFields = {};

  // vendor_name: JSON 文字列として完了済み (閉じ " を持つ)
  // (?:[^"\\]|\\.)* で escape された " を内側に許容
  const vm = accumulated.match(/"vendor_name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (vm) {
    try {
      out.vendor_name = JSON.parse(`"${vm[1]}"`);
    } catch {
      out.vendor_name = vm[1];
    }
  }

  // amount: 数値 + 区切り文字 (, } 改行) または null
  const aNull = accumulated.match(/"amount"\s*:\s*null\s*[,}\n]/);
  if (aNull) {
    out.amount = null;
  } else {
    const am = accumulated.match(/"amount"\s*:\s*(\d+)\s*[,}\n]/);
    if (am) out.amount = Number(am[1]);
  }

  // date: YYYY-MM-DD 形式 (閉じ " 必須)
  const dm = accumulated.match(/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/);
  if (dm) out.date = dm[1];

  return out;
}
