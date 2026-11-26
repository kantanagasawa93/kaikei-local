import { describe, it, expect } from "vitest";
import {
  calculateIncomeTax,
  calculateReconstructionTax,
  calculateBasicDeduction,
  calculateTaxableIncome,
  calculateTaxDue,
  calculateMedicalDeduction,
  getBlueReturnDeduction,
  capBlueDeduction,
} from "@/lib/tax-calculator";

describe("calculateIncomeTax — 速算表", () => {
  it("各ブラケットの境界値", () => {
    expect(calculateIncomeTax(1950000)).toBe(97500); // 5%
    expect(calculateIncomeTax(3000000)).toBe(202500); // 10% − 97,500
    expect(calculateIncomeTax(7000000)).toBe(974000); // 23% − 636,000
    expect(calculateIncomeTax(20000000)).toBe(5204000); // 40% − 2,796,000
  });
  it("0 以下は 0", () => {
    expect(calculateIncomeTax(0)).toBe(0);
    expect(calculateIncomeTax(-100)).toBe(0);
  });
});

describe("calculateBasicDeduction — 令和7年度改正", () => {
  it("2024年分まで: 旧テーブル (48万)", () => {
    expect(calculateBasicDeduction(5000000, 2024)).toBe(480000);
    expect(calculateBasicDeduction(24100000, 2024)).toBe(320000);
    expect(calculateBasicDeduction(26000000, 2024)).toBe(0);
  });
  it("2025年分以後: 58万ベース + 低所得帯上乗せ", () => {
    expect(calculateBasicDeduction(1000000, 2025)).toBe(950000);
    expect(calculateBasicDeduction(3000000, 2025)).toBe(880000);
    expect(calculateBasicDeduction(4000000, 2025)).toBe(680000);
    expect(calculateBasicDeduction(5000000, 2025)).toBe(630000);
    expect(calculateBasicDeduction(10000000, 2025)).toBe(580000);
    expect(calculateBasicDeduction(24000000, 2025)).toBe(480000);
  });
  it("令和8・9年分 (2026・2027): 489万円以下 104万 / 655万円以下 67万 / それ以上 62万", () => {
    for (const y of [2026, 2027]) {
      expect(calculateBasicDeduction(1000000, y)).toBe(1040000);
      expect(calculateBasicDeduction(3000000, y)).toBe(1040000);
      expect(calculateBasicDeduction(4890000, y)).toBe(1040000);
      expect(calculateBasicDeduction(4890001, y)).toBe(670000);
      expect(calculateBasicDeduction(6550000, y)).toBe(670000);
      expect(calculateBasicDeduction(6550001, y)).toBe(620000);
      expect(calculateBasicDeduction(23500000, y)).toBe(620000);
      expect(calculateBasicDeduction(23500001, y)).toBe(480000);
      expect(calculateBasicDeduction(24500000, y)).toBe(320000);
      expect(calculateBasicDeduction(25000000, y)).toBe(160000);
      expect(calculateBasicDeduction(25000001, y)).toBe(0);
    }
  });
  it("令和10年分 (2028) 以後: 132万円以下 99万、それ以上は 62万", () => {
    expect(calculateBasicDeduction(1320000, 2028)).toBe(990000);
    expect(calculateBasicDeduction(1320001, 2028)).toBe(620000);
    expect(calculateBasicDeduction(5000000, 2030)).toBe(620000);
    expect(calculateBasicDeduction(23500001, 2028)).toBe(480000);
  });
  it("2025年分の境界値", () => {
    expect(calculateBasicDeduction(1320000, 2025)).toBe(950000);
    expect(calculateBasicDeduction(1320001, 2025)).toBe(880000);
    expect(calculateBasicDeduction(3360001, 2025)).toBe(680000);
    expect(calculateBasicDeduction(4890001, 2025)).toBe(630000);
    expect(calculateBasicDeduction(6550001, 2025)).toBe(580000);
    expect(calculateBasicDeduction(23500001, 2025)).toBe(480000);
  });
});

describe("calculateTaxableIncome", () => {
  it("1000円未満切り捨て", () => {
    const d = {
      basic: 480000,
      social_insurance: 0,
      life_insurance: 0,
      earthquake_insurance: 0,
      spouse: 0,
      dependents: 0,
      medical: 0,
      small_business: 0,
      blue_special: 0,
    };
    expect(calculateTaxableIncome(3000999, 0, d)).toBe(2520000);
  });
  it("控除超過は 0 (負にならない)", () => {
    const d = {
      basic: 480000,
      social_insurance: 0,
      life_insurance: 0,
      earthquake_insurance: 0,
      spouse: 0,
      dependents: 0,
      medical: 0,
      small_business: 0,
      blue_special: 650000,
    };
    expect(calculateTaxableIncome(1000000, 200000, d)).toBe(0);
  });
});

describe("calculateTaxDue — 国税通則法119条の端数処理", () => {
  it("納付は 100円未満切り捨て", () => {
    expect(calculateTaxDue(100000, 2100, 89755)).toBe(12300);
  });
  it("還付は円単位のまま", () => {
    expect(calculateTaxDue(10000, 210, 15642)).toBe(-5432);
  });
});

describe("その他の控除", () => {
  it("復興特別所得税 2.1% 切り捨て", () => {
    expect(calculateReconstructionTax(202500)).toBe(4252);
  });
  it("医療費控除: 所得の5% と 10万円の低い方を差し引く", () => {
    expect(calculateMedicalDeduction(300000, 10000000)).toBe(200000);
    expect(calculateMedicalDeduction(300000, 1000000)).toBe(250000); // 閾値 5万
    expect(calculateMedicalDeduction(40000, 10000000)).toBe(0);
  });
  it("青色申告特別控除", () => {
    expect(getBlueReturnDeduction(true, true)).toBe(650000);
    expect(getBlueReturnDeduction(true, false)).toBe(550000);
    expect(getBlueReturnDeduction(false, true)).toBe(0);
  });
});

describe("capBlueDeduction — 青色申告特別控除は事業の所得を超えて引けない", () => {
  it("黒字が控除額以上ならそのまま", () => {
    expect(capBlueDeduction(650000, 3800000)).toBe(650000);
  });
  it("黒字が控除額より小さければ黒字の額まで", () => {
    expect(capBlueDeduction(650000, 300000)).toBe(300000);
  });
  it("赤字・ゼロなら控除なし", () => {
    expect(capBlueDeduction(650000, 0)).toBe(0);
    expect(capBlueDeduction(650000, -200000)).toBe(0);
  });
});

describe("基礎控除は『青色申告特別控除後』の合計所得金額で判定する", () => {
  it("売上 600万・経費 220万・青色 65万 (2025年分) → 合計所得 315万 → 88万", () => {
    const profit = 6000000 - 2200000;
    const blue = capBlueDeduction(650000, profit);
    // 控除前の 380万で判定すると 68万になり、税額が 20,400 円多く出ていた
    expect(calculateBasicDeduction(profit, 2025)).toBe(680000);
    expect(calculateBasicDeduction(profit - blue, 2025)).toBe(880000);
  });
});
