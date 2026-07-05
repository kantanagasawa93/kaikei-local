import { describe, it, expect } from "vitest";
import { buildMonthlyMatrix, subtotalByCategory, type ReportLine } from "@/lib/reports";

const line = (over: Partial<ReportLine>): ReportLine => ({
  account_code: "601",
  account_name: null,
  debit_amount: 0,
  credit_amount: 0,
  date: "2026-03-15",
  ...over,
});

describe("buildMonthlyMatrix — PL", () => {
  it("収益は貸方プラス、費用は借方プラスで月に積む", () => {
    const rows = buildMonthlyMatrix(
      [
        line({ account_code: "401", credit_amount: 100000, date: "2026-03-15" }),
        line({ account_code: "601", debit_amount: 30000, date: "2026-03-15" }),
        line({ account_code: "601", debit_amount: 20000, date: "2026-05-10" }),
      ],
      2026,
      "pl"
    );
    const rev = rows.find((r) => r.code === "401")!;
    const exp = rows.find((r) => r.code === "601")!;
    expect(rev.months[3]).toBe(100000);
    expect(rev.total).toBe(100000);
    expect(exp.months[3]).toBe(30000);
    expect(exp.months[5]).toBe(20000);
    expect(exp.total).toBe(50000);
  });

  it("対象年以外の行と BS 科目は含めない", () => {
    const rows = buildMonthlyMatrix(
      [
        line({ account_code: "401", credit_amount: 999, date: "2025-03-15" }),
        line({ account_code: "111", debit_amount: 999, date: "2026-03-15" }),
      ],
      2026,
      "pl"
    );
    expect(rows.find((r) => r.code === "401")?.total ?? 0).toBe(0);
    expect(rows.find((r) => r.code === "111")).toBeUndefined();
  });
});

describe("buildMonthlyMatrix — BS", () => {
  it("前年以前は期首残高 (months[0]) に積み、当年分を累積残高に変換", () => {
    const rows = buildMonthlyMatrix(
      [
        line({ account_code: "111", debit_amount: 500000, date: "2025-11-01" }),
        line({ account_code: "111", debit_amount: 100000, date: "2026-02-10" }),
        line({ account_code: "111", credit_amount: 30000, date: "2026-04-05" }),
      ],
      2026,
      "bs"
    );
    const cash = rows.find((r) => r.code === "111")!;
    expect(cash.months[0]).toBe(500000); // 期首
    expect(cash.months[1]).toBe(500000);
    expect(cash.months[2]).toBe(600000);
    expect(cash.months[4]).toBe(570000);
    expect(cash.months[12]).toBe(570000);
    expect(cash.total).toBe(570000);
  });
});

describe("subtotalByCategory", () => {
  it("カテゴリ別に月列を合算する", () => {
    const rows = buildMonthlyMatrix(
      [
        line({ account_code: "601", debit_amount: 1000, date: "2026-01-15" }),
        line({ account_code: "611", debit_amount: 2000, date: "2026-01-20" }),
      ],
      2026,
      "pl"
    );
    const sub = subtotalByCategory(rows);
    expect(sub.expense[1]).toBe(3000);
  });
});
