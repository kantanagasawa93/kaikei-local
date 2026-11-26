/**
 * 請求書・領収書の金額計算と保存。
 *
 * 編集ページに直接書かれていた処理を切り出したもの。直した点:
 *   - 数量 × 単価を浮動小数のまま掛けていた (2.3 × 1,500 = 3,449.99… → 3,449 円)
 *   - 外税の消費税を行ごとに切り捨てて足していた。適格請求書は
 *     「1 つの請求書につき税率ごとに 1 回」の端数処理が要件
 *   - 保存時に DB エラーを見ておらず、明細を全部消してから入れ直していたので、
 *     途中で失敗すると明細の無い請求書が「保存済み」として残った
 *   - 採番が「発行日が最新の 1 件の連番 + 1」で、日付を前後させると番号が重複した
 */

import { db } from "@/lib/localDb";
import {
  calcWithholdingTax,
  calculateTax,
  extractTaxFromIncluded,
  extractTaxFromIncludedLines,
} from "@/lib/tax-classes";

export interface InvoiceItemDraft {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  tax_code: string;
}

/**
 * 数量 × 単価 (円未満切り捨て)。
 * 数量は小数第 3 位までとし、整数に直してから掛ける (浮動小数の誤差で 1 円欠けるのを防ぐ)。
 */
export function lineAmount(quantity: number, unitPrice: number): number {
  const q = Math.round((Number(quantity) || 0) * 1000);
  const p = Math.round(Number(unitPrice) || 0);
  return Math.floor((q * p) / 1000);
}

/** 外税: 税区分ごとに税抜額を合算してから 1 回だけ端数処理した消費税の合計。 */
export function calculateTaxForLines(
  lines: { amount: number; tax_code: string | null | undefined }[],
): number {
  const byCode = new Map<string, number>();
  for (const l of lines) {
    const code = l.tax_code ?? "";
    byCode.set(code, (byCode.get(code) ?? 0) + l.amount);
  }
  let tax = 0;
  for (const [code, sum] of byCode) tax += calculateTax(sum, code);
  return tax;
}

export interface InvoiceTotals {
  /** 明細ごとの金額 (items と同じ並び) */
  amounts: number[];
  /** 外税: 税抜の小計 / 内税: 税込の合計 */
  subtotal: number;
  tax: number;
  /** 税込の合計 (源泉徴収を引く前) */
  gross: number;
  /** 源泉徴収税額 */
  wh: number;
  /** 請求金額 (whMode=deduct なら源泉徴収を差し引いた額) */
  total: number;
}

export function computeInvoiceTotals(
  items: Pick<InvoiceItemDraft, "quantity" | "unit_price" | "tax_code">[],
  opts: {
    taxInclusive: boolean;
    whMode: "deduct" | "note";
    /** true: 税抜報酬額から源泉徴収を自動計算 / false: withholding をそのまま使う */
    whAuto: boolean;
    withholding: number;
  },
): InvoiceTotals {
  const lines = items.map((it) => ({
    amount: lineAmount(it.quantity, it.unit_price),
    tax_code: it.tax_code,
  }));
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const tax = opts.taxInclusive ? extractTaxFromIncludedLines(lines) : calculateTaxForLines(lines);
  const gross = opts.taxInclusive ? subtotal : subtotal + tax;
  const whBase = opts.taxInclusive ? subtotal - tax : subtotal;
  const wh = opts.whAuto ? calcWithholdingTax(whBase) : Math.max(0, Math.round(opts.withholding || 0));
  return {
    amounts: lines.map((l) => l.amount),
    subtotal,
    tax,
    gross,
    wh,
    total: opts.whMode === "deduct" ? gross - wh : gross,
  };
}

/**
 * 明細 1 行の税額 (invoice_items.tax_amount 用の参考値)。
 * 請求書としての税額は税率ごとに 1 回の端数処理 (InvoiceTotals.tax) が正で、
 * 行の合算とは数円ずれ得る。
 */
export function lineTaxAmount(amount: number, taxCode: string, taxInclusive: boolean): number {
  return taxInclusive ? extractTaxFromIncluded(amount, taxCode) : calculateTax(amount, taxCode);
}

// ---------------------------------------------------------------------------
// 採番
// ---------------------------------------------------------------------------

type DocType = "invoice" | "receipt";

/** 番号の末尾の連番 (6 桁まで。20250101 のような日付は連番とみなさない)。 */
function trailingSequence(number: string): number | null {
  const m = number.match(/(\d+)$/);
  if (!m || m[1].length > 6) return null;
  return parseInt(m[1], 10);
}

/**
 * 次の番号を返す: INV-YYYYMMDD-XXX (領収書は RCP-)。
 * 連番は同じ種別の全件の最大 + 1。既に使われている番号は飛ばす。
 * @param today YYYY-MM-DD (端末のローカル日付)
 */
