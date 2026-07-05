import { describe, it, expect } from "vitest";
import {
  calculateIncomeTax,
  calculateReconstructionTax,
  calculateBasicDeduction,
  calculateTaxableIncome,
  calculateTaxDue,
  calculateMedicalDeduction,
  getBlueReturnDeduction,
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
  it("令和7・8年分限定の中間帯上乗せは 2027 年分から消える", () => {
    expect(calculateBasicDeduction(3000000, 2026)).toBe(880000);
    expect(calculateBasicDeduction(3000000, 2027)).toBe(580000);
    expect(calculateBasicDeduction(1000000, 2027)).toBe(950000); // 95万は恒久
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
