import { describe, it, expect } from "vitest";
import {
  calcWithholdingTax,
  calculateTax,
  extractTaxFromIncluded,
  extractTaxFromIncludedLines,
  defaultTaxCodeForAccountCode,
  suggestTaxCodeForAccount,
  getTaxClass,
} from "@/lib/tax-classes";
import { DEFAULT_ACCOUNTS } from "@/lib/accounts";

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

  it("内税の請求書合計: 税区分ごとに合算してから 1 回だけ端数処理", () => {
    // 行ごとに切り捨てると 90 × 3 = 270。正しくは floor(3,000 × 10/110) = 272
    const lines = [
      { amount: 1_000, tax_code: "S10" },
      { amount: 1_000, tax_code: "S10" },
      { amount: 1_000, tax_code: "S10" },
    ];
    expect(extractTaxFromIncludedLines(lines)).toBe(272);
  });

  it("内税の請求書合計: 税率が混在する時は区分ごとに別々に端数処理", () => {
    const lines = [
      { amount: 1_000, tax_code: "S10" }, // floor(2,000 × 10/110) = 181
      { amount: 1_000, tax_code: "S10" },
      { amount: 500, tax_code: "S08R" }, // floor(1,000 × 8/108) = 74
      { amount: 500, tax_code: "S08R" },
      { amount: 3_000, tax_code: "OUT" }, // 0
    ];
    expect(extractTaxFromIncludedLines(lines)).toBe(181 + 74);
  });

  it("税率 0 の区分は常に 0", () => {
    expect(calculateTax(10_000, "OUT")).toBe(0);
    expect(extractTaxFromIncluded(10_000, "NT")).toBe(0);
  });
});

describe("勘定科目 → 既定の税区分", () => {
  const byName = (name: string) => {
    const a = DEFAULT_ACCOUNTS.find((x) => x.name === name);
    if (!a) throw new Error(`科目表に ${name} が無い`);
    return defaultTaxCodeForAccountCode(a.code);
  };

  it("課税仕入になる経費は 課対仕入10%", () => {
    for (const name of ["消耗品費", "旅費交通費", "通信費", "水道光熱費", "外注工賃", "支払手数料", "雑費", "仕入高"]) {
      expect(byName(name), name).toBe("P10");
    }
  });

  it("消費税がかからない経費に仕入税額を立てない (旧実装は 10% を立てていた)", () => {
    expect(byName("租税公課")).toBe("OUT");
    expect(byName("減価償却費")).toBe("OUT");
    expect(byName("給料賃金")).toBe("OUT");
    expect(byName("貸倒金")).toBe("OUT");
    expect(byName("期首商品棚卸高")).toBe("OUT");
    expect(byName("期末商品棚卸高")).toBe("OUT");
    expect(byName("損害保険料")).toBe("EXM");
    expect(byName("利子割引料")).toBe("EXM");
  });

  it("消耗品費が『対象外』にならない (旧実装は科目コード 610 を対象外にしていた)", () => {
    expect(defaultTaxCodeForAccountCode("610")).toBe("P10");
  });

  it("売上高は課税売上10%、資産・負債・資本は対象外", () => {
    expect(byName("売上高")).toBe("S10");
    expect(byName("受取利息")).toBe("EXM");
    for (const name of ["現金", "普通預金", "売掛金", "未払金", "事業主貸", "事業主借", "元入金"]) {
      expect(byName(name), name).toBe("OUT");
    }
  });

  it("科目表に無いコード・空は対象外", () => {
    expect(defaultTaxCodeForAccountCode("999")).toBe("OUT");
    expect(defaultTaxCodeForAccountCode("650")).toBe("OUT");
    expect(defaultTaxCodeForAccountCode("")).toBe("OUT");
    expect(defaultTaxCodeForAccountCode(null)).toBe("OUT");
  });

  it("全ての既定科目が、実在する税区分コードを返す", () => {
    for (const a of DEFAULT_ACCOUNTS) {
      const code = suggestTaxCodeForAccount(a.category, a.code);
      expect(getTaxClass(code), `${a.code} ${a.name} → ${code}`).toBeDefined();
      // 資産・負債・資本に税額を立てない
      if (a.category !== "revenue" && a.category !== "expense") {
        expect(code, `${a.code} ${a.name}`).toBe("OUT");
      }
    }
  });
});