export async function nextInvoiceNumber(docType: DocType, today: string): Promise<string> {
  const { data, error } = await db.from("invoices").select("invoice_number, doc_type");
  if (error) throw error;
  const rows = (data as { invoice_number: string; doc_type: string | null }[] | null) ?? [];
  const used = new Set(rows.map((r) => r.invoice_number));
  let seq = 1;
  for (const r of rows) {
    if ((r.doc_type === "receipt" ? "receipt" : "invoice") !== docType) continue;
    const n = trailingSequence(r.invoice_number ?? "");
    if (n !== null && n >= seq) seq = n + 1;
  }
  const prefix = `${docType === "receipt" ? "RCP" : "INV"}-${today.replace(/-/g, "")}-`;
  let candidate = `${prefix}${String(seq).padStart(3, "0")}`;
  while (used.has(candidate)) candidate = `${prefix}${String(++seq).padStart(3, "0")}`;
  return candidate;
}

/** 同じ番号を持つ別の文書があるか (保存前の確認用)。 */
export async function isInvoiceNumberTaken(
  invoiceNumber: string,
  excludeId: string | null,
): Promise<boolean> {
  const { data, error } = await db
    .from("invoices")
    .select("id")
    .eq("invoice_number", invoiceNumber);
  if (error) throw error;
  return ((data as { id: string }[] | null) ?? []).some((r) => r.id !== excludeId);
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------

export interface InvoiceItemRow {
  description: string;
  quantity: number;
  unit: string | null;
  unit_price: number;
  amount: number;
  tax_code: string;
  tax_amount: number;
}

function toItemRows(invoiceId: string, items: InvoiceItemRow[]): Record<string, unknown>[] {
  return items.map((it, i) => ({
    id: crypto.randomUUID(),
    invoice_id: invoiceId,
    sort_order: i,
    description: it.description,
    quantity: it.quantity,
    unit: it.unit,
    unit_price: it.unit_price,
    amount: it.amount,
    tax_code: it.tax_code,
    tax_amount: it.tax_amount,
  }));
}

async function deleteItemsByIds(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 400) {
    const { error } = await db.from("invoice_items").delete().in("id", ids.slice(i, i + 400));
    if (error) throw error;
  }
}

/**
 * 請求書 (ヘッダ + 明細) を保存して id を返す。失敗したら保存前の状態に戻して例外を投げる。
 *   - 新規: ヘッダ → 明細。明細に失敗したらヘッダごと消す
 *   - 更新: ヘッダ更新 → 新しい明細を追加 → 古い明細を削除 (明細が空になる瞬間を作らない)
 */
export async function saveInvoice(
  id: string | null,
  header: Record<string, unknown>,
  items: InvoiceItemRow[],
): Promise<string> {
  if (items.length === 0) throw new Error("明細が 1 行もありません");

  if (!id) {
    const newId = crypto.randomUUID();
    const { error: headerError } = await db.from("invoices").insert({ ...header, id: newId });
    if (headerError) throw headerError;
    const { error: itemsError } = await db.from("invoice_items").insert(toItemRows(newId, items));
    if (itemsError) {
      await db.from("invoices").delete().eq("id", newId); // invoice_items は ON DELETE CASCADE
      throw itemsError;
    }
    return newId;
  }

  const { data: beforeData, error: beforeError } = await db
    .from("invoices")
    .select("*")
    .eq("id", id)
    .single();
  if (beforeError) throw beforeError;
  const before = beforeData as Record<string, unknown> | null;
  if (!before) throw new Error("この文書は既に削除されています");

  const { data: oldItems, error: oldError } = await db
    .from("invoice_items")
    .select("id")
    .eq("invoice_id", id);
  if (oldError) throw oldError;
  const oldIds = ((oldItems as { id: string }[] | null) ?? []).map((r) => r.id);

  const { error: headerError } = await db.from("invoices").update(header).eq("id", id);
  if (headerError) throw headerError;

  const restoreHeader = async () => {
    const restore: Record<string, unknown> = {};
    for (const k of Object.keys(header)) restore[k] = before[k] ?? null;
    await db.from("invoices").update(restore).eq("id", id);
  };

  const newRows = toItemRows(id, items);
  const newIds = newRows.map((r) => r.id as string);
  const { error: insertError } = await db.from("invoice_items").insert(newRows);
  if (insertError) {
    await deleteItemsByIds(newIds).catch(() => {});
    await restoreHeader();
    throw insertError;
  }
  try {
    await deleteItemsByIds(oldIds);
  } catch (e) {
    await deleteItemsByIds(newIds).catch(() => {});
    await restoreHeader();
    throw e;
  }
  return id;
}
