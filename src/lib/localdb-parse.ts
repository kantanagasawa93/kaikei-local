/**
 * localDb の Supabase 風「ネスト select」columns 文字列のパーサ。
 *
 * 対応形式 (末尾の <word>(...) を子テーブル、それ以前を親カラムとして扱う):
 *   "*, journal_lines(*)"
 *   "id, date, description, journal_lines(partner_id, debit_amount)"
 *
 * Round 30 で localDb.ts から純関数として切り出した。過去に「パーサの
 * regression で全 select が赤トーストになる」事故があったため、ここを
 * 直接 unit テストできる形にしておく。
 */
export interface NestedSelectParts {
  /** 親テーブルの SELECT 列 (明示列リストなら id を必ず含む形に正規化済み) */
  parentCols: string;
  childTable: string;
  /** 子テーブルの SELECT 列 (明示列リストなら FK 列を必ず含む形に正規化済み) */
  childCols: string;
  /** 親テーブル名の単数形 + "_id" と推定した FK 列名 (journals → journal_id) */
  fkCol: string;
}

export function parseNestedSelect(
  columns: string,
  parentTable: string
): NestedSelectParts | null {
  const m = columns.match(/^(.+?)\s*,\s*(\w+)\s*\(([^()]+)\)\s*$/);
  if (!m) return null;
  let parentCols = m[1].trim() || "*";
  const childTable = m[2];
  let childCols = m[3].trim();
  const fkCol = parentTable.replace(/s$/, "") + "_id";
  // 親→子のマッピングに親 id が要るので、明示列リストの時は id を必ず含める
  if (parentCols !== "*" && !/(^|,)\s*id\s*(,|$)/i.test(parentCols)) {
    parentCols = `id, ${parentCols}`;
  }
  // 子→親の対応付けに FK 列が要るので、明示列リストの時は FK を必ず含める
  if (
    childCols !== "*" &&
    !new RegExp(`(^|,)\\s*${fkCol}\\s*(,|$)`, "i").test(childCols)
  ) {
    childCols = `${fkCol}, ${childCols}`;
  }
  return { parentCols, childTable, childCols, fkCol };
}
