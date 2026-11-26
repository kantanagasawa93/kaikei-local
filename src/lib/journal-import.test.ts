import { describe, it, expect } from "vitest";
import { parseJournalFile } from "@/lib/journal-import";

function csvFile(lines: string[]): File {
  return new File([lines.join("\r\n")], "journals.csv", { type: "text/csv" });
}

const MF_HEADER =
  "取引No,取引日,借方勘定科目,借方補助科目,借方部門,借方取引先,借方税区分,借方金額(円),借方税額,貸方勘定科目,貸方補助科目,貸方部門,貸方取引先,貸方税区分,貸方金額(円),貸方税額,摘要";

describe("仕訳 CSV 取込 — 伝票の束ね方", () => {
  it("同じ取引No・同じ日付の行は 1 つの複合仕訳にまとめる", async () => {
    const res = await parseJournalFile(
      csvFile([
        MF_HEADER,
        "1,2025/01/10,消耗品費,,,,課税仕入 10%,1100,100,現金,,,,対象外,1100,0,文具",
        "1,2025/01/10,通信費,,,,課税仕入 10%,2200,200,現金,,,,対象外,2200,0,切手",
      ]),
    );
    expect(res.errors).toEqual([]);
    expect(res.journals).toHaveLength(1);
    expect(res.journals[0].lines).toHaveLength(4);
  });

  it("番号が月ごとに振り直される CSV でも、別の日付の仕訳を上書きして消さない", async () => {
    const res = await parseJournalFile(
      csvFile([
        MF_HEADER,
        "1,2025/01/10,消耗品費,,,,課税仕入 10%,1100,100,現金,,,,対象外,1100,0,1月の文具",
        "2,2025/01/20,通信費,,,,課税仕入 10%,2200,200,現金,,,,対象外,2200,0,1月の切手",
        "1,2025/02/05,旅費交通費,,,,課税仕入 10%,3300,300,現金,,,,対象外,3300,0,2月の電車",
        "2,2025/02/15,会議費,,,,課税仕入 10%,4400,400,現金,,,,対象外,4400,0,2月の会議",
      ]),
    );
    expect(res.errors).toEqual([]);
    // 以前は「取引No」だけをキーにしていたため、2 月の行が 1 月の仕訳を上書きして 2 件に減っていた
    expect(res.journals.map((j) => `${j.date} ${j.description}`)).toEqual([
      "2025-01-10 1月の文具",
      "2025-01-20 1月の切手",
      "2025-02-05 2月の電車",
      "2025-02-15 2月の会議",
    ]);
    const total = res.journals.reduce(
      (s, j) => s + j.lines.reduce((x, l) => x + l.debit_amount, 0),
      0,
    );
    expect(total).toBe(1100 + 2200 + 3300 + 4400);
  });
});
