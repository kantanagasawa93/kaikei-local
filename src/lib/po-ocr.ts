/**
 * Round 28: 発注書 (Purchase Order) を OCR して請求書の元データを抽出する.
 *
 * 既存の領収書 OCR (ai-ocr.ts) とは別パスで Claude に投げる。
 * /api/ocr/purchase-order エンドポイントを叩き、{ partner_name, items[], ... } を返す。
 */

import { getApiKey } from "@/lib/ai-ocr";
import { db } from "@/lib/localDb";

export interface PurchaseOrderItem {
  description: string;
  quantity: number;
  unit: string | null;
  unit_price: number | null;
  amount: number | null;
}

export interface PurchaseOrderResult {
  partner_name: string | null;
  partner_address: string | null;
  po_number: string | null;
  issue_date: string | null;
  due_date: string | null;
  subject: string | null;
  items: PurchaseOrderItem[];
  subtotal: number | null;
  tax_amount: number | null;
  total: number | null;
  raw_text: string;
  usage?: { used: number; limit: number };
}

const DEFAULT_API_BASE = "https://api-server-lac.vercel.app";

async function getApiBase(): Promise<string> {
  try {
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("id", "api_base_override")
      .single();
    const override = (data as { value?: string } | null)?.value;
    if (override) return override;
  } catch {
    /* silent */
  }
  return DEFAULT_API_BASE;
}

/**
 * 発注書画像を Claude OCR にかけて請求書の元データを返す.
 *
 * @param imageBase64 base64 文字列 (data:URL のヘッダなし)
 * @param mediaType "image/jpeg" / "image/png" / "application/pdf" (Claude 対応)
 */
export async function ocrPurchaseOrder(
  imageBase64: string,
  mediaType: string,
): Promise<PurchaseOrderResult> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error("ライセンスキーが未設定です。設定 → AI OCR から登録してください。");
  }
  const base = await getApiBase();
  const res = await fetch(`${base}/api/ocr/purchase-order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-License-Key": apiKey,
    },
    body: JSON.stringify({ image: imageBase64, media_type: mediaType }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `API error (${res.status})`);
  }
  const json = (await res.json()) as Partial<PurchaseOrderResult>;
  // normalize
  const items: PurchaseOrderItem[] = Array.isArray(json.items)
    ? json.items.map((it) => {
        const raw = it as Partial<PurchaseOrderItem> & { name?: string };
        return {
          description: String(raw.description ?? raw.name ?? "").trim() || "(品名なし)",
          quantity: Number.isFinite(raw.quantity) && raw.quantity ? Number(raw.quantity) : 1,
          unit: typeof raw.unit === "string" ? raw.unit : null,
          unit_price:
            raw.unit_price != null && Number.isFinite(raw.unit_price)
              ? Number(raw.unit_price)
              : null,
          amount:
            raw.amount != null && Number.isFinite(raw.amount)
              ? Number(raw.amount)
              : null,
        };
      })
    : [];
  return {
    partner_name: json.partner_name ?? null,
    partner_address: json.partner_address ?? null,
    po_number: json.po_number ?? null,
    issue_date: json.issue_date ?? null,
    due_date: json.due_date ?? null,
    subject: json.subject ?? null,
    items,
    subtotal:
      json.subtotal != null && Number.isFinite(json.subtotal)
        ? Number(json.subtotal)
        : null,
    tax_amount:
      json.tax_amount != null && Number.isFinite(json.tax_amount)
        ? Number(json.tax_amount)
        : null,
    total:
      json.total != null && Number.isFinite(json.total) ? Number(json.total) : null,
    raw_text: typeof json.raw_text === "string" ? json.raw_text : "",
    usage: json.usage,
  };
}

/**
 * 抽出済み PurchaseOrderResult から invoices + invoice_items テーブルへ INSERT する.
 *
 * - issuer_settings.default_payment_terms_days があれば due_date を補完
 * - partner_name が既存 partners.name と完全一致すれば partner_id を紐付け、
 *   無ければ partner_id=null のまま (UI でユーザに編集を促す)
 * - invoice_number は "PO-yyyymmdd-NN" 風に自動採番 (po_number があればそれを採用)
 *
 * @returns 作成された invoice.id
 */
export async function createInvoiceFromPo(
  po: PurchaseOrderResult,
): Promise<string> {
  const invoiceId = crypto.randomUUID();
  const todayIso = new Date().toISOString().slice(0, 10);
  const issueDate = po.issue_date || todayIso;

  // 支払期限: PO の due_date があればそれ、なければ issuer_settings の default 日数を足す
  let dueDate = po.due_date;
  if (!dueDate) {
    try {
      const { data: iss } = await db
        .from("issuer_settings")
        .select("default_payment_terms_days")
        .eq("id", "singleton")
        .single();
      const days = (iss as { default_payment_terms_days?: number } | null)
        ?.default_payment_terms_days;
      if (days && days > 0) {
        const dt = new Date(issueDate);
        dt.setDate(dt.getDate() + days);
        dueDate = dt.toISOString().slice(0, 10);
      }
    } catch {
      /* silent */
    }
  }

  // partner_id 解決
  let partnerId: string | null = null;
  if (po.partner_name && po.partner_name.trim().length >= 2) {
    try {
      const { data } = await db
        .from("partners")
        .select("id")
        .eq("name", po.partner_name.trim())
        .single();
      const row = data as { id: string } | null;
      if (row) partnerId = row.id;
    } catch {
      /* 未登録 — UI で 「取引先として登録」を提案できる */
    }
  }

  // 請求書番号: po_number があれば使う、なければ INV-YYYYMMDD-XXX
  const fallback = `INV-${todayIso.replace(/-/g, "")}-${invoiceId.slice(0, 4).toUpperCase()}`;
  const invoiceNumber = po.po_number?.trim() || fallback;

  const subtotal = po.subtotal ?? 0;
  const taxAmount = po.tax_amount ?? 0;
  const totalAmount = po.total ?? subtotal + taxAmount;

  await db.from("invoices").insert({
    id: invoiceId,
    invoice_number: invoiceNumber,
    issue_date: issueDate,
    due_date: dueDate,
    partner_id: partnerId,
    partner_name: po.partner_name ?? "(未設定)",
    partner_address: po.partner_address,
    subject: po.subject,
    subtotal,
    tax_amount: taxAmount,
    total_amount: totalAmount,
    status: "draft",
    notes: po.po_number ? `発注書番号: ${po.po_number}` : null,
  });

  // 明細行
  for (let i = 0; i < po.items.length; i++) {
    const it = po.items[i];
    const amount =
      it.amount ?? (it.unit_price != null ? it.unit_price * it.quantity : 0);
    await db.from("invoice_items").insert({
      id: crypto.randomUUID(),
      invoice_id: invoiceId,
      sort_order: i,
      description: it.description,
      quantity: it.quantity,
      unit: it.unit,
      unit_price: it.unit_price ?? 0,
      amount,
      tax_code: "S10", // 標準税率 10% を既定 (ユーザは編集画面で変更可能)
      tax_amount: 0,
    });
  }

  return invoiceId;
}
