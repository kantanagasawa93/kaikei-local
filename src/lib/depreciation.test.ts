import { describe, it, expect } from "vitest";
import {
  straightLineRate,
  straightLineRateMilli,
  straightLineYear,
  bookValueAtYearEnd,
  monthsInService,
} from "@/lib/depreciation";
import type { FixedAsset } from "@/types";

function asset(over: Partial<FixedAsset>): FixedAsset {
  return {
    id: "a1",
    user_id: "local-user",
    name: "テスト資産",
    asset_account_code: "163",
    acquisition_date: "2024-01-10",
    acquisition_cost: 200000,
    useful_life_years: 4,
    depreciation_method: "straight_line",
    business_ratio: 100,
    residual_value: 0,
    status: "active",
    disposed_at: null,
    notes: null,
    created_at: "",
    ...over,
  };
}

describe("straightLineRate — 国税庁 定額法償却率表と一致", () => {
  it("代表的な耐用年数の償却率", () => {
    // 別表: 1/n の小数第3位切り上げ
    expect(straightLineRate(2)).toBe(0.5);
    expect(straightLineRate(3)).toBe(0.334);
    expect(straightLineRate(4)).toBe(0.25);
    expect(straightLineRate(5)).toBe(0.2);
    expect(straightLineRate(6)).toBe(0.167); // 普通自動車 (新車)
    expect(straightLineRate(7)).toBe(0.143);
    expect(straightLineRate(8)).toBe(0.125);
    expect(straightLineRate(9)).toBe(0.112);
    expect(straightLineRate(10)).toBe(0.1);
    expect(straightLineRate(15)).toBe(0.067);
    expect(straightLineRate(17)).toBe(0.059);
    expect(straightLineRate(22)).toBe(0.046); // 木造住宅
    expect(straightLineRate(47)).toBe(0.022); // RC 住宅
  });

  it("浮動小数の丸め事故がない (0.1*1000 問題)", () => {
    expect(straightLineRateMilli(10)).toBe(100);
    expect(straightLineRateMilli(8)).toBe(125);
    expect(straightLineRateMilli(20)).toBe(50);
  });
});

describe("straightLineYear — 1月取得 (月割りなし)", () => {
  const pc = asset({}); // 20万 / 4年 / 2024-01

  it("初年〜3年目は取得価額×0.250", () => {
    expect(straightLineYear(pc, 2024)).toBe(50000);
    expect(straightLineYear(pc, 2025)).toBe(50000);
    expect(straightLineYear(pc, 2026)).toBe(50000);
  });

  it("最終年は備忘価額 1円 を残して終わる", () => {
    expect(straightLineYear(pc, 2027)).toBe(49999);
    expect(bookValueAtYearEnd(pc, 2027)).toBe(1);
    expect(straightLineYear(pc, 2028)).toBe(0);
  });

  it("取得前の年は 0 / 帳簿価額は取得価額", () => {
    expect(straightLineYear(pc, 2023)).toBe(0);
    expect(bookValueAtYearEnd(pc, 2023)).toBe(200000);
  });
});

describe("straightLineYear — 年央取得 (月割り + 翌年繰越)", () => {
  // 600万の普通自動車を 2026-06 取得、耐用 6 年 → 償却率 0.167
  const car = asset({
    acquisition_date: "2026-06-15",
    acquisition_cost: 6000000,
    useful_life_years: 6,
    asset_account_code: "162",
  });

  it("取得年は 7/12 月割り", () => {
    // 年間限度 6,000,000×0.167=1,002,000 → ×7/12 = 584,500
    expect(straightLineYear(car, 2026)).toBe(584500);
  });

  it("2年目以降は年間限度額", () => {
    expect(straightLineYear(car, 2027)).toBe(1002000);
    expect(straightLineYear(car, 2031)).toBe(1002000);
  });

  it("耐用年数+1年目に残りを償却して 1円 で終わる (旧実装は最終年一括で限度額超過だった)", () => {
    // 2026: 584,500 + 2027-31: 1,002,000×5 = 5,594,500 → 残 405,500
    expect(straightLineYear(car, 2032)).toBe(405499);
    expect(bookValueAtYearEnd(car, 2032)).toBe(1);
    expect(straightLineYear(car, 2033)).toBe(0);
  });

  it("各年の償却費が年間限度額を超えない", () => {
    for (let y = 2026; y <= 2033; y++) {
      expect(straightLineYear(car, y)).toBeLessThanOrEqual(1002000);
    }
  });
});

describe("straightLineYear — その他", () => {
  it("償却しない資産 (none) は常に 0", () => {
    const land = asset({ depreciation_method: "none", useful_life_years: null });
    expect(straightLineYear(land, 2025)).toBe(0);
    expect(bookValueAtYearEnd(land, 2030)).toBe(200000);
  });

  it("residual_value 指定時はそこで止まる (旧定額法資産の互換)", () => {
    const old = asset({ residual_value: 20000 });
    // 180,000 を 50,000/年で: 50,000×3 + 30,000
    expect(straightLineYear(old, 2026)).toBe(50000);
    expect(straightLineYear(old, 2027)).toBe(30000);
    expect(bookValueAtYearEnd(old, 2027)).toBe(20000);
    expect(straightLineYear(old, 2028)).toBe(0);
  });
});

describe("monthsInService — タイムゾーン非依存の月割り", () => {
  const a = asset({ acquisition_date: "2026-06-15" });
  it("取得年は取得月を含む残月数", () => {
    expect(monthsInService(a, 2026)).toBe(7);
  });
  it("翌年以降は 12、取得前は 0", () => {
    expect(monthsInService(a, 2027)).toBe(12);
    expect(monthsInService(a, 2025)).toBe(0);
  });
  it("1月取得は 12ヶ月 (Date の UTC 解釈で 12月扱いにならない)", () => {
    expect(monthsInService(asset({ acquisition_date: "2026-01-05" }), 2026)).toBe(12);
  });
});
