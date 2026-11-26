import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installTestDb, type TestDb } from "@/test-stubs/test-db";
import {
  addAllocation,
  deleteAllocation,
  loadAllocationRows,
  recalculateAllocations,
  splitAllocation,
} from "@/lib/allocations";

let t: TestDb;
beforeEach(() => {
  t = installTestDb();
});
afterEach(() => t.close());

let seq = 0;
/** 経費を 1 件、現金払いで計上する。 */
function expense(date: string, code: string, name: string, amount: number): string {
  const id = `j${++seq}`;
  t.raw.exec(`INSERT INTO journals (id, date, description) VALUES ('${id}', '${date}', '${name}')`);
  t.raw.exec(
    `INSERT INTO journal_lines (id, journal_id, account_code, account_name, debit_amount, credit_amount)
     VALUES ('${id}-d', '${id}', '${code}', '${name}', ${amount}, 0),
            ('${id}-c', '${id}', '100', '現金', 0, ${amount})`,
  );
  return id;
}

/** 科目の帳簿残高 (借方 − 貸方)。按分後に経費がいくら残っているか。 */
const balance = (code: string, year = 2025) =>
  t.scalar<number>(
    `SELECT COALESCE(SUM(l.debit_amount - l.credit_amount), 0)
       FROM journal_lines l JOIN journals j ON j.id = l.journal_id
      WHERE l.account_code = ? AND j.date BETWEEN ? AND ?`,
    code,
    `${year}-01-01`,
    `${year}-12-31`,
  );

describe("splitAllocation", () => {
  it("事業分は切り捨て、残りが家事分", () => {
    expect(splitAllocation(100_001, 50)).toEqual({ business: 50_000, private: 50_001 });
    expect(splitAllocation(120_000, 30)).toEqual({ business: 36_000, private: 84_000 });
    expect(splitAllocation(120_000, 100)).toEqual({ business: 120_000, private: 0 });
    expect(splitAllocation(120_000, 0)).toEqual({ business: 0, private: 120_000 });
  });
});

describe("家事按分の再計算", () => {
  it("家事分を 12/31 付で事業主貸に振り替える", async () => {
    expense("2025-03-10", "605", "通信費", 60_000);
    expense("2025-09-10", "605", "通信費", 60_000);
    await addAllocation({ account_code: "605", business_ratio: 70, fiscal_year: 2025 });

    const res = await recalculateAllocations(2025);
    expect(res).toEqual({ generated: 1, cleared: 0, skipped: [] });

    expect(balance("605")).toBe(84_000); // 120,000 × 70%
    expect(balance("190")).toBe(36_000);
    const j = t.all<{ date: string; is_adjustment: number; description: string }>(
      "SELECT date, is_adjustment, description FROM journals WHERE description LIKE '家事按分%'",
    );
    expect(j).toEqual([
      { date: "2025-12-31", is_adjustment: 1, description: "家事按分: 通信費 (事業利用70%)" },
    ]);
  });

  it("何度再計算しても金額が変わらない (前回の按分仕訳を合計に含めない)", async () => {
    expense("2025-03-10", "605", "通信費", 120_000);
    await addAllocation({ account_code: "605", business_ratio: 50, fiscal_year: 2025 });

    for (let i = 0; i < 3; i++) {
      await recalculateAllocations(2025);
      expect(balance("605"), `${i + 1} 回目`).toBe(60_000);
      expect(balance("190"), `${i + 1} 回目`).toBe(60_000);
      // 按分仕訳は常に 1 本だけ
      expect(t.scalar("SELECT COUNT(*) FROM journals WHERE description LIKE '家事按分%'")).toBe(1);
    }

    const [row] = await loadAllocationRows(2025);
    expect(row.total_amount).toBe(120_000); // 表示する合計は按分前
    expect(row.business_amount).toBe(60_000);
    expect(row.private_amount).toBe(60_000);
    expect(row.posted_private_amount).toBe(60_000);
    expect(row.in_sync).toBe(true);
  });

  it("取引を足した後は「未反映」になり、再計算で追従する", async () => {
    expense("2025-03-10", "605", "通信費", 100_000);
    await addAllocation({ account_code: "605", business_ratio: 50, fiscal_year: 2025 });
    await recalculateAllocations(2025);

    expense("2025-10-01", "605", "通信費", 20_000);
    let [row] = await loadAllocationRows(2025);
    expect(row.total_amount).toBe(120_000);
    expect(row.posted_private_amount).toBe(50_000);
    expect(row.in_sync).toBe(false);

    await recalculateAllocations(2025);
    [row] = await loadAllocationRows(2025);
    expect(row.in_sync).toBe(true);
    expect(balance("605")).toBe(60_000);
  });

  it("まだ再計算していないルールは未反映として見える", async () => {
    expense("2025-03-10", "605", "通信費", 100_000);
    await addAllocation({ account_code: "605", business_ratio: 50, fiscal_year: 2025 });
    const [row] = await loadAllocationRows(2025);
    expect(row.posted_private_amount).toBe(0);
    expect(row.in_sync).toBe(false);
  });

  it("他の年度の取引・按分には触れない", async () => {
    expense("2024-06-01", "605", "通信費", 500_000);
    expense("2025-06-01", "605", "通信費", 100_000);
    await addAllocation({ account_code: "605", business_ratio: 50, fiscal_year: 2024 });
    await addAllocation({ account_code: "605", business_ratio: 80, fiscal_year: 2025 });
    await recalculateAllocations(2024);
    await recalculateAllocations(2025);
    expect(balance("605", 2024)).toBe(250_000);
    expect(balance("605", 2025)).toBe(80_000);
    await recalculateAllocations(2025);
    expect(balance("605", 2024)).toBe(250_000);
  });

  it("家事分が無くなったら、既存の按分仕訳を取り消す", async () => {
    const id = expense("2025-03-10", "605", "通信費", 100_000);
    await addAllocation({ account_code: "605", business_ratio: 50, fiscal_year: 2025 });
    await recalculateAllocations(2025);
    t.raw.exec(`DELETE FROM journals WHERE id = '${id}'`); // 元の経費を消した

    const res = await recalculateAllocations(2025);
    expect(res).toEqual({ generated: 0, cleared: 1, skipped: [] });
    expect(t.scalar("SELECT COUNT(*) FROM journals")).toBe(0);
    expect(
      t.scalar<string | null>("SELECT generated_journal_id FROM biz_allocations"),
    ).toBeNull();
  });
});

