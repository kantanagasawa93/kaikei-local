import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installTestDb, type TestDb } from "@/test-stubs/test-db";
import { commitParsedJournals, normalizeTaxCode } from "@/lib/journal-commit";
import type { ParsedJournal } from "@/lib/journal-import";

function journal(
  date: string,
  description: string,
  lines: [name: string, debit: number, credit: number, tax?: string | null][],
): ParsedJournal {
  return {
    external_id: null,
    date,
    description,
    raw_source: "freee",
    lines: lines.map(([account_name, debit_amount, credit_amount, tax_code]) => ({
      account_code: null,
      account_name,
      debit_amount,
      credit_amount,
      tax_code: tax_code ?? null,
      tax_amount: 0,
      sub_account: null,
      department: null,
      partner: null,
      memo: null,
    })),
  };
}

describe("normalizeTaxCode — 他ソフトの税区分名 → tax_classes.code", () => {
  it("正式コードはそのまま", () => {
    for (const c of ["OUT", "NT", "EXM", "EXP", "S10", "S08R", "S08", "P10", "P08R", "P08"]) {
      expect(normalizeTaxCode(c)).toBe(c);
    }
  });

  it("軽減税率の『売上』を仕入コードにしない (旧実装は P08R になっていた)", () => {
    expect(normalizeTaxCode("課税売上8%（軽）")).toBe("S08R");
    expect(normalizeTaxCode("課税売上8%(軽)")).toBe("S08R");
    expect(normalizeTaxCode("課税売上内軽減8%")).toBe("S08R");
    expect(normalizeTaxCode("課売 (軽)8%")).toBe("S08R");
  });

  it("売上 / 仕入 × 10% / 8% / 軽減 を取り違えない", () => {
    expect(normalizeTaxCode("課税売上10%")).toBe("S10");
    expect(normalizeTaxCode("課税売上内10%")).toBe("S10");
    expect(normalizeTaxCode("課売 10%")).toBe("S10");
    expect(normalizeTaxCode("課税売上8%")).toBe("S08");
    expect(normalizeTaxCode("課対仕入10%")).toBe("P10");
    expect(normalizeTaxCode("課対仕入内10%")).toBe("P10");
    expect(normalizeTaxCode("課仕 10%")).toBe("P10");
    expect(normalizeTaxCode("課対仕入8%")).toBe("P08");
    expect(normalizeTaxCode("課対仕入8%（軽）")).toBe("P08R");
    expect(normalizeTaxCode("課仕 (軽)8%")).toBe("P08R");
  });

  it("経過措置の『控80』が付いても税率を読み違えない", () => {
    expect(normalizeTaxCode("課対仕入10%控80")).toBe("P10");
    expect(normalizeTaxCode("課対仕入8%（軽）控80")).toBe("P08R");
  });

  it("対象外 / 不課税 / 非課税 / 輸出", () => {
    expect(normalizeTaxCode("対象外")).toBe("OUT");
    expect(normalizeTaxCode("不課税")).toBe("NT");
    expect(normalizeTaxCode("非課税")).toBe("EXM");
    expect(normalizeTaxCode("非課売上")).toBe("EXM");
    expect(normalizeTaxCode("輸出売上")).toBe("EXP");
  });

  it("判定できないものは null (FK 違反を避ける)", () => {
    expect(normalizeTaxCode("")).toBeNull();
    expect(normalizeTaxCode(null)).toBeNull();
    expect(normalizeTaxCode("よくわからない区分")).toBeNull();
    expect(normalizeTaxCode("課税売上")).toBeNull(); // 税率不明
  });
});

