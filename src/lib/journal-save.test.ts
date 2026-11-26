import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installTestDb, type TestDb } from "@/test-stubs/test-db";
import {
  createJournal,
  replaceJournal,
  validateJournalLines,
  type JournalLineDraft,
} from "@/lib/journal-save";

const line = (
  code: string,
  name: string,
  debit: number,
  credit: number,
  extra: Partial<JournalLineDraft> = {},
): JournalLineDraft => ({
  account_code: code,
  account_name: name,
  debit_amount: debit,
  credit_amount: credit,
  tax_code: "OUT",
  tax_amount: 0,
  partner_id: null,
  memo: null,
  ...extra,
});
const blank = () => line("", "", 0, 0);

describe("validateJournalLines — 保存できない理由", () => {
  it("正しい仕訳は null (空行は無視する)", () => {
    expect(
      validateJournalLines([line("610", "消耗品費", 1100, 0), line("100", "現金", 0, 1100), blank()]),
    ).toBeNull();
  });

  it("金額が未入力", () => {
    expect(validateJournalLines([blank(), blank()])).toMatch(/金額が未入力/);
  });

  it("貸借不一致は差額を示す", () => {
    expect(
      validateJournalLines([line("610", "消耗品費", 1100, 0), line("100", "現金", 0, 1000)]),
    ).toMatch(/差額 100円/);
  });

  it("科目の無い行は保存させない (どの集計にも出ない明細になる)", () => {
    expect(
      validateJournalLines([line("", "", 1100, 0), line("100", "現金", 0, 1100)]),
    ).toMatch(/1 行目: 勘定科目/);
  });

  it("借方と貸方の両方に金額がある行は保存させない", () => {
    expect(
      validateJournalLines([line("610", "消耗品費", 500, 500), line("100", "現金", 0, 0)]),
    ).toMatch(/両方に金額/);
  });

  it("科目だけ選んで金額が無い行は保存させない", () => {
    expect(
      validateJournalLines([
        line("610", "消耗品費", 1100, 0),
        line("100", "現金", 0, 1100),
        line("604", "旅費交通費", 0, 0),
      ]),
    ).toMatch(/3 行目（旅費交通費）: 金額が未入力/);
  });

  it("マイナス・小数は保存させない", () => {
    expect(
      validateJournalLines([line("610", "消耗品費", -100, 0), line("100", "現金", 0, -100)]),
    ).toMatch(/マイナス/);
    expect(
      validateJournalLines([line("610", "消耗品費", 10.5, 0), line("100", "現金", 0, 10.5)]),
    ).toMatch(/整数/);
  });
});

describe("createJournal / replaceJournal", () => {
  let t: TestDb;
  beforeEach(() => {
    t = installTestDb();
  });
  afterEach(() => t.close());
  const count = (table: string) => t.scalar<number>(`SELECT COUNT(*) FROM ${table}`);

  it("新規登録: ヘッダと明細を保存し、空行は保存しない", async () => {
    const id = await createJournal({
      date: "2026-11-26",
      description: "文房具",
      lines: [line("610", "消耗品費", 1100, 0, { tax_code: "P10", tax_amount: 100 }), line("100", "現金", 0, 1100), blank()],
    });
    expect(count("journals")).toBe(1);
    expect(count("journal_lines")).toBe(2);
    expect(t.scalar("SELECT id FROM journals")).toBe(id);
  });

  it("新規登録: 明細の保存に失敗したらヘッダも残さない", async () => {
    await expect(
      createJournal({
        date: "2026-11-26",
        description: "壊れた税区分",
        // 存在しない税区分 → FK 違反で明細の挿入が失敗する
        lines: [line("610", "消耗品費", 1100, 0, { tax_code: "NOPE" }), line("100", "現金", 0, 1100)],
      }),
    ).rejects.toThrow();
    expect(count("journals")).toBe(0);
    expect(count("journal_lines")).toBe(0);
  });

  it("編集: 明細を入れ替え、ヘッダを更新する", async () => {
    const id = await createJournal({
      date: "2026-11-26",
      description: "旧",
      lines: [line("610", "消耗品費", 1100, 0), line("100", "現金", 0, 1100)],
    });
    await replaceJournal(id, {
      date: "2026-11-27",
      description: "新",
      lines: [
        line("604", "旅費交通費", 500, 0),
        line("610", "消耗品費", 700, 0),
        line("110", "普通預金", 0, 1200),
      ],
    });
    expect(t.all("SELECT date, description FROM journals")).toEqual([
      { date: "2026-11-27", description: "新" },
    ]);
    expect(
      t.all("SELECT account_code, debit_amount, credit_amount FROM journal_lines ORDER BY account_code"),
    ).toEqual([
      { account_code: "110", debit_amount: 0, credit_amount: 1200 },
      { account_code: "604", debit_amount: 500, credit_amount: 0 },
      { account_code: "610", debit_amount: 700, credit_amount: 0 },
    ]);
  });

  it("編集: 新しい明細の保存に失敗しても、元の明細とヘッダが残る (旧実装は明細ゼロになった)", async () => {
    const id = await createJournal({
      date: "2026-11-26",
      description: "元の仕訳",
      lines: [line("610", "消耗品費", 1100, 0), line("100", "現金", 0, 1100)],
    });
    await expect(
      replaceJournal(id, {
        date: "2026-12-01",
        description: "失敗する編集",
        lines: [line("610", "消耗品費", 2200, 0, { tax_code: "NOPE" }), line("100", "現金", 0, 2200)],
      }),
    ).rejects.toThrow();
    expect(t.all("SELECT date, description FROM journals")).toEqual([
      { date: "2026-11-26", description: "元の仕訳" },
    ]);
    expect(
      t.all("SELECT account_code, debit_amount, credit_amount FROM journal_lines ORDER BY account_code"),
    ).toEqual([
      { account_code: "100", debit_amount: 0, credit_amount: 1100 },
      { account_code: "610", debit_amount: 1100, credit_amount: 0 },
    ]);
  });

  it("編集: 既に削除された仕訳には書き込まない", async () => {
    await expect(
      replaceJournal("gone", {
        date: "2026-11-26",
        description: "x",
        lines: [line("610", "消耗品費", 100, 0), line("100", "現金", 0, 100)],
      }),
    ).rejects.toThrow(/削除されています/);
    expect(count("journal_lines")).toBe(0);
  });

  it("検証に通らない内容は DB に触れずに断る", async () => {
    await expect(
      createJournal({
        date: "2026-11-26",
        description: "不一致",
        lines: [line("610", "消耗品費", 1100, 0), line("100", "現金", 0, 1000)],
      }),
    ).rejects.toThrow(/一致していません/);
    expect(count("journals")).toBe(0);
  });
});
