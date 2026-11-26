import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installTestDb, type TestDb } from "@/test-stubs/test-db";
import {
  calculateTaxForLines,
  computeInvoiceTotals,
  isInvoiceNumberTaken,
  lineAmount,
  nextInvoiceNumber,
  saveInvoice,
  type InvoiceItemRow,
} from "@/lib/invoice-save";

describe("lineAmount — 数量 × 単価", () => {
  it("浮動小数の誤差で 1 円欠けない", () => {
    expect(2.3 * 1500).not.toBe(3450); // 素朴に掛けると 3449.99…
    expect(lineAmount(2.3, 1500)).toBe(3450);
    expect(lineAmount(1.15, 100)).toBe(115);
    expect(lineAmount(0.1, 30)).toBe(3);
  });
  it("円未満は切り捨て", () => {
    expect(lineAmount(1.5, 333)).toBe(499); // 499.5
    expect(lineAmount(0.333, 1000)).toBe(333);
  });
  it("整数同士・0・空", () => {
    expect(lineAmount(3, 12_000)).toBe(36_000);
    expect(lineAmount(0, 12_000)).toBe(0);
    expect(lineAmount(NaN, 100)).toBe(0);
  });
});

describe("消費税の端数処理は税率ごとに 1 回 (適格請求書)", () => {
  it("外税: 行ごとに切り捨てて足さない", () => {
    const lines = [
      { amount: 1005, tax_code: "S10" },
      { amount: 1005, tax_code: "S10" },
      { amount: 1005, tax_code: "S10" },
    ];
    // 行ごとだと 100 × 3 = 300。正しくは floor(3,015 × 10%) = 301
    expect(calculateTaxForLines(lines)).toBe(301);
  });
  it("税率が混ざる時は税率ごとに分けて計算する", () => {
    const lines = [
      { amount: 1005, tax_code: "S10" },
      { amount: 1005, tax_code: "S10" },
      { amount: 999, tax_code: "S08R" },
      { amount: 999, tax_code: "S08R" },
      { amount: 5000, tax_code: "OUT" },
    ];
    // 10%: floor(2,010 × 0.10) = 201 / 8%: floor(1,998 × 0.08) = 159
    expect(calculateTaxForLines(lines)).toBe(201 + 159);
  });
});

describe("computeInvoiceTotals", () => {
  const item = (quantity: number, unit_price: number, tax_code = "S10") => ({
    quantity,
    unit_price,
    tax_code,
  });

  it("外税 + 源泉徴収 (差引)", () => {
    const t = computeInvoiceTotals([item(1, 100_000)], {
      taxInclusive: false,
      whMode: "deduct",
      whAuto: true,
      withholding: 0,
    });
    expect(t).toMatchObject({
      amounts: [100_000],
      subtotal: 100_000,
      tax: 10_000,
      gross: 110_000,
      wh: 10_210,
      total: 99_790,
    });
  });

  it("源泉徴収を別記にすると請求金額からは引かない", () => {
    const t = computeInvoiceTotals([item(1, 100_000)], {
      taxInclusive: false,
      whMode: "note",
      whAuto: true,
      withholding: 0,
    });
    expect(t.wh).toBe(10_210);
    expect(t.total).toBe(110_000);
  });

  it("内税: 合計は税込のまま、消費税は内数", () => {
    const t = computeInvoiceTotals([item(3, 1000)], {
      taxInclusive: true,
      whMode: "deduct",
      whAuto: false,
      withholding: 0,
    });
    expect(t.subtotal).toBe(3000);
    expect(t.tax).toBe(272); // floor(3,000 × 10/110)
    expect(t.gross).toBe(3000);
    expect(t.total).toBe(3000);
  });

  it("小数の数量でも金額が欠けない", () => {
    const t = computeInvoiceTotals([item(2.3, 1500)], {
      taxInclusive: false,
      whMode: "deduct",
      whAuto: false,
      withholding: 0,
    });
    expect(t.amounts).toEqual([3450]);
    expect(t.total).toBe(3795);
  });
});

