import { describe, it, expect } from "vitest";
import {
  shiftYear,
  buildMonthlySummaryCsv,
  type MonthlySummaryRow,
} from "@/lib/journal-export";

describe("shiftYear", () => {
  it("年だけずらす", () => {
    expect(shiftYear("2026-03-01", -1)).toBe("2025-03-01");
    expect(shiftYear("2026-12-31", 2)).toBe("2028-12-31");
  });
  it("形式不正はそのまま返す", () => {
    expect(shiftYear("2026/03/01", -1)).toBe("2026/03/01");
    expect(shiftYear("", -1)).toBe("");
  });
});

describe("buildMonthlySummaryCsv", () => {
  const rows: MonthlySummaryRow[] = [
    { month: "01", income: 100000, expense: 40000, diff: 60000 },
    { month: "02", income: 0, expense: 15000, diff: -15000 },
  ];

  it("UTF-8 BOM + CRLF + 合計行", () => {
    const csv = buildMonthlySummaryCsv(2026, rows);
    expect(csv.charCodeAt(0)).toBe(0xfeff); // BOM
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe("月,売上,経費,差引");
    expect(lines[1]).toBe("2026-01,100000,40000,60000");
    expect(lines[2]).toBe("2026-02,0,15000,-15000");
    expect(lines[3]).toBe("合計,100000,55000,45000");
  });
});