describe("按分ルールの登録・削除", () => {
  it("同じ年度に同じ科目は 2 回登録できない (二重按分の防止)", async () => {
    await addAllocation({ account_code: "605", business_ratio: 50, fiscal_year: 2025 });
    await expect(
      addAllocation({ account_code: "605", business_ratio: 30, fiscal_year: 2025 }),
    ).rejects.toThrow(/登録済み/);
    // 別の年度なら登録できる
    await addAllocation({ account_code: "605", business_ratio: 30, fiscal_year: 2026 });
    expect(t.scalar("SELECT COUNT(*) FROM biz_allocations")).toBe(2);
  });

  it("減価償却費は登録できない (固定資産台帳側で按分済み)", async () => {
    await expect(
      addAllocation({ account_code: "611", business_ratio: 50, fiscal_year: 2025 }),
    ).rejects.toThrow(/固定資産台帳/);
    expect(t.scalar("SELECT COUNT(*) FROM biz_allocations")).toBe(0);
  });

  it("以前に登録されていた減価償却費のルールは再計算で飛ばし、既存の仕訳も取り消す", async () => {
    expense("2025-12-31", "611", "減価償却費", 300_000);
    t.raw.exec(
      `INSERT INTO journals (id, date, description, is_adjustment) VALUES ('old', '2025-12-31', '家事按分: 減価償却費 (事業利用50%)', 1)`,
    );
    t.raw.exec(
      `INSERT INTO journal_lines (id, journal_id, account_code, account_name, debit_amount, credit_amount)
       VALUES ('old-d', 'old', '190', '事業主貸', 150000, 0), ('old-c', 'old', '611', '減価償却費', 0, 150000)`,
    );
    t.raw.exec(
      `INSERT INTO biz_allocations (id, account_code, account_name, business_ratio, fiscal_year, generated_journal_id)
       VALUES ('a611', '611', '減価償却費', 50, 2025, 'old')`,
    );

    const res = await recalculateAllocations(2025);
    expect(res).toEqual({ generated: 0, cleared: 0, skipped: ["減価償却費"] });
    expect(balance("611")).toBe(300_000); // 二重に按分しない
    expect(balance("190")).toBe(0);
  });

  it("ルールを削除すると、生成済みの按分仕訳も取り消す", async () => {
    expense("2025-03-10", "605", "通信費", 100_000);
    await addAllocation({ account_code: "605", business_ratio: 50, fiscal_year: 2025 });
    await recalculateAllocations(2025);
    expect(balance("605")).toBe(50_000);

    const id = t.scalar<string>("SELECT id FROM biz_allocations");
    await deleteAllocation(id);
    expect(t.scalar("SELECT COUNT(*) FROM biz_allocations")).toBe(0);
    expect(balance("605")).toBe(100_000); // 按分前に戻る
    expect(balance("190")).toBe(0);
  });
});
