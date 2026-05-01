/**
 * Phase 4: 受信箱の「領収書」状態の写真を Claude OCR にかけて、
 * 自動で receipts + journals を作るフロー。
 *
 * 流れ:
 *   1. inbox.state='receipt' の行を取得
 *   2. 各写真の file_path を Tauri の fs プラグインで読み出して base64 化
 *   3. ocrWithClaude を呼ぶ (license key が必要)
 *   4. ai_ocr_log にリクエスト/レスポンス概要を記録 (透明性)
 *   5. receipts に新規行 (status='confirmed')
 *   6. journals + journal_lines を作成 (借方: 経費 / 貸方: 現金、初期テンプレ)
 *   7. photo_inbox.state='imported', imported_receipt_id を更新
 *
 * 注意:
 *   - Claude OCR は API 課金 + 画像送信を伴うので、ユーザの明示同意が必要
 *     (既存の hasAiOcrConsent() チェックを必ず通る)
 *   - 失敗した写真は state を変えず、ai_ocr_log に error を残す
 *   - 1 回の呼び出しで 100 件以上は処理しない (バッチサイズ上限)
 */

import { db } from "@/lib/localDb";
import { ocrWithClaude, getApiKey, hasAiOcrConsent } from "@/lib/ai-ocr";
import { suggestAccount } from "@/lib/accounts";
import type { OcrResult } from "@/types";

const BATCH_SIZE = 100;

export interface AutoJournalResult {
  total: number;
  imported: number;
  failed: number;
  errors: string[];
}

async function readFileAsBase64(path: string): Promise<{ base64: string; mediaType: string }> {
  // Rust 側の read_image_file コマンドで読む (plugin-fs のスコープ問題を回避)
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = (await invoke("read_image_file", { path })) as Uint8Array | number[];
  const u8 = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);

  // 先頭バイトで MIME 判定
  let mediaType = "image/jpeg";
  if (u8.length >= 4 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    mediaType = "image/png";
  } else if (
    u8.length >= 12 &&
    String.fromCharCode(u8[4], u8[5], u8[6], u8[7]) === "ftyp"
  ) {
    const brand = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]).toLowerCase();
    if (brand.startsWith("hei") || brand === "mif1" || brand === "msf1") {
      mediaType = "image/heic";
    }
  }

  // Uint8Array → base64
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      // @ts-expect-error fromCharCode array
      u8.subarray(i, i + chunk)
    );
  }
  const base64 = btoa(binary);
  return { base64, mediaType };
}

async function logAiOcr(opts: {
  inboxId: string;
  receiptId?: string | null;
  endpoint: string;
  bytesSent: number;
  resultSummary?: string | null;
  error?: string | null;
}): Promise<void> {
  await db.from("ai_ocr_log").insert({
    id: crypto.randomUUID(),
    inbox_id: opts.inboxId,
    receipt_id: opts.receiptId ?? null,
    sent_at: new Date().toISOString(),
    endpoint: opts.endpoint,
    bytes_sent: opts.bytesSent,
    result_summary: opts.resultSummary ?? null,
    error: opts.error ?? null,
  });
}

/**
 * 1 件の photo_inbox 行を仕訳化する。
 * @returns 作成された receipt_id か null (失敗時)
 */
