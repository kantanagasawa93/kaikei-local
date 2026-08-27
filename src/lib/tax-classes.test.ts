import { describe, it, expect } from "vitest";
import {
  calcWithholdingTax,
  calculateTax,
  extractTaxFromIncluded,
} from "@/lib/tax-classes";

describe("calcWithholdingTax (報酬の源泉徴収: 10.21% / 100万円超は 20.42%)", () => {
  it("0 円・マイナスは 0", () => {
    expect(calcWithholdingTax(0)).toBe(0);
    expect(calcWithholdingTax(-100)).toBe(0);
  });

  it("100万円以下は 10.21% の切り捨て", () => {
    expect(calcWithholdingTax(100_000)).toBe(10_210);
    expect(calcWithholdingTax(333_333)).toBe(Math.floor(333_333 * 0.1021)); // 34,033
    expect(calcWithholdingTax(1_000_000)).toBe(102_100);
  });

  it("100万円超は 102,100 + 超過分 × 20.42%", () => {
    // 国税庁の設例: 150万円の報酬 → 102,100 + 500,000 × 20.42% = 204,200
    expect(calcWithholdingTax(1_500_000)).toBe(204_200);
    expect(calcWithholdingTax(1_000_001)).toBe(102_100); // 超過 1 円 × 20.42% は切り捨てで 0
    expect(calcWithholdingTax(2_000_000)).toBe(306_300);
  });
});

describe("内税/外税の消費税計算 (invoices の税込入力で使用)", () => {
  it("外税: 税抜 10,000 円 × 10% = 1,000 円", () => {
    expect(calculateTax(10_000, "S10")).toBe(1_000);
  });

  it("内税: 税込 11,000 円 → 消費税 1,000 円 (10/110 逆算)", () => {
    expect(extractTaxFromIncluded(11_000, "S10")).toBe(1_000);
  });

  it("内税: 軽減税率 税込 10,800 円 → 消費税 800 円 (8/108 逆算)", () => {
    expect(extractTaxFromIncluded(10_800, "S08R")).toBe(800);
  });

  it("税率 0 の区分は常に 0", () => {
    expect(calculateTax(10_000, "OUT")).toBe(0);
    expect(extractTaxFromIncluded(10_000, "NT")).toBe(0);
  });
});
