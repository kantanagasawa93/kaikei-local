import { describe, it, expect } from "vitest";
import { parseNestedSelect } from "@/lib/localdb-parse";

// 現行コードベースで実際に使われている 4 パターン + 境界ケース。
// このパーサが壊れると全ページの select が赤トーストになる (過去事故) ので
// 回帰テストとして固定する。
describe("parseNestedSelect", () => {
  it('"*, journal_lines(*)" — 全列 + 子全列', () => {
    const p = parseNestedSelect("*, journal_lines(*)", "journals");
    expect(p).toEqual({
      parentCols: "*",
      childTable: "journal_lines",
      childCols: "*",
      fkCol: "journal_id",
    });
  });

  it('明示列リスト — 親に id、子に FK が自動補完される', () => {
    const p = parseNestedSelect(
      "date, description, journal_lines(partner_id, debit_amount)",
      "journals"
    );
    expect(p).toEqual({
      parentCols: "id, date, description",
      childTable: "journal_lines",
      childCols: "journal_id, partner_id, debit_amount",
      fkCol: "journal_id",
    });
  });

  it("親列に id が既にあれば二重に足さない", () => {
    const p = parseNestedSelect("id, date, journal_lines(*)", "journals");
    expect(p?.parentCols).toBe("id, date");
  });

  it("子列に FK が既にあれば二重に足さない", () => {
    const p = parseNestedSelect(
      "*, journal_lines(journal_id, account_code)",
      "journals"
    );
    expect(p?.childCols).toBe("journal_id, account_code");
  });

  it("FK は親テーブル名の単数形 + _id (receipts → receipt_id)", () => {
    const p = parseNestedSelect("*, receipt_items(*)", "receipts");
    expect(p?.fkCol).toBe("receipt_id");
  });

  it("ネストでない columns は null", () => {
    expect(parseNestedSelect("*", "journals")).toBeNull();
    expect(parseNestedSelect("id, date, description", "journals")).toBeNull();
    expect(parseNestedSelect("id", "journals")).toBeNull();
  });
});
