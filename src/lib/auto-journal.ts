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

/**
 * Round 7 ㊐ + Round 8 ㊕: 借方を品目で分割するヘルパ。
 *
 * items を suggestAccount で分類 → 同じ勘定科目の品目をグループ化 → 各
 * グループに金額を按分する。Round 8 ㊕ から price 付き品目に対応:
 *   - price が全品目に揃っている → 価格按分 (正確)
 *   - price が無い品目があれば → 件数按分 (Round 7 と同じ近似)
 *
 * 1 グループしかない場合は単一行になる (従来挙動を保つ)。
 */
interface DebitGroup {
  account_code: string;
  account_name: string;
  amount: number;
  memo: string | null;
}

interface NormalizedItem {
  name: string;
  price: number | null;
}

export function splitDebitByItems(
  items: import("@/types").OcrItem[] | string[],
  defaultCode: string,
  defaultName: string,
  totalAmount: number,
): DebitGroup[] {
  // 旧形式 (string[]) と新形式 ({name,price}[]) を NormalizedItem に揃える
  const norm: NormalizedItem[] = [];
  for (const it of items) {
    if (typeof it === "string") {
      const n = it.trim();
      if (n.length > 0) norm.push({ name: n, price: null });
    } else if (it && typeof it === "object") {
      const name = (it as { name?: string }).name?.trim() ?? "";
      if (!name) continue;
      const p = (it as { price?: number | null }).price;
      norm.push({ name, price: typeof p === "number" && isFinite(p) && p > 0 ? p : null });
    }
  }
  if (norm.length < 2 || totalAmount <= 0) {
    return [
      { account_code: defaultCode, account_name: defaultName, amount: totalAmount, memo: null },
    ];
  }

  // 各品目に suggestAccount をかけてグループ化
  interface Bucket {
    name: string;
    items: NormalizedItem[];
    sumPrice: number; // null は 0 扱い (allHavePrice 判定で別途見る)
  }
  const buckets = new Map<string, Bucket>();
  for (const item of norm) {
    const acc = suggestAccount(item.name);
    const code = acc?.code ?? defaultCode;
    const name = acc?.name ?? defaultName;
    const cur = buckets.get(code);
    if (cur) {
      cur.items.push(item);
      if (item.price !== null) cur.sumPrice += item.price;
    } else {
      buckets.set(code, {
        name,
        items: [item],
        sumPrice: item.price !== null ? item.price : 0,
      });
    }
  }
  if (buckets.size < 2) {
    return [
      { account_code: defaultCode, account_name: defaultName, amount: totalAmount, memo: null },
    ];
  }

  // Round 8 ㊕: 全品目に price が付いているなら価格按分
  const allHavePrice = norm.every((n) => n.price !== null && n.price > 0);
  const totalPrice = norm.reduce((acc, n) => acc + (n.price ?? 0), 0);

  const groups: DebitGroup[] = [];
  let allocated = 0;
  const entries = Array.from(buckets.entries());
  for (const [code, info] of entries) {
    let amount: number;
    let memoNote: string;
    if (allHavePrice && totalPrice > 0) {
      // 価格按分 (端数は四捨五入)
      const ratio = info.sumPrice / totalPrice;
      amount = Math.round(totalAmount * ratio);
      memoNote = `自動分割 (価格按分 ${info.sumPrice}/${totalPrice}円, ${info.items.length}品)`;
    } else {
      // 件数按分 (旧 Round 7 ㊐ ロジック)
      const ratio = info.items.length / norm.length;
      amount = Math.floor(totalAmount * ratio);
      const sample = info.items.map((x) => x.name).join("/").slice(0, 40);
      memoNote = `自動分割 (件数按分: ${sample})`;
    }
    allocated += amount;
    groups.push({
      account_code: code,
      account_name: info.name,
      amount,
      memo: memoNote,
    });
  }

  // 端数調整: 合計と total の差を最大グループに寄せる (見栄えのため)
  const diff = totalAmount - allocated;
  if (diff !== 0 && groups.length > 0) {
    let maxIdx = 0;
    for (let i = 1; i < groups.length; i++) {
      if (groups[i].amount > groups[maxIdx].amount) maxIdx = i;
    }
    groups[maxIdx].amount += diff;
  }
  return groups;
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

  // journals 行 + journal_lines (借方: 経費 / 貸方: 現金)
  // Round 7 ㊐: items[] が複数の異なる勘定科目候補を含む時は、勘定科目ごとに
  // 別 journal_line に分割する (品目数で按分。価格までは取れていない)。
  // 1 グループ (品目なし or 全部同じ科目) なら従来通り単一 line。
  const journalDate = ocr.date || new Date().toISOString().slice(0, 10);
  const amount = ocr.amount ?? 0;
  const journalId = crypto.randomUUID();
  await db.from("journals").insert({
    id: journalId,
    date: journalDate,
    description: `${ocr.vendor_name || "不明"} - ${accountName}`,
    receipt_id: receiptId,
  });

  // 借方分割: items を suggestAccount でグループ化
  const debitGroups = splitDebitByItems(ocr.items ?? [], accountCode, accountName, amount);
  for (const g of debitGroups) {
    const taxAmount = Math.floor((g.amount * 10) / 110);
    await db.from("journal_lines").insert({
      id: crypto.randomUUID(),
      journal_id: journalId,
      account_code: g.account_code,
      account_name: g.account_name,
      debit_amount: g.amount,
      credit_amount: 0,
      tax_code: "P10",
      tax_amount: taxAmount,
      memo: g.memo ?? null,
    });
  }
  // 貸方は合計を 1 行で
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

// ────────────────────────────────────────────────────────────
// Round 4 ㊁ 失敗パターン分類
//
// AI OCR の失敗 (photo_inbox.last_error) を6 バケットに正規化する。
// 受信箱の「失敗」タブで「ライセンス上限が原因」等の集約バッジを出して、
// 個別カードのエラーメッセージを読まずとも対処方針が分かるようにするのが目的。
// ────────────────────────────────────────────────────────────

export type FailureBucket =
  | "license" // ライセンスキー / 月次上限
  | "consent" // AI OCR への同意
  | "network" // ネットワーク (timeout / DNS / 5xx)
  | "image" // 画像読み込み / file_path / Tauri API
  | "server" // サーバー側エラー (4xx 5xx)
  | "unknown"; // 分類できなかった

export interface FailureClass {
  bucket: FailureBucket;
  /** ユーザの設定変更等で直せるか (true なら UI で目立たせる) */
  actionable: boolean;
  /** 受信箱に出すワンライナー */
  hint: string;
}

/**
 * last_error 文字列を見てバケット分類する。
 * 純粋関数 (DB アクセスなし) なので UI からも auto-journal 内からも呼べる。
 */
export function classifyOcrError(msg: string | null | undefined): FailureClass {
  const m = (msg ?? "").toLowerCase();
  if (!m) {
    return { bucket: "unknown", actionable: false, hint: "原因不明 — 再試行してみてください" };
  }
  if (
    /license|ライセンス|monthly_limit|quota|limit|exceeded|超過|上限/.test(m)
  ) {
    return {
      bucket: "license",
      actionable: true,
      hint: "ライセンスキーの月次上限に到達したか未設定です — 設定→AI OCR で確認",
    };
  }
  if (/consent|同意/.test(m)) {
    return {
      bucket: "consent",
      actionable: true,
      hint: "AI OCR の同意がまだです — 設定→AI OCR で同意してください",
    };
  }
  if (
    /network|timeout|fetch failed|econnrefused|enotfound|getaddrinfo|タイムアウト|接続/.test(
      m,
    )
  ) {
    return {
      bucket: "network",
      actionable: false,
      hint: "ネットワーク不調 — 接続を確認してから再試行",
    };
  }
  if (/file_path|read[_\s]image|tauri api|read:|allowed/.test(m)) {
    return {
      bucket: "image",
      actionable: false,
      hint: "画像ファイルを読めませんでした — 一度スキャンし直すと直る可能性",
    };
  }
  if (/api error \(5|server error|503|502|500|internal/.test(m)) {
    return {
      bucket: "server",
      actionable: false,
      hint: "OCR サーバーが一時的に応答していません — 数分待って再試行",
    };
  }
  return { bucket: "unknown", actionable: false, hint: "原因不明 — 再試行してみてください" };
}

export interface FailureStats {
  total: number;
  byBucket: Record<FailureBucket, number>;
  /** 最頻値のバケット (件数 0 なら null) */
  top: { bucket: FailureBucket; count: number; hint: string } | null;
}

/**
 * receipt_failed 行の last_error をバケット集計する。
 * 受信箱画面で「失敗 N 件 (うち 〜 が原因)」のサマリーを出すのに使う。
 */
export async function getFailureStats(): Promise<FailureStats> {
  const { data } = await db
    .from("photo_inbox")
    .select("last_error")
    .eq("state", "receipt_failed");
  const rows = (data as { last_error: string | null }[] | null) ?? [];

  const byBucket: Record<FailureBucket, number> = {
    license: 0,
    consent: 0,
    network: 0,
    image: 0,
    server: 0,
    unknown: 0,
  };
  for (const r of rows) {
    byBucket[classifyOcrError(r.last_error).bucket]++;
  }

  // バケット → hint の固定テーブル (classifyOcrError と整合させる)
  const HINT: Record<FailureBucket, string> = {
    license: "ライセンスキーの月次上限に到達したか未設定です — 設定→AI OCR で確認",
    consent: "AI OCR の同意がまだです — 設定→AI OCR で同意してください",
    network: "ネットワーク不調 — 接続を確認してから再試行",
    image: "画像ファイルを読めませんでした — 一度スキャンし直すと直る可能性",
    server: "OCR サーバーが一時的に応答していません — 数分待って再試行",
    unknown: "原因不明 — 再試行してみてください",
  };

  let top: FailureStats["top"] = null;
  for (const [bucket, count] of Object.entries(byBucket) as [FailureBucket, number][]) {
    if (count > 0 && (!top || count > top.count)) {
      top = { bucket, count, hint: HINT[bucket] };
    }
  }
  return { total: rows.length, byBucket, top };
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
 * Round 6 ㊋ で追加: 直近の失敗バケットが license/consent で 2 件以上の時は
 * BlockedByPattern エラーで先に止める。「設定を直してから来て」を促し、
 * ユーザーがライセンス枠を浪費しないようにする。
 *
 * UI 側の使い方:
 *   - 候補カードの「⚡ いますぐ仕訳化」ボタンから呼ぶ
 *   - 戻り値の receiptId / journalId をトーストで「仕訳 #xxx を作成しました」
 *     のリンクに使う
 *   - BlockedByPattern が throw されたら「設定を見直してから再試行」モーダル
 *
 * @returns 作成された receipt_id (成功時)。失敗時は throw。
 */
export class BlockedByPattern extends Error {
  constructor(public readonly bucket: FailureBucket, public readonly hint: string) {
    super(`仕訳化を止めました: ${hint}`);
    this.name = "BlockedByPattern";
  }
}

export async function quickConfirmOne(inboxId: string): Promise<string> {
  // Round 6 ㊋ 事前 warn:
  // 直近の失敗が license/consent で 2 件以上ある状態でクイック確定を押すと、
  // ほぼ確実に同じ理由で落ちる + ライセンス上限を 1 件分浪費する。
  // → 押下時点で止めて UI 側に対処を促してもらう。
  try {
    const stats = await getFailureStats();
    if (
      stats.top &&
      stats.top.count >= 2 &&
      (stats.top.bucket === "license" || stats.top.bucket === "consent")
    ) {
      throw new BlockedByPattern(stats.top.bucket, stats.top.hint);
    }
  } catch (e) {
    if (e instanceof BlockedByPattern) throw e;
    // getFailureStats 自体の失敗は致命でないので無視して進める
  }
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

// ────────────────────────────────────────────────────────────
// Round 6 ㊍ 差し戻し Undo スタック
//
// reverseJournalToInbox の前に削除対象 (journal / journal_lines / receipt /
// photo_inbox) のスナップショットを取り、app_settings に JSON で 5 件まで
// 積んでおく。誤操作の事故を 1 クリックで取り戻せるようにする。
// ────────────────────────────────────────────────────────────

const UNDO_KEY = "reverse_undo_stack";
const UNDO_MAX = 5;

interface ReverseUndoSnapshot {
  ts: string; // ISO
  journal: Record<string, unknown>;
  journalLines: Record<string, unknown>[];
  receipt: Record<string, unknown> | null;
  inboxId: string | null;
  // 受信箱を candidate に戻す前の値 (undo で復元する時に使う)
  inboxPrev:
    | {
        state: string;
        imported_receipt_id: string | null;
        imported_at: string | null;
        last_error: string | null;
        attempts: number | null;
      }
    | null;
}

async function getUndoStack(): Promise<ReverseUndoSnapshot[]> {
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

async function setUndoStack(stack: ReverseUndoSnapshot[]): Promise<void> {
  const value = JSON.stringify(stack);
  const updated_at = new Date().toISOString();
  const { data: existing } = await db
    .from("app_settings")
    .select("id")
    .eq("id", UNDO_KEY)
    .single();
  if (existing) {
    await db.from("app_settings").update({ value, updated_at }).eq("id", UNDO_KEY);
  } else {
    await db.from("app_settings").insert({ id: UNDO_KEY, value, updated_at });
  }
}

/** 現在の undo stack 件数を返す (UI で「取り消し」ボタンの有無判定) */
export async function getReverseUndoCount(): Promise<number> {
  return (await getUndoStack()).length;
}

/**
 * 仕訳を取り消して、紐付いていた受信箱行を「未判定」に戻す
 * (Round 4 ㊂ "差し戻し" フロー、Round 6 ㊍ で undo スタック対応)。
 *
 * 流れ:
 *   1. 削除対象 (journal / journal_lines / receipt / photo_inbox prev) を
 *      スナップショットで取得 → undo stack に push
 *   2. journal_lines → journals → receipts の順で削除
 *   3. photo_inbox を candidate に戻し imported_receipt_id / imported_at を null
 *      (claude_result_json は保持 — 同じ画像なら再 OCR せずに使い回せる将来拡張用)
 *
 * @returns 戻された inbox_id か null (受信箱由来でない仕訳)
 */
export async function reverseJournalToInbox(journalId: string): Promise<string | null> {
  // 1. 削除対象を全部取得 (snapshot)
  const { data: jdata } = await db
    .from("journals")
    .select("*")
    .eq("id", journalId)
    .single();
  const journal = jdata as Record<string, unknown> | null;
  if (!journal) throw new Error("対象の仕訳が見つかりません");
  const receiptId = (journal.receipt_id as string | null) ?? null;

  const { data: lines } = await db
    .from("journal_lines")
    .select("*")
    .eq("journal_id", journalId);
  const journalLines = (lines as Record<string, unknown>[] | null) ?? [];

  let receipt: Record<string, unknown> | null = null;
  let inboxId: string | null = null;
  let inboxPrev: ReverseUndoSnapshot["inboxPrev"] = null;
  if (receiptId) {
    const { data: rdata } = await db
      .from("receipts")
      .select("*")
      .eq("id", receiptId)
      .single();
    receipt = rdata as Record<string, unknown> | null;

    const { data: idata } = await db
      .from("photo_inbox")
      .select("id, state, imported_receipt_id, imported_at, last_error, attempts")
      .eq("imported_receipt_id", receiptId)
      .single();
    const inboxRow = idata as
      | {
          id: string;
          state: string;
          imported_receipt_id: string | null;
          imported_at: string | null;
          last_error: string | null;
          attempts: number | null;
        }
      | null;
    if (inboxRow) {
      inboxId = inboxRow.id;
      inboxPrev = {
        state: inboxRow.state,
        imported_receipt_id: inboxRow.imported_receipt_id,
        imported_at: inboxRow.imported_at,
        last_error: inboxRow.last_error,
        attempts: inboxRow.attempts,
      };
    }
  }

  // 2. undo stack に push (size 上限超は古い順に捨てる)
  const stack = await getUndoStack();
  stack.unshift({
    ts: new Date().toISOString(),
    journal,
    journalLines,
    receipt,
    inboxId,
    inboxPrev,
  });
  while (stack.length > UNDO_MAX) stack.pop();
  await setUndoStack(stack);

  // 3. 関連レコードを順番に削除 (journal_lines は journal_id の FK で残るので明示)
  await db.from("journal_lines").delete().eq("journal_id", journalId);
  await db.from("journals").delete().eq("id", journalId);
  if (receiptId) {
    await db.from("receipts").delete().eq("id", receiptId);
  }

  // 4. 受信箱行を candidate に復帰 (受信箱由来でなければスキップ)
  if (inboxId) {
    await db
      .from("photo_inbox")
      .update({
        state: "candidate",
        imported_receipt_id: null,
        imported_at: null,
        last_error: null,
        attempts: 0,
      })
      .eq("id", inboxId);
  }

  return inboxId;
}

/**
 * 直近の差し戻しを取り消して、journal/lines/receipt/photo_inbox を全部
 * 元に戻す (Round 6 ㊍).
 *
 * @returns { restored: true, journalId } もしくは { restored: false } (stack 空)
 */
export async function undoLastReverse(): Promise<
  { restored: true; journalId: string } | { restored: false }
> {
  const stack = await getUndoStack();
  const snap = stack.shift();
  if (!snap) return { restored: false };
  await setUndoStack(stack);

  // 順番が大事: receipts 復元 → journals → journal_lines → photo_inbox
  // (FK でくくられている方を先に作る)
  if (snap.receipt) {
    await db.from("receipts").insert(snap.receipt);
  }
  await db.from("journals").insert(snap.journal);
  for (const line of snap.journalLines) {
    await db.from("journal_lines").insert(line);
  }
  if (snap.inboxId && snap.inboxPrev) {
    await db
      .from("photo_inbox")
      .update({
        state: snap.inboxPrev.state,
        imported_receipt_id: snap.inboxPrev.imported_receipt_id,
        imported_at: snap.inboxPrev.imported_at,
        last_error: snap.inboxPrev.last_error,
        attempts: snap.inboxPrev.attempts,
      })
      .eq("id", snap.inboxId);
  }
  return { restored: true, journalId: snap.journal.id as string };
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