export async function autoJournalizeOne(
  inboxRow: { id: string; file_path: string | null; ocr_text: string | null }
): Promise<string | null> {
  const consent = await hasAiOcrConsent();
  if (!consent) {
    throw new Error("AI OCR への同意が必要です");
  }
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error("ライセンスキーが未設定です");
  }
  if (!inboxRow.file_path) {
    throw new Error("file_path がありません");
  }

  const { base64, mediaType } = await readFileAsBase64(inboxRow.file_path);
  const bytesSent = Math.floor((base64.length * 3) / 4);

  let ocr: OcrResult & { usage?: { used: number; limit: number } };
  try {
    ocr = await ocrWithClaude(base64, mediaType, apiKey);
  } catch (e) {
    await logAiOcr({
      inboxId: inboxRow.id,
      endpoint: "/api/ocr",
      bytesSent,
      error: (e as Error).message,
    });
    throw e;
  }

  // receipts 行
  const receiptId = crypto.randomUUID();
  const suggested = ocr.vendor_name
    ? suggestAccount(`${ocr.vendor_name} ${ocr.raw_text || ""}`)
    : null;
  const accountCode = ocr.suggested_account_code || suggested?.code || "699";
  const accountName = ocr.suggested_account_name || suggested?.name || "雑費";

  await db.from("receipts").insert({
    id: receiptId,
    image_url: `file://${inboxRow.file_path}`,
    ocr_text: ocr.raw_text || inboxRow.ocr_text || null,
    vendor_name: ocr.vendor_name || null,
    amount: ocr.amount ?? null,
    date: ocr.date || null,
    account_code: accountCode,
    account_name: accountName,
    status: "confirmed",
    doc_type: "receipt",
  });

  // journals 行 + journal_lines 2 行 (借方: 経費 / 貸方: 現金)
  const journalDate = ocr.date || new Date().toISOString().slice(0, 10);
  const amount = ocr.amount ?? 0;
  const journalId = crypto.randomUUID();
  await db.from("journals").insert({
    id: journalId,
    date: journalDate,
    description: `${ocr.vendor_name || "不明"} - ${accountName}`,
    receipt_id: receiptId,
  });

  const taxAmount = Math.floor((amount * 10) / 110);
  await db.from("journal_lines").insert({
    id: crypto.randomUUID(),
    journal_id: journalId,
    account_code: accountCode,
    account_name: accountName,
    debit_amount: amount,
    credit_amount: 0,
    tax_code: "P10",
    tax_amount: taxAmount,
  });
  await db.from("journal_lines").insert({
    id: crypto.randomUUID(),
    journal_id: journalId,
    account_code: "100",
    account_name: "現金",
    debit_amount: 0,
    credit_amount: amount,
    tax_code: "OUT",
    tax_amount: 0,
  });

  // photo_inbox を imported に更新
  await db
    .from("photo_inbox")
    .update({
      state: "imported",
      imported_receipt_id: receiptId,
      imported_at: new Date().toISOString(),
    })
    .eq("id", inboxRow.id);

  await logAiOcr({
    inboxId: inboxRow.id,
    receiptId,
    endpoint: "/api/ocr",
    bytesSent,
    resultSummary: `${ocr.vendor_name ?? "?"} ${ocr.amount ?? "?"}円`,
  });

  return receiptId;
}

/**
 * 受信箱の state='receipt' を全部仕訳化する。
 * @param onProgress 各 1 件処理が終わるたびに呼ばれる
 */
export async function autoJournalizeAllReceipts(
  onProgress?: (done: number, total: number) => void
): Promise<AutoJournalResult> {
  // 先にライセンス/同意のチェック (毎ループでチェックすると同じエラーが N 回出る)
  const consent = await hasAiOcrConsent();
  if (!consent) {
    throw new Error("AI OCR への同意がまだです。設定で承諾してから再度実行してください。");
  }
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error("ライセンスキーが未設定です。設定 → AI OCR から登録してください。");
  }

  const { data } = await db
    .from("photo_inbox")
    .select("id, file_path, ocr_text")
    .eq("state", "receipt")
    .order("taken_at", { ascending: true })
    .limit(BATCH_SIZE);
  const rows = (data as { id: string; file_path: string | null; ocr_text: string | null }[] | null) ?? [];

  const result: AutoJournalResult = {
    total: rows.length,
    imported: 0,
    failed: 0,
    errors: [],
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      await autoJournalizeOne(row);
      result.imported++;
    } catch (e) {
      result.failed++;
      result.errors.push(`${row.id}: ${(e as Error).message}`);
    }
    if (onProgress) onProgress(i + 1, rows.length);
  }
  return result;
}

// ────────────────────────────────────────────────────────────
// 設定: auto_journal_mode_enabled
// ────────────────────────────────────────────────────────────

const KEY = "auto_journal_mode_enabled";

export async function getAutoJournalMode(): Promise<boolean> {
  try {
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("id", KEY)
      .single();
    return (data as { value?: string } | null)?.value === "1";
  } catch {
    return false;
  }
}

export async function setAutoJournalMode(enabled: boolean): Promise<void> {
  const value = enabled ? "1" : "0";
  const updated_at = new Date().toISOString();
  const { data: existing } = await db
    .from("app_settings")
    .select("id")
    .eq("id", KEY)
    .single();
  if (existing) {
    await db.from("app_settings").update({ value, updated_at }).eq("id", KEY);
  } else {
    await db.from("app_settings").insert({ id: KEY, value, updated_at });
  }
}
