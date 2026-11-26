import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installTestDb, type TestDb } from "@/test-stubs/test-db";
import {
  BankTxAlreadyHandledError,
  importBankTransactions,
  journalizeBankTransaction,
  selectNewTransactions,
} from "@/lib/bank-journal";
import type { ParsedTransaction } from "@/lib/csv-import";
import type { BankTransaction } from "@/types";

const parsed = (
  date: string,
  description: string,
  amount: number,
  extra: Partial<ParsedTransaction> = {},
): ParsedTransaction => ({
  date,
  description,
  amount,
  is_income: false,
  balance_after: null,
  suggested_account_code: null,
  suggested_account_name: null,
  ...extra,
});

describe("selectNewTransactions — 取込済みの明細を飛ばす", () => {
  it("同じ明細は件数で比べる (本当に 2 回ある取引は 2 件とも残す)", () => {
    const csv = [
      parsed("2025-04-01", "コンビニ", 500),
      parsed("2025-04-01", "コンビニ", 500),
      parsed("2025-04-02", "電車", 300),
    ];
    // DB にコンビニが 1 件だけ入っている → もう 1 件と電車が新規
    const fresh = selectNewTransactions(csv, [
      { date: "2025-04-01", description: "コンビニ", amount: 500, is_income: false, balance_after: null },
    ]);
    expect(fresh.map((t) => t.description)).toEqual(["コンビニ", "電車"]);
  });
  it("SQLite の 0/1 と boolean の違いで別物扱いしない", () => {
    const csv = [parsed("2025-04-01", "売上入金", 10_000, { is_income: true, balance_after: 50_000 })];
    const fresh = selectNewTransactions(csv, [
      {
        date: "2025-04-01",
        description: "売上入金",
        amount: 10_000,
        is_income: 1 as unknown as boolean,
        balance_after: 50_000,
      },
    ]);
    expect(fresh).toEqual([]);
  });
});

describe("明細の取り込み・仕訳化 (DB)", () => {
  let t: TestDb;
  beforeEach(() => {
    t = installTestDb();
    t.raw.exec(
      `INSERT INTO bank_accounts (id, name, bank_name, account_type) VALUES
         ('bank', '事業用口座', 'サンプル銀行', 'bank'),
         ('card', '事業用カード', 'サンプルカード', 'credit_card')`,
    );
  });
  afterEach(() => t.close());

  const txRows = () =>
    t.all<BankTransaction>("SELECT * FROM bank_transactions ORDER BY date, description");
  const lines = (journalId: string) =>
    t.all<{ account_code: string; debit_amount: number; credit_amount: number; tax_code: string; tax_amount: number }>(
      "SELECT account_code, debit_amount, credit_amount, tax_code, tax_amount FROM journal_lines WHERE journal_id = ? ORDER BY debit_amount DESC",
      journalId,
    );

  it("同じ CSV を 2 回取り込んでも二重にならない", async () => {
    const csv = [
      parsed("2025-04-01", "コンビニ", 500),
      parsed("2025-04-01", "コンビニ", 500),
      parsed("2025-04-02", "電車", 300),
    ];
    expect(await importBankTransactions("bank", csv)).toEqual({ added: 3, skipped: 0 });
    expect(await importBankTransactions("bank", csv)).toEqual({ added: 0, skipped: 3 });
    // 期間が重なる次の CSV: 新しい 1 件だけ入る
    expect(
      await importBankTransactions("bank", [...csv, parsed("2025-04-03", "書籍", 1980)]),
    ).toEqual({ added: 1, skipped: 3 });
    expect(txRows()).toHaveLength(4);
    // 別の口座は別物
    expect(await importBankTransactions("card", csv)).toEqual({ added: 3, skipped: 0 });
  });

  it("出金: 経費 / 普通預金。消費税は税区分に従う", async () => {
    await importBankTransactions("bank", [
      parsed("2025-04-02", "電車", 1100, { suggested_account_name: "旅費交通費" }),
    ]);
    const [tx] = txRows();
    const journalId = await journalizeBankTransaction(tx, { account_type: "bank" });
    expect(lines(journalId)).toEqual([
      { account_code: "604", debit_amount: 1100, credit_amount: 0, tax_code: "P10", tax_amount: 100 },
      { account_code: "110", debit_amount: 0, credit_amount: 1100, tax_code: "OUT", tax_amount: 0 },
    ]);
    expect(txRows()[0]).toMatchObject({ status: "matched", journal_id: journalId });
  });

  it("租税公課のように課税対象外の科目には消費税を立てない", async () => {
    await importBankTransactions("bank", [
      parsed("2025-05-31", "自動車税", 39_500, { suggested_account_name: "租税公課" }),
    ]);
    const journalId = await journalizeBankTransaction(txRows()[0], { account_type: "bank" });
    const [debit] = lines(journalId);
    expect(debit).toMatchObject({ account_code: "601", tax_code: "OUT", tax_amount: 0 });
  });

  it("カード明細の相手科目は未払金、入金は売上", async () => {
    await importBankTransactions("card", [parsed("2025-04-05", "文具店", 2200)]);
    await importBankTransactions("bank", [
      parsed("2025-04-10", "振込 カ)サンプル", 110_000, { is_income: true }),
    ]);
    const all = txRows();
    const cardJournal = await journalizeBankTransaction(all[0], { account_type: "credit_card" });
    expect(lines(cardJournal).map((l) => l.account_code)).toEqual(["699", "210"]);
    const incomeJournal = await journalizeBankTransaction(all[1], { account_type: "bank" });
    expect(lines(incomeJournal)).toEqual([
      { account_code: "110", debit_amount: 110_000, credit_amount: 0, tax_code: "OUT", tax_amount: 0 },
      { account_code: "400", debit_amount: 0, credit_amount: 110_000, tax_code: "S10", tax_amount: 10_000 },
    ]);
  });

  it("同じ明細を 2 回仕訳にできない (連打・古い画面からの操作)", async () => {
    await importBankTransactions("bank", [parsed("2025-04-02", "電車", 1100)]);
    const [tx] = txRows(); // 画面が持っている古い行 (status = unmatched)
    const results = await Promise.allSettled([
      journalizeBankTransaction(tx, { account_type: "bank" }),
      journalizeBankTransaction(tx, { account_type: "bank" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(journalizeBankTransaction(tx, { account_type: "bank" })).rejects.toBeInstanceOf(
      BankTxAlreadyHandledError,
    );
    expect(t.scalar("SELECT COUNT(*) FROM journals")).toBe(1);
  });

  it("収支を指定した自動ルールが当たる (0/1 と boolean の比較)", async () => {
    t.raw.exec(
      `INSERT INTO auto_rules (id, is_income, match_text, match_type, action_type, account_code, account_name, tax_code, is_enabled)
       VALUES ('r1', 0, '電気', 'contains', 'suggest_journal', '603', '水道光熱費', 'P10', 1)`,
    );
    await importBankTransactions("bank", [parsed("2025-04-20", "電気料金 4月分", 8800)]);
    const journalId = await journalizeBankTransaction(txRows()[0], { account_type: "bank" });
    expect(lines(journalId)[0]).toMatchObject({ account_code: "603", tax_code: "P10", tax_amount: 800 });
    expect(t.scalar("SELECT accepted_count FROM auto_rules WHERE id = 'r1'")).toBe(1);
  });
});
