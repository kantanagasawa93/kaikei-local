import type { FixedAsset } from "@/types";

/**
 * 定額法による減価償却費を計算
 * 年次ベース（月割りは簡略化して1年未満は按分）
 */
export function straightLineYear(asset: FixedAsset, fiscalYear: number): number {
  if (asset.depreciation_method === "none" || !asset.useful_life_years) return 0;
  const acquired = new Date(asset.acquisition_date);
  const acqYear = acquired.getFullYear();
  if (fiscalYear < acqYear) return 0;

  const annualDepreciation = Math.floor(
    (asset.acquisition_cost - asset.residual_value) / asset.useful_life_years
  );

  const lastYear = acqYear + asset.useful_life_years - 1;
  if (fiscalYear > lastYear) return 0;

  // 取得年は月割り
  if (fiscalYear === acqYear) {
    const monthsLeft = 12 - acquired.getMonth(); // 取得月含む
    return Math.floor((annualDepreciation * monthsLeft) / 12);
  }
  // 最終年は残額
  if (fiscalYear === lastYear) {
    const accumulatedBefore =
      annualDepreciation * (asset.useful_life_years - 1);
    // 取得年に月割りした分を差し引く
    const acqYearMonths = 12 - acquired.getMonth();
    const acqYearDep = Math.floor((annualDepreciation * acqYearMonths) / 12);
    const remaining =
      asset.acquisition_cost - asset.residual_value - (accumulatedBefore - (annualDepreciation - acqYearDep));
    return Math.max(0, remaining);
  }
  return annualDepreciation;
}

export function bookValueAtYearEnd(asset: FixedAsset, fiscalYear: number): number {
  let accumulated = 0;
  const acqYear = new Date(asset.acquisition_date).getFullYear();
  for (let y = acqYear; y <= fiscalYear; y++) {
    accumulated += straightLineYear(asset, y);
  }
  return Math.max(asset.residual_value, asset.acquisition_cost - accumulated);
}