describe("commitParsedJournals — 他ソフトからの仕訳取込", () => {
  let t: TestDb;
  beforeEach(() => {
    t = installTestDb();
  });
  afterEach(() => t.close());

  it("新規インストール (accounts テーブルが空) でも既定の科目に解決できる", async () => {
    const res = await commitParsedJournals([
      journal("2025-04-01", "電車代", [
        ["旅費交通費", 220, 0, "課対仕入10%"],
        ["現金", 0, 220, "対象外"],
      ]),
    ]);
    expect(res.inserted).toBe(1);
    expect(res.unknownAccounts).toEqual([]);
    const lines = t.all<{ account_code: string; account_name: string; tax_code: string }>(
      "SELECT account_code, account_name, tax_code FROM journal_lines ORDER BY debit_amount DESC",
    );
    expect(lines).toEqual([
      { account_code: "604", account_name: "旅費交通費", tax_code: "P10" },
      { account_code: "100", account_name: "現金", tax_code: "OUT" },
    ]);
  });

  it("別名 (交際費 / 外注費) は既定の科目に寄せ、口座名などは未分類として報告する", async () => {
    const res = await commitParsedJournals([
      journal("2025-05-10", "会食", [
        ["交際費", 8800, 0],
        ["三井住友MASTERカード", 0, 8800],
      ]),
      journal("2025-05-11", "デザイン", [
        ["外注費", 30000, 0],
        ["普通預金", 0, 30000],
      ]),
    ]);
    expect(res.inserted).toBe(2);
    expect(res.unknownAccounts).toEqual(["三井住友MASTERカード"]);
    expect(res.warnings.join("\n")).toContain("三井住友MASTERカード");
    const byName = Object.fromEntries(
      t
        .all<{ account_code: string; account_name: string }>(
          "SELECT account_code, account_name FROM journal_lines",
        )
        .map((l) => [l.account_name, l.account_code]),
    );
    expect(byName["接待交際費"]).toBe("607");
    expect(byName["外注工賃"]).toBe("614");
    expect(byName["普通預金"]).toBe("110");
    // 判断できない名前は元の名前を残したまま未分類コードにする (後から割り当て直せる)
    expect(byName["三井住友MASTERカード"]).toBe("999");
  });

  it("DB の accounts テーブルにあるユーザ定義科目も解決できる", async () => {
    t.raw.exec(
      "INSERT INTO accounts (code, name, category) VALUES ('A900', '支払報酬料', 'expense')",
    );
    const res = await commitParsedJournals([
      journal("2025-06-01", "税理士", [
        ["支払報酬料", 55000, 0],
        ["普通預金", 0, 55000],
      ]),
    ]);
    expect(res.unknownAccounts).toEqual([]);
    expect(
      t.scalar<string>("SELECT account_code FROM journal_lines WHERE account_name='支払報酬料'"),
    ).toBe("A900");
  });

  it("同じ日・同じ摘要で金額が違う仕訳を『重複』として捨てない", async () => {
    const res = await commitParsedJournals(
      [
        journal("2025-07-01", "電車代", [["旅費交通費", 220, 0], ["現金", 0, 220]]),
        journal("2025-07-01", "電車代", [["旅費交通費", 480, 0], ["現金", 0, 480]]),
      ],
      { dedupe: true },
    );
    expect(res.inserted).toBe(2);
    expect(res.skipped).toBe(0);
    expect(t.scalar("SELECT COUNT(*) FROM journals")).toBe(2);
  });

  it("同じファイル内の全く同じ仕訳 2 件は両方取り込み、再取込では両方スキップする", async () => {
    const file = [
      journal("2025-07-02", "コーヒー", [["会議費", 500, 0], ["現金", 0, 500]]),
      journal("2025-07-02", "コーヒー", [["会議費", 500, 0], ["現金", 0, 500]]),
    ];
    const first = await commitParsedJournals(file, { dedupe: true });
    expect(first.inserted).toBe(2);

    const second = await commitParsedJournals(file, { dedupe: true });
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
    expect(t.scalar("SELECT COUNT(*) FROM journals")).toBe(2);
  });

  it("摘要が空の仕訳も再取込で二重に入らない", async () => {
    const file = [journal("2025-08-01", "", [["消耗品費", 1100, 0], ["現金", 0, 1100]])];
    await commitParsedJournals(file, { dedupe: true });
    const again = await commitParsedJournals(file, { dedupe: true });
    expect(again.inserted).toBe(0);
    expect(again.skipped).toBe(1);
    expect(t.scalar("SELECT COUNT(*) FROM journals")).toBe(1);
  });

  it("一部だけ既に入っているファイルは、足りない分だけ取り込む", async () => {
    const a = journal("2025-09-01", "家賃", [["地代家賃", 80000, 0], ["普通預金", 0, 80000]]);
    const b = journal("2025-09-05", "通信", [["通信費", 5500, 0], ["普通預金", 0, 5500]]);
    await commitParsedJournals([a], { dedupe: true });
    const res = await commitParsedJournals([a, b], { dedupe: true });
    expect(res.inserted).toBe(1);
    expect(res.skipped).toBe(1);
    expect(t.scalar("SELECT COUNT(*) FROM journals")).toBe(2);
  });

  it("貸借不一致は警告に出る (取り込み自体はする)", async () => {
    const res = await commitParsedJournals([
      journal("2025-10-01", "ずれ", [["消耗品費", 1000, 0], ["現金", 0, 900]]),
    ]);
    expect(res.inserted).toBe(1);
    expect(res.warnings.some((w) => w.includes("貸借不一致"))).toBe(true);
  });
});
