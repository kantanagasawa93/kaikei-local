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
 *
 * 失敗時は呼び出し側 (autoJournalizeAllReceipts) が photo_inbox を
 * state='receipt_failed' に更新する。本関数は throw して呼び出し元に伝える。
 */
export async function autoJournalizeOne(
  inboxRow: { id: string; file_path: string | null; ocr_text: string | null; attempts?: number | null }
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

  // photo_inbox を imported に更新 + Claude OCR 結果を完全保存 + エラー履歴クリア
  // claude_result_json は再仕訳・監査用。雑費自動付与のロジック復元元になる。
  await db
    .from("photo_inbox")
    .update({
      state: "imported",
      imported_receipt_id: receiptId,
      imported_at: new Date().toISOString(),
      claude_result_json: JSON.stringify(ocr),
      last_error: null,
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
    .select("id, file_path, ocr_text, attempts")
    .eq("state", "receipt")
    .order("taken_at", { ascending: true })
    .limit(BATCH_SIZE);
  const rows =
    (data as
      | { id: string; file_path: string | null; ocr_text: string | null; attempts: number | null }[]
      | null) ?? [];

  const result: AutoJournalResult = {
    total: rows.length,
    imported: 0,
    failed: 0,
    errors: [],
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const attempts = (row.attempts ?? 0) + 1;
    try {
      await autoJournalizeOne(row);
      result.imported++;
    } catch (e) {
      result.failed++;
      const msg = (e as Error).message;
      result.errors.push(`${row.id}: ${msg}`);
      // 失敗を photo_inbox に永続化:
      // - state='receipt_failed' で受信箱の「失敗」タブに並ぶ
      // - last_error に最後のエラーを残し、UI で原因を表示
      // - attempts++ で何度失敗したか分かる
      try {
        await db
          .from("photo_inbox")
          .update({
            state: "receipt_failed",
            last_error: msg.slice(0, 500),
            attempts,
          })
          .eq("id", row.id);
      } catch {
        // 永続化に失敗してもバッチ全体は止めない (受信箱は最悪 'receipt' に
        // 戻ったままだが UI から再ボタンで復旧可能)
      }
    }
    if (onProgress) onProgress(i + 1, rows.length);
  }
  return result;
}

/**
 * 1 件だけ「いますぐ仕訳化」する高速パス (Round 3 ⓓ "クイック確定モード")。
 *
 * 流れ:
 *   1. 受信箱の対象行を読む
 *   2. state が candidate / receipt_failed なら 'receipt' に上げる
 *      (failed の場合は last_error を消して再試行扱い)
 *   3. autoJournalizeOne を呼ぶ
 *   4. 失敗したら呼び出し元 (UI) に throw、state は 'receipt_failed' に落として永続化
 *
 * UI 側の使い方:
 *   - 候補カードの「⚡ いますぐ仕訳化」ボタンから呼ぶ
 *   - 戻り値の receiptId / journalId をトーストで「仕訳 #xxx を作成しました」
 *     のリンクに使う
 *
 * @returns 作成された receipt_id (成功時)。失敗時は throw。
 */
export async function quickConfirmOne(inboxId: string): Promise<string> {
  // 受信箱行を取得 — file_path / ocr_text / attempts が要る
  const { data } = await db
    .from("photo_inbox")
    .select("id, file_path, ocr_text, attempts, state")
    .eq("id", inboxId)
    .single();
  const row = data as
    | {
        id: string;
        file_path: string | null;
        ocr_text: string | null;
        attempts: number | null;
        state: string;
      }
    | null;
  if (!row) throw new Error("対象の写真が見つかりません");

  // state を 'receipt' に上げる (candidate / receipt_failed どちらでも OK)
  if (row.state !== "receipt" && row.state !== "imported") {
    await db
      .from("photo_inbox")
      .update({ state: "receipt", last_error: null })
      .eq("id", inboxId);
  }

  try {
    const receiptId = await autoJournalizeOne(row);
    if (!receiptId) {
      throw new Error("自動仕訳が空の結果を返しました");
    }
    return receiptId;
  } catch (e) {
    const msg = (e as Error).message;
    // autoJournalizeAllReceipts と同じ永続化ロジック
    try {
      await db
        .from("photo_inbox")
        .update({
          state: "receipt_failed",
          last_error: msg.slice(0, 500),
          attempts: (row.attempts ?? 0) + 1,
        })
        .eq("id", inboxId);
    } catch {
      /* 永続化失敗は致命でないので throw 元のまま */
    }
    throw e;
  }
}

/**
 * receipt_failed 状態の写真を「もう一度試す」。state を 'receipt' に戻すだけ。
 * 直後に autoJournalizeAllReceipts を呼ぶか、UI の「領収書をすべて自動仕訳」を
 * 押すと、再度 Claude OCR にかかる。
 */
export async function resetFailedToReceipt(inboxId: string): Promise<void> {
  await db
    .from("photo_inbox")
    .update({ state: "receipt", last_error: null })
    .eq("id", inboxId);
}

/**
 * 失敗したものをまとめて 'receipt' に戻す (一括再試行の前段)。
 */
export async function resetAllFailedToReceipt(): Promise<number> {
  const { data } = await db
    .from("photo_inbox")
    .select("id")
    .eq("state", "receipt_failed");
  const rows = (data as { id: string }[] | null) ?? [];
  if (rows.length === 0) return 0;
  await db
    .from("photo_inbox")
    .update({ state: "receipt", last_error: null })
    .eq("state", "receipt_failed");
  return rows.length;
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
