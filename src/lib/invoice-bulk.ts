/**
 * 請求書の一括削除 + Undo.
 *
 * /invoices 一覧のチェックボックス選択 → 「選択を削除」で複数の invoices と
 * 紐付く invoice_items をまとめて削除する。削除前にスナップショットを
 * app_settings の undo stack に push し、「取り消し」で復元できるようにする。
 *
 * パターンは auto-journal.ts の bulkDeleteJournals / undoBulkDelete と同じ。
 */

import { db } from "@/lib/localDb";

const UNDO_KEY = "invoice_bulk_delete_undo_stack";
const UNDO_MAX = 5;

interface Snapshot {
  ts: string;
  invoices: Record<string, unknown>[];
  invoice_items: Record<string, unknown>[];
}

async function readStack(): Promise<Snapshot[]> {
  try {
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("id", UNDO_KEY)
      .single();
    const raw = (data as { value?: string } | null)?.value;
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeStack(stack: Snapshot[]): Promise<void> {
  const value = JSON.stringify(stack);
  const updated_at = new Date().toISOString();
  const { data: existing } = await db
    .from("app_settings")
    .select("id")
    .eq("id", UNDO_KEY)
    .single();
  if (existing) {
    await db
      .from("app_settings")
      .update({ value, updated_at })
      .eq("id", UNDO_KEY);
  } else {
    await db.from("app_settings").insert({ id: UNDO_KEY, value, updated_at });
  }
}

export async function getInvoiceBulkUndoCount(): Promise<number> {
  return (await readStack()).length;
}

/**
 * 複数の請求書を削除する。invoice_items は CASCADE で消えるが、Undo で復元する
 * ため明示的にスナップショットを撮る。
 * @returns 実際に削除できた件数
 */
export async function bulkDeleteInvoices(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const invoices: Record<string, unknown>[] = [];
  const items: Record<string, unknown>[] = [];
  for (const id of ids) {
    try {
      const { data: inv } = await db
        .from("invoices")
        .select("*")
        .eq("id", id)
        .single();
      if (inv) invoices.push(inv as Record<string, unknown>);
      const { data: its } = await db
        .from("invoice_items")
        .select("*")
        .eq("invoice_id", id);
      for (const it of (its as Record<string, unknown>[] | null) ?? []) {
        items.push(it);
      }
    } catch (e) {
      console.warn(`bulkDeleteInvoices snapshot ${id} failed:`, e);
    }
  }
  const stack = await readStack();
  stack.unshift({
    ts: new Date().toISOString(),
    invoices,
    invoice_items: items,
  });
  while (stack.length > UNDO_MAX) stack.pop();
  await writeStack(stack);

  let deleted = 0;
  for (const id of ids) {
    try {
      // 明示的に items も先に消す (FK CASCADE 任せでも動くが順序を確定させる)
      await db.from("invoice_items").delete().eq("invoice_id", id);
      await db.from("invoices").delete().eq("id", id);
      deleted++;
    } catch (e) {
      console.warn(`bulkDeleteInvoices delete ${id} failed:`, e);
    }
  }
  return deleted;
}

/**
 * 直近の一括削除を取り消して、請求書 + 明細行を復元する。
 * @returns 復元した請求書件数 (0 なら stack 空)
 */
export async function undoBulkDeleteInvoices(): Promise<{ restored: number }> {
  const stack = await readStack();
  if (stack.length === 0) return { restored: 0 };
  const snap = stack.shift()!;
  await writeStack(stack);

  let restored = 0;
  for (const inv of snap.invoices) {
    try {
      await db.from("invoices").insert(inv);
      restored++;
    } catch (e) {
      console.warn("undoBulkDeleteInvoices invoices.insert failed:", e);
    }
  }
  for (const it of snap.invoice_items) {
    try {
      await db.from("invoice_items").insert(it);
    } catch (e) {
      console.warn("undoBulkDeleteInvoices invoice_items.insert failed:", e);
    }
  }
  return { restored };
}
