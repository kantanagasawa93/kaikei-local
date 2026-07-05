import type { FixedAsset } from "@/types";

/**
 * 定額法償却率 (平成19年4月1日以後取得の減価償却資産) を ‰ (千分率) の整数で返す。
 * 国税庁の償却率表は「1 / 耐用年数 を小数第3位で切り上げ」した値と一致する
 * (例: 3年→0.334, 6年→0.167, 10年→0.100)。整数で扱うのは浮動小数の丸め事故
 * (0.1 * 1000 === 100.00000000000001) を避けるため。
 */
export function straightLineRateMilli(usefulLifeYears: number): number {
  if (usefulLifeYears <= 0) return 0;
  return Math.ceil(1000 / usefulLifeYears);
}

/** 償却率を小数で返す (e-Tax 減価償却明細の「償却率」欄用)。 */
export function straightLineRate(usefulLifeYears: number): number {
  return straightLineRateMilli(usefulLifeYears) / 1000;
}

/**
 * "YYYY-MM-DD" を年・月に分解する。Date パースだと日付だけの文字列は UTC 解釈に
 * なり実行環境のタイムゾーン次第で月がずれるため、文字列から直接取り出す。
 */
function parseYearMonth(dateStr: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})/.exec(dateStr);
  if (m) return { year: Number(m[1]), month: Number(m[2]) };
  const d = new Date(dateStr);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

/** fiscalYear 中にその資産を事業に使った月数 (取得年は取得月を含む月割り)。 */
export function monthsInService(
  asset: Pick<FixedAsset, "acquisition_date">,
  fiscalYear: number
): number {
  const acq = parseYearMonth(asset.acquisition_date);
  if (fiscalYear < acq.year) return 0;
  return fiscalYear === acq.year ? 13 - acq.month : 12;
}

/**
 * 償却スケジュールを取得年から throughYear まで歩いて、throughYear の償却費と
 * 年末帳簿価額を返す。
 *
 * 税法上のルール:
 *   - 各年の償却費は「取得価額 × 償却率」(取得年は月割り) が限度
 *   - 帳簿価額は備忘価額 1円 (residual_value 指定時はその額) を下回れない
 *   - 端数は円未満切り捨てで継続適用
 * このため年の途中で取得した資産は耐用年数 + 1 年目に残りを償却し切る。
 * (旧実装は耐用年数の最終年に残額を一括計上しており、償却限度額を超えていた)
 */
function walkSchedule(
  asset: FixedAsset,
  throughYear: number
): { depreciation: number; bookValue: number } {
  if (asset.depreciation_method === "none" || !asset.useful_life_years) {
    return { depreciation: 0, bookValue: asset.acquisition_cost };
  }
  const acq = parseYearMonth(asset.acquisition_date);
  if (throughYear < acq.year) {
    return { depreciation: 0, bookValue: asset.acquisition_cost };
  }
  const annualLimit = Math.floor(
    (asset.acquisition_cost * straightLineRateMilli(asset.useful_life_years)) / 1000
  );
  const minBook = Math.max(1, asset.residual_value || 0);
  let book = asset.acquisition_cost;
  let dep = 0;
  for (let y = acq.year; y <= throughYear; y++) {
    const limit =
      y === acq.year ? Math.floor((annualLimit * (13 - acq.month)) / 12) : annualLimit;
    dep = Math.min(limit, Math.max(0, book - minBook));
    book -= dep;
  }
  return { depreciation: dep, bookValue: book };
}

/** 定額法によるその年 1 年分の減価償却費 (事業按分前の全額)。 */
export function straightLineYear(asset: FixedAsset, fiscalYear: number): number {
  return walkSchedule(asset, fiscalYear).depreciation;
}

/** fiscalYear 年末時点の帳簿価額 (未償却残高)。 */
export function bookValueAtYearEnd(asset: FixedAsset, fiscalYear: number): number {
  return walkSchedule(asset, fiscalYear).bookValue;
}
