import { describe, it, expect } from "vitest";
import { fixedAssetsToDepreciationItems } from "@/lib/etax/mapping";
import type { FixedAsset, FixedAssetDepreciation } from "@/types";

const car: FixedAsset = {
  id: "fa-1",
  user_id: "local-user",
  name: "普通自動車",
  asset_account_code: "162",
  acquisition_date: "2026-06-15",
  acquisition_cost: 6000000,
  useful_life_years: 6,
  depreciation_method: "straight_line",
  business_ratio: 80,
  residual_value: 0,
  status: "active",
  disposed_at: null,
  notes: null,
  created_at: "",
};

const depr2026: FixedAssetDepreciation = {
  id: "d-1",
  fixed_asset_id: "fa-1",
  fiscal_year: 2026,
  depreciation_amount: 584500,
  book_value_after: 5415500,
  posted_journal_id: "j-1",
  created_at: "",
};

describe("fixedAssetsToDepreciationItems", () => {
  it("償却率は国税庁の率表、月数は月割り、事業割合は 0-100 のまま", () => {
    const items = fixedAssetsToDepreciationItems([car], [depr2026], 2026);
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0.rate).toBe(0.167); // 1/6 ではなく率表の 0.167
    expect(it0.months).toBe(7); // 6月取得 → 7ヶ月
    expect(it0.business_use_ratio).toBe(80); // 旧実装は 8000 になっていた
    expect(it0.depreciation_year).toBe(584500);
    expect(it0.expense_amount).toBe(467600); // 584,500 × 80%
    expect(it0.book_value_kimatsu).toBe(5415500);
  });

  it("翌年以降は 12ヶ月", () => {
    const items = fixedAssetsToDepreciationItems(
      [car],
      [{ ...depr2026, fiscal_year: 2027, depreciation_amount: 1002000 }],
      2027
    );
    expect(items[0].months).toBe(12);
  });

  it("当年の償却実績が無い資産・active 以外は載せない", () => {
    expect(fixedAssetsToDepreciationItems([car], [], 2026)).toHaveLength(0);
    expect(
      fixedAssetsToDepreciationItems(
        [{ ...car, status: "sold" }],
        [depr2026],
        2026
      )
    ).toHaveLength(0);
  });
});