describe("保存・採番 (DB)", () => {
  let t: TestDb;
  beforeEach(() => {
    t = installTestDb();
  });
  afterEach(() => t.close());

  const header = (number: string, extra: Record<string, unknown> = {}) => ({
    doc_type: "invoice",
    invoice_number: number,
    issue_date: "2026-11-26",
    partner_name: "株式会社サンプル",
    subtotal: 10_000,
    tax_amount: 1_000,
    total_amount: 11_000,
    status: "draft",
    ...extra,
  });
  const row = (description: string, amount: number, extra: Partial<InvoiceItemRow> = {}) => ({
    description,
    quantity: 1,
    unit: "式",
    unit_price: amount,
    amount,
    tax_code: "S10",
    tax_amount: Math.floor(amount / 10),
    ...extra,
  });
  const items = (invoiceId: string) =>
    t.all<{ description: string; amount: number; sort_order: number }>(
      "SELECT description, amount, sort_order FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order",
      invoiceId,
    );

  it("新規保存: ヘッダと明細が入る", async () => {
    const id = await saveInvoice(null, header("INV-20261126-001"), [row("制作費", 8000), row("交通費", 2000)]);
    expect(t.scalar("SELECT COUNT(*) FROM invoices")).toBe(1);
    expect(items(id)).toEqual([
      { description: "制作費", amount: 8000, sort_order: 0 },
      { description: "交通費", amount: 2000, sort_order: 1 },
    ]);
  });

  it("新規保存: 明細の保存に失敗したら、請求書ごと残さない", async () => {
    await expect(
      saveInvoice(null, header("INV-20261126-001"), [
        row("制作費", 8000),
        row("不正な税区分", 2000, { tax_code: "NO_SUCH_CODE" }),
      ]),
    ).rejects.toBeTruthy();
    expect(t.scalar("SELECT COUNT(*) FROM invoices")).toBe(0);
    expect(t.scalar("SELECT COUNT(*) FROM invoice_items")).toBe(0);
  });

  it("更新: 明細を入れ替える", async () => {
    const id = await saveInvoice(null, header("INV-20261126-001"), [row("旧", 10_000)]);
    await saveInvoice(id, header("INV-20261126-001", { subject: "11月分" }), [
      row("新 A", 6000),
      row("新 B", 4000),
    ]);
    expect(items(id).map((r) => r.description)).toEqual(["新 A", "新 B"]);
    expect(t.scalar<string>("SELECT subject FROM invoices WHERE id = ?", id)).toBe("11月分");
  });

  it("更新: 明細の保存に失敗したら、元の明細とヘッダのまま", async () => {
    const id = await saveInvoice(null, header("INV-20261126-001", { subject: "元の件名" }), [
      row("元の明細", 10_000),
    ]);
    await expect(
      saveInvoice(id, header("INV-20261126-001", { subject: "書き換え後", total_amount: 1 }), [
        row("新 A", 6000),
        row("不正な税区分", 4000, { tax_code: "NO_SUCH_CODE" }),
      ]),
    ).rejects.toBeTruthy();
    expect(items(id)).toEqual([{ description: "元の明細", amount: 10_000, sort_order: 0 }]);
    expect(
      t.all("SELECT subject, total_amount FROM invoices WHERE id = ?", id),
    ).toEqual([{ subject: "元の件名", total_amount: 11_000 }]);
  });

  it("削除済みの文書は更新できない", async () => {
    await expect(saveInvoice("no-such-id", header("X-1"), [row("a", 1)])).rejects.toThrow(/削除/);
  });

  it("採番: 同じ種別の最大の連番 + 1 (発行日の新旧に左右されない)", async () => {
    expect(await nextInvoiceNumber("invoice", "2026-11-26")).toBe("INV-20261126-001");
    await saveInvoice(null, header("INV-20261101-007", { issue_date: "2026-11-01" }), [row("a", 1)]);
    // 発行日は新しいが連番は小さい文書があっても、最大 (7) から続ける
    await saveInvoice(null, header("INV-20261120-003", { issue_date: "2026-11-20" }), [row("a", 1)]);
    expect(await nextInvoiceNumber("invoice", "2026-11-26")).toBe("INV-20261126-008");
    // 領収書は別の連番
    expect(await nextInvoiceNumber("receipt", "2026-11-26")).toBe("RCP-20261126-001");
    await saveInvoice(null, header("RCP-20261125-002", { doc_type: "receipt" }), [row("a", 1)]);
    expect(await nextInvoiceNumber("receipt", "2026-11-26")).toBe("RCP-20261126-003");
    expect(await nextInvoiceNumber("invoice", "2026-11-26")).toBe("INV-20261126-008");
  });

  it("採番: 末尾が日付のような長い数字は連番とみなさない", async () => {
    await saveInvoice(null, header("PO-20261101"), [row("a", 1)]);
    expect(await nextInvoiceNumber("invoice", "2026-11-26")).toBe("INV-20261126-001");
  });

  it("番号の重複を検出する (自分自身は除く)", async () => {
    const id = await saveInvoice(null, header("INV-20261126-001"), [row("a", 1)]);
    expect(await isInvoiceNumberTaken("INV-20261126-001", null)).toBe(true);
    expect(await isInvoiceNumberTaken("INV-20261126-001", id)).toBe(false);
    expect(await isInvoiceNumberTaken("INV-20261126-002", null)).toBe(false);
  });
});
