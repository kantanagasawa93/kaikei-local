/**
 * Phase 4: 受信箱の「領収書」状態の写真を AI OCR にかけて、
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
 *   - AI OCR は API 課金 + 画像送信を伴うので、ユーザの明示同意が必要
 *     (既存の hasAiOcrConsent() チェックを必ず通る)
 *   - 失敗した写真は state を変えず、ai_ocr_log に error を残す
 *   - 1 回の呼び出しで 100 件以上は処理しない (バッチサイズ上限)
 */

import { db } from "@/lib/localDb";
import { ocrWithClaude, getApiKey, hasAiOcrConsent } from "@/lib/ai-ocr";
import { suggestAccount, suggestAccountForVendor } from "@/lib/accounts";
import { defaultTaxCodeForAccountCode, extractTaxFromIncluded } from "@/lib/tax-classes";
import { toLocalDateString, todayLocal } from "@/lib/date-utils";
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

  // Round 28: iPhone 撮影の原寸 (3024x4032 = 3-5MB JPEG) は Vercel の 4.5MB
  // request body 上限を超えて "Load failed" になるため、長辺 1600px + JPEG
  // quality 0.85 に圧縮してから送る。HEIC も WKWebView (macOS) で decode 可能
  // なので JPEG に再エンコードできる。
  // 既に小さいファイルや圧縮失敗 (Canvas decode 不可) は無圧縮で送出。
  let outU8 = u8;
  let outMime = mediaType;
  try {
    const { compressImageForOcr } = await import("@/lib/image-compression");
    const blob = new Blob([new Uint8Array(u8)], { type: mediaType });
    const file = new File([blob], "inbox-image", { type: mediaType });
    const result = await compressImageForOcr(file);
    if (result.compressed) {
      outU8 = new Uint8Array(await result.file.arrayBuffer());
      outMime = result.file.type || "image/jpeg";
    }
  } catch (e) {
    console.warn("[auto-journal] compressImageForOcr failed, fallback to raw:", e);
  }

  // Uint8Array → base64
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < outU8.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      // @ts-expect-error fromCharCode array
      outU8.subarray(i, i + chunk)
    );
  }
  const base64 = btoa(binary);
  return { base64, mediaType: outMime };
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
 * Round 21 ⓕ → Round 28 で findOrCreatePartner に統一.
 *
 * 領収書 OCR 経路の vendor_name (= 自分が買った相手 = 仕入先) を partners に
 * 自動学習する薄いラッパ。実体は partner-cleanup.ts の findOrCreatePartner で、
 * 発注書 OCR 経路 (customer 役割) と共通のロジックを使う。
 *
 * @param defaultAccountCode receipts.account_code と同じ値を使うと、次回以降の
 *   仕訳でこの partner を選んだ時にデフォルト科目を引きやすい。
 */
export async function learnVendorAsPartner(
  vendorName: string | null,
  defaultAccountCode: string | null,
): Promise<string | null> {
  const { findOrCreatePartner } = await import("@/lib/partner-cleanup");
  return findOrCreatePartner({
    name: vendorName,
    isVendor: true,
    isCustomer: false,
    defaultAccountCode,
    source: "OCR 領収書",
  });
}

type OcrOutcome = OcrResult & {
  usage?: { used: number; limit: number };
  fallback?: "vision";
};

/** 既に仕訳化済みの写真をもう一度仕訳化しようとした時のエラー。 */
export class AlreadyJournalizedError extends Error {
  constructor() {
    super("この写真は既に仕訳化されています");
    this.name = "AlreadyJournalizedError";
  }
}

/**
 * 同じ写真の仕訳化が同時に 2 本走らないようにするための、このウィンドウ内のロック。
 * (一括仕訳の実行中にカードの「いますぐ仕訳化」を押す、Enter を連打する、等)
 */
const journalizingInbox = new Set<string>();

/**
 * AI が返した日付を "YYYY-MM-DD" に正規化する。読めない・あり得ない日付は null。
 * 形式の崩れた文字列をそのまま仕訳の日付にすると、期間で絞る全ての集計から
 * その仕訳が消える (文字列比較で範囲外になる) ので、必ずここを通す。
 */
export function normalizeOcrDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.normalize("NFKC").trim();
  const m =
    /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(t) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null; // 2/30 等
  return toLocalDateString(dt);
}

/** photo_inbox.taken_at (ISO / SQLite 形式どちらも) → ローカル日付。読めなければ null。 */
function takenDateLocal(takenAt: string | null | undefined): string | null {
  if (!takenAt) return null;
  const iso = takenAt.includes("T") ? takenAt : takenAt.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : toLocalDateString(d);
}

/**
 * 受信箱の写真を AI OCR にかける (同意・ライセンスの確認込み)。
 * 上流の当日枠切れの時だけ、Vision OCR のテキストからの簡易抽出にフォールバックする。
 */
async function runOcrForInbox(inboxRow: {
  id: string;
  file_path: string | null;
  ocr_text: string | null;
}): Promise<{ ocr: OcrOutcome; bytesSent: number }> {
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

  try {
    return { ocr: await ocrWithClaude(base64, mediaType, apiKey), bytesSent };
  } catch (e) {
    await logAiOcr({
      inboxId: inboxRow.id,
      endpoint: "/api/ocr",
      bytesSent,
      error: (e as Error).message,
    });
    // Round 29: Gemini quota 超過なら Vision OCR テキストから簡易抽出してフォールバック.
    // 確度は低いが「全件失敗 → 手入力」より「叩き台が入る」方が遥かにマシ。
    const { isQuotaError, buildFallbackOcrResult } = await import("./vision-ocr-fallback");
    if (isQuotaError(e) && inboxRow.ocr_text) {
      const fb = buildFallbackOcrResult(inboxRow.ocr_text);
      // notes 等で「Vision フォールバックで作成」と判別できるよう fallback フラグを付ける
      return { ocr: { ...fb, fallback: "vision" }, bytesSent };
    }
    throw e;
  }
}

/**
 * 1 件の photo_inbox 行を仕訳化する。
 * @returns 作成された receipt_id
 *
 * @param opts.presetOcr 既に手元にある読み取り結果 (利用者が受信箱で修正した値など)。
 *   渡された時は AI OCR を呼ばず、この値で領収書と仕訳を作る。
 *
 * 失敗時は throw する。呼び出し側 (autoJournalizeAllReceipts / quickConfirmOne) が
 * photo_inbox を state='receipt_failed' に更新する。
 * 途中まで作った領収書・仕訳は片付けてから throw するので、半端な状態は残さない。
 */
export async function autoJournalizeOne(
  inboxRow: { id: string; file_path: string | null; ocr_text: string | null; attempts?: number | null },
  opts: { presetOcr?: OcrOutcome } = {},
): Promise<string | null> {
  if (journalizingInbox.has(inboxRow.id)) {
    throw new Error("この写真は処理中です。完了までお待ちください");
  }
  journalizingInbox.add(inboxRow.id);
  try {
    return await journalizeLocked(inboxRow, opts);
  } finally {
    journalizingInbox.delete(inboxRow.id);
  }
}

async function journalizeLocked(
  inboxRow: { id: string; file_path: string | null; ocr_text: string | null },
  opts: { presetOcr?: OcrOutcome },
): Promise<string> {
  // 渡された行は一覧取得時点のもの。その後に別の経路 (領収書登録ページ・一括仕訳・
  // カードのボタン) で仕訳化済みになっていないか、最新の状態で確かめる。
  const { data: freshData, error: freshError } = await db
    .from("photo_inbox")
    .select("id, state, imported_receipt_id, file_path, ocr_text, taken_at")
    .eq("id", inboxRow.id)
    .single();
  if (freshError) throw freshError;
  const fresh = freshData as {
    id: string;
    state: string;
    imported_receipt_id: string | null;
    file_path: string | null;
    ocr_text: string | null;
    taken_at: string | null;
  } | null;
  if (!fresh) throw new Error("対象の写真が見つかりません");
  if (fresh.state === "imported" || fresh.imported_receipt_id) {
    throw new AlreadyJournalizedError();
  }

  let ocr: OcrOutcome;
  let bytesSent = 0;
  if (opts.presetOcr) {
    ocr = opts.presetOcr;
  } else {
    const r = await runOcrForInbox(fresh);
    ocr = r.ocr;
    bytesSent = r.bytesSent;
  }

  const filePath = fresh.file_path ?? inboxRow.file_path;
  if (!filePath) throw new Error("file_path がありません");

  // 勘定科目: 取引先ごとに利用者が決めた既定科目 (suggestAccountForVendor が partners
  // から引く) を最優先にする。AI OCR 側の suggested_account_* は店名や本文の
  // キーワード一致にすぎないので、その次。
  const suggested = await suggestAccountForVendor(ocr.vendor_name, ocr.raw_text || "");
  const accountCode = suggested?.code || ocr.suggested_account_code || "699";
  const accountName = suggested?.name || ocr.suggested_account_name || "雑費";

  // Round 21 ⓕ: vendor_name が partners に無ければ自動学習として新規登録。
  const partnerId = await learnVendorAsPartner(ocr.vendor_name ?? null, accountCode);

  const ocrDate = normalizeOcrDate(ocr.date);
  // 日付が読めない時は「今日」ではなく、まず写真の撮影日を使う
  // (月末に溜めて処理すると、今日の日付では月も年度もずれる)
  const journalDate = ocrDate || takenDateLocal(fresh.taken_at) || todayLocal();
  const amount = ocr.amount != null && Number.isFinite(ocr.amount) ? Math.round(ocr.amount) : 0;
  // 金額か日付が読めていないもの・Vision フォールバックは「要確認」として残す
  const needsReview = ocr.fallback === "vision" || ocr.amount == null || !ocrDate;

  const receiptId = crypto.randomUUID();
  const journalId = crypto.randomUUID();
  let receiptInserted = false;
  let journalInserted = false;

  try {
    const { error: receiptError } = await db.from("receipts").insert({
      id: receiptId,
      image_url: `file://${filePath}`,
      ocr_text: ocr.raw_text || fresh.ocr_text || null,
      vendor_name: ocr.vendor_name || null,
      amount: ocr.amount ?? null,
      date: ocrDate,
      account_code: accountCode,
      account_name: accountName,
      status: needsReview ? "pending" : "confirmed",
      doc_type: "receipt",
      partner_id: partnerId,
    });
    if (receiptError) throw receiptError;
    receiptInserted = true;

    const { error: journalError } = await db.from("journals").insert({
      id: journalId,
      date: journalDate,
      description:
        `${ocr.vendor_name || "不明"} - ${accountName}` +
        (ocr.fallback === "vision" ? " [Vision 仮]" : ""),
      receipt_id: receiptId,
    });
    if (journalError) throw journalError;
    journalInserted = true;

    // 借方分割: items を suggestAccount でグループ化
    // (items[] が複数の異なる勘定科目候補を含む時は、勘定科目ごとに別行にする)
    const debitGroups = splitDebitByItems(ocr.items ?? [], accountCode, accountName, amount);
    const lineRows: Record<string, unknown>[] = debitGroups.map((g) => {
      // 税区分は科目から決める (租税公課・保険料などに一律 10% の仕入税額を立てない)
      const taxCode = defaultTaxCodeForAccountCode(g.account_code);
      return {
        id: crypto.randomUUID(),
        journal_id: journalId,
        account_code: g.account_code,
        account_name: g.account_name,
        debit_amount: g.amount,
        credit_amount: 0,
        tax_code: taxCode,
        tax_amount: extractTaxFromIncluded(g.amount, taxCode),
        partner_id: partnerId,
        memo: g.memo ?? null,
      };
    });
    // 貸方は合計を 1 行で
    lineRows.push({
      id: crypto.randomUUID(),
      journal_id: journalId,
      account_code: "100",
      account_name: "現金",
      debit_amount: 0,
      credit_amount: amount,
      tax_code: "OUT",
      tax_amount: 0,
    });
    const { error: linesError } = await db.from("journal_lines").insert(lineRows);
    if (linesError) throw linesError;

    // photo_inbox を imported に更新 + 読み取り結果を保存 + エラー履歴クリア
    // claude_result_json は再仕訳・監査用。
    const { error: inboxError } = await db
      .from("photo_inbox")
      .update({
        state: "imported",
        imported_receipt_id: receiptId,
        imported_at: new Date().toISOString(),
        claude_result_json: JSON.stringify(ocr),
        last_error: null,
      })
      .eq("id", fresh.id);
    if (inboxError) throw inboxError;
  } catch (e) {
    // 途中まで作ったものを片付ける (仕訳は明細ごと、領収書も消す)。
    // 残すと「明細の無い仕訳」「仕訳の無い確定済み領収書」になり、次の実行で二重に作られる。
    if (journalInserted) await db.from("journals").delete().eq("id", journalId);
    if (receiptInserted) await db.from("receipts").delete().eq("id", receiptId);
    throw e;
  }

  if (!opts.presetOcr) {
    await logAiOcr({
      inboxId: fresh.id,
      receiptId,
      endpoint: "/api/ocr",
      bytesSent,
      resultSummary: `${ocr.vendor_name ?? "?"} ${ocr.amount ?? "?"}円`,
    });
  }

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
  | "quota" // AI OCR (Gemini Free Tier) の本日利用枠超過 (= 待てば直る)
  | "license" // ユーザのライセンスキー / 月次上限 (= 設定で直す)
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
  // Round 28: Gemini Free Tier 上限 (=待てば直る) と ユーザライセンス上限を区別
  // 上流の Gemini quota は HTTP 429 + 「本日利用枠」など独自メッセージで識別
  if (
    /本日利用枠|本日.*超え|free.?tier|gemini.*quota|resource.?exhausted|429/i.test(
      msg ?? "",
    )
  ) {
    return {
      bucket: "quota",
      actionable: false,
      hint: "AI OCR (Gemini) の本日利用枠を超過 — JST 16:00 に自動リセット。または課金有効化で恒久解決",
    };
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
    quota: 0,
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
    quota: "AI OCR (Gemini) の本日利用枠超過 — JST 16:00 にリセット (または課金有効化)",
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
 * Round 13 ㉱: per-item の結果を流すコールバック型。
 * 各 1 件処理直後に呼ばれて、UI で「✓ スターバックス ¥980」のような
 * リアルタイム feedback を出せる。
 */
export interface ItemProgress {
  inboxId: string;
  ok: boolean;
  receiptId?: string;
  vendor?: string | null;
  amount?: number | null;
  error?: string;
}

/**
 * 受信箱の state='receipt' を全部仕訳化する。
 * @param onProgress (done, total, lastItem?) が各 1 件処理直後に呼ばれる。
 *                   lastItem は Round 13 ㉱ で追加: 直前に処理した 1 件の
 *                   詳細 (店名・金額・成否) を per-item streaming で流す
 */
export async function autoJournalizeAllReceipts(
  onProgress?: (done: number, total: number, lastItem?: ItemProgress) => void
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
    let lastItem: ItemProgress;
    try {
      // Round 23 ㊝: network/server エラーは 5 秒後に 1 回だけ自動リトライする。
      //   - 一過性のネットワーク不調・OCR サーバー 5xx で「失敗」マークされる前に救う
      //   - 既に attempts >= 2 の行は手動操作で来てるはずなので自動リトライしない
      //   - license/consent/image エラーはユーザ介入必須なのでリトライしない
      let receiptId: string | null = null;
      try {
        receiptId = await autoJournalizeOne(row);
      } catch (e1) {
        const msg1 = (e1 as Error).message;
        const cls = classifyOcrError(msg1);
        const isTransient = cls.bucket === "network" || cls.bucket === "server";
        if (isTransient && attempts <= 1) {
          console.info(
            `[auto-journal] ${cls.bucket} エラー — 5 秒後に 1 回自動リトライ: ${row.id}`,
          );
          await new Promise((r) => setTimeout(r, 5000));
          // attempts は 2 になる (autoJournalizeOne 自体は attempts を見ない)
          receiptId = await autoJournalizeOne({
            ...row,
            attempts: (row.attempts ?? 0) + 1,
          });
        } else {
          throw e1;
        }
      }
      result.imported++;
      // ㉱ 直近に保存された receipts 行から vendor / amount を引いて progress に
      let vendor: string | null = null;
      let amount: number | null = null;
      if (receiptId) {
        try {
          const { data: rr } = await db
            .from("receipts")
            .select("vendor_name, amount")
            .eq("id", receiptId)
            .single();
          const r = rr as { vendor_name: string | null; amount: number | null } | null;
          vendor = r?.vendor_name ?? null;
          amount = r?.amount ?? null;
        } catch {
          /* silent */
        }
      }
      lastItem = {
        inboxId: row.id,
        ok: true,
        receiptId: receiptId ?? undefined,
        vendor,
        amount,
      };
    } catch (e) {
      const msg = (e as Error).message;
      if (e instanceof AlreadyJournalizedError || journalizingInbox.has(row.id)) {
        // 一覧を取った後に別の経路で仕訳化された / いま別の操作で処理中。
        // 失敗ではないので状態は触らず、件数からも外す。
        result.total--;
        lastItem = { inboxId: row.id, ok: true };
      } else {
        result.failed++;
        result.errors.push(`${row.id}: ${msg}`);
        await db
          .from("photo_inbox")
          .update({
            state: "receipt_failed",
            last_error: msg.slice(0, 500),
            attempts,
          })
          .eq("id", row.id);
        lastItem = { inboxId: row.id, ok: false, error: msg };
      }
    }
    if (onProgress) onProgress(i + 1, rows.length, lastItem);
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
  // 取り込み済みの写真をもう一度仕訳化しない (以前はここを素通りして、
  // 同じ写真から領収書と仕訳がもう 1 組作られていた)
  if (row.state === "imported") throw new AlreadyJournalizedError();

  // state を 'receipt' に上げる (candidate / receipt_failed どちらでも OK)
  if (row.state !== "receipt") {
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
    // 「処理中」「既に仕訳化済み」は失敗ではない。状態を receipt_failed に落とすと
    // 仕訳化済みの写真が「失敗」タブに出てしまうので、そのまま呼び出し元へ返す
    if (e instanceof AlreadyJournalizedError || journalizingInbox.has(inboxId)) throw e;
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
// Round 26 ⓓ: 仕訳 bulk delete の undo 用スタック (本体 reverse とは別)
const BULK_DELETE_UNDO_KEY = "bulk_delete_undo_stack";
const BULK_DELETE_UNDO_MAX = 3;

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

type InboxLink = {
  id: string;
  state: string;
  imported_receipt_id: string | null;
  imported_at: string | null;
  last_error: string | null;
  attempts: number | null;
};

/** 受信箱由来ではない仕訳を受信箱に戻そうとした時のエラー。 */
export class NotFromInboxError extends Error {
  constructor() {
    super("受信箱の写真から作られた仕訳ではないため、受信箱には戻せません");
    this.name = "NotFromInboxError";
  }
}

/** 領収書を「取り込み済み」として指している受信箱行を引く (無ければ null)。 */
async function findInboxByReceipt(receiptId: string): Promise<InboxLink | null> {
  const { data, error } = await db
    .from("photo_inbox")
    .select("id, state, imported_receipt_id, imported_at, last_error, attempts")
    .eq("imported_receipt_id", receiptId)
    .single();
  if (error) throw error;
  return (data as InboxLink | null) ?? null;
}

/**
 * 与えた領収書 ID のうち、受信箱の写真から作られたもの (= 「受信箱に戻す」
 * 「AI OCR で再仕訳化」が意味を持つもの) を返す。一覧画面のボタン表示判定用。
 */
export async function receiptIdsFromInbox(receiptIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = Array.from(new Set(receiptIds.filter(Boolean)));
  for (let i = 0; i < ids.length; i += 400) {
    const { data, error } = await db
      .from("photo_inbox")
      .select("imported_receipt_id")
      .in("imported_receipt_id", ids.slice(i, i + 400));
    if (error) throw error;
    for (const row of (data as { imported_receipt_id: string | null }[] | null) ?? []) {
      if (row.imported_receipt_id) out.add(row.imported_receipt_id);
    }
  }
  return out;
}

/**
 * 仕訳を取り消して、紐付いていた受信箱行を「未判定」に戻す
 * (Round 4 ㊂ "差し戻し" フロー、Round 6 ㊍ で undo スタック対応)。
 *
 * 流れ:
 *   1. 受信箱由来の仕訳か確かめる (違えば **何も消さずに** NotFromInboxError)
 *   2. 削除対象 (journal / journal_lines / receipt / photo_inbox prev) を
 *      スナップショットで取得 → undo stack に push
 *   3. journal_lines → journals → receipts の順で削除
 *   4. photo_inbox を candidate に戻し imported_receipt_id / imported_at を null
 *      (claude_result_json は保持 — 利用者が修正した値の再利用に使う)
 *
 * 以前は 1 の確認が削除の **後** にあったため、領収書登録ページから作った仕訳
 * (受信箱とは無関係) でこのボタンを押すと、仕訳と領収書が消えた上で
 * 「受信箱由来ではありません」というエラーだけが出ていた。
 *
 * @returns 戻された inbox_id
 */
export async function reverseJournalToInbox(journalId: string): Promise<string> {
  // 1. 削除対象を全部取得 (snapshot)
  const { data: jdata, error: journalError } = await db
    .from("journals")
    .select("*")
    .eq("id", journalId)
    .single();
  if (journalError) throw journalError;
  const journal = jdata as Record<string, unknown> | null;
  if (!journal) throw new Error("対象の仕訳が見つかりません");
  const receiptId = (journal.receipt_id as string | null) ?? null;
  if (!receiptId) throw new NotFromInboxError();

  const inboxRow = await findInboxByReceipt(receiptId);
  if (!inboxRow) throw new NotFromInboxError();

  const { data: lines, error: linesError } = await db
    .from("journal_lines")
    .select("*")
    .eq("journal_id", journalId);
  if (linesError) throw linesError;
  const journalLines = (lines as Record<string, unknown>[] | null) ?? [];

  const { data: rdata, error: receiptError } = await db
    .from("receipts")
    .select("*")
    .eq("id", receiptId)
    .single();
  if (receiptError) throw receiptError;
  const receipt = rdata as Record<string, unknown> | null;

  // 同じ領収書を別の仕訳も参照している場合、領収書は消さない (証憑の再マッチングで
  // 1 枚の領収書が 2 つの仕訳に付くことがある。消すともう片方の仕訳の証憑が失われる)
  const { data: others, error: othersError } = await db
    .from("journals")
    .select("id")
    .eq("receipt_id", receiptId)
    .neq("id", journalId);
  if (othersError) throw othersError;
  const receiptShared = ((others as unknown[] | null) ?? []).length > 0;

  // 2. undo stack に push (size 上限超は古い順に捨てる)
  const stack = await getUndoStack();
  stack.unshift({
    ts: new Date().toISOString(),
    journal,
    journalLines,
    receipt: receiptShared ? null : receipt,
    inboxId: inboxRow.id,
    inboxPrev: {
      state: inboxRow.state,
      imported_receipt_id: inboxRow.imported_receipt_id,
      imported_at: inboxRow.imported_at,
      last_error: inboxRow.last_error,
      attempts: inboxRow.attempts,
    },
  });
  while (stack.length > UNDO_MAX) stack.pop();
  await setUndoStack(stack);

  // 3. 仕訳を削除 (journal_lines は ON DELETE CASCADE だが明示的に先に消す)
  await db.from("journal_lines").delete().eq("journal_id", journalId);
  const { error: deleteError } = await db.from("journals").delete().eq("id", journalId);
  if (deleteError) {
    // 仕訳が消せていないのにスナップショットだけ残すと、取り消しで二重になる
    await dropUndoSnapshotFor(journalId);
    throw deleteError;
  }

  // 4. 受信箱行を candidate に復帰 → 領収書を削除
  //    (先に受信箱の参照を外す。順序が逆だと FK の SET NULL 任せになり state が imported のまま残る)
  await db
    .from("photo_inbox")
    .update({
      state: "candidate",
      imported_receipt_id: null,
      imported_at: null,
      last_error: null,
      attempts: 0,
    })
    .eq("id", inboxRow.id);
  if (!receiptShared) {
    await db.from("receipts").delete().eq("id", receiptId);
  }

  return inboxRow.id;
}

/** undo stack から、指定した仕訳のスナップショットを取り除く。 */
async function dropUndoSnapshotFor(journalId: string): Promise<void> {
  const stack = await getUndoStack();
  const next = stack.filter((snap) => snap.journal.id !== journalId);
  if (next.length !== stack.length) await setUndoStack(next);
}

/**
 * Round 12 ㉭: 仕訳編集画面から「AI OCR で再仕訳化」を 1 クリックで。
 *
 * 流れ (元の仕訳を消すのは、新しい読み取り結果が手に入ってから):
 *   1. 受信箱由来の仕訳か確かめる (違えば何も変えずにエラー)
 *   2. presetOcr が無ければ AI OCR を実行する (同意・ライセンス・通信の失敗は
 *      ここで止まり、元の仕訳はそのまま残る)
 *   3. 元の仕訳を受信箱に戻す → 読み取り結果から新しい領収書・仕訳を作る
 *   4. 3 で失敗したら元の仕訳を復元する
 *
 * 以前は「先に消してから OCR」だったため、オフライン・枠切れ・同意なし等で OCR に
 * 失敗すると、仕訳と領収書が消えただけで終わっていた。
 *
 * @param opts.presetOcr 利用者が受信箱カードで修正した値。渡すと AI OCR を呼ばずに
 *   その値で作り直す (修正が新しい OCR 結果で上書きされない)。
 * @returns 新しい receipt_id
 */
export async function rejournalize(
  journalId: string,
  opts: { presetOcr?: OcrOutcome } = {},
): Promise<string> {
  const { data: jdata, error: journalError } = await db
    .from("journals")
    .select("id, receipt_id")
    .eq("id", journalId)
    .single();
  if (journalError) throw journalError;
  const journal = jdata as { id: string; receipt_id: string | null } | null;
  if (!journal) throw new Error("対象の仕訳が見つかりません");
  if (!journal.receipt_id) throw new NotFromInboxError();
  const link = await findInboxByReceipt(journal.receipt_id);
  if (!link) throw new NotFromInboxError();

  const { data: rowData, error: rowError } = await db
    .from("photo_inbox")
    .select("id, file_path, ocr_text, attempts")
    .eq("id", link.id)
    .single();
  if (rowError) throw rowError;
  const row = rowData as
    | { id: string; file_path: string | null; ocr_text: string | null; attempts: number | null }
    | null;
  if (!row) throw new Error("受信箱行が見つかりません");

  // 元の仕訳を消す前に、新しい読み取り結果を確保する
  let ocr = opts.presetOcr;
  let bytesSent = 0;
  if (!ocr) {
    const r = await runOcrForInbox(row);
    ocr = r.ocr;
    bytesSent = r.bytesSent;
  }

  await reverseJournalToInbox(journalId);
  let newReceiptId: string | null;
  try {
    newReceiptId = await autoJournalizeOne(row, { presetOcr: ocr });
    if (!newReceiptId) throw new Error("再仕訳化が空の結果を返しました");
  } catch (e) {
    // 新しい仕訳を作れなかった → 元の仕訳を戻す
    try {
      await undoLastReverse();
    } catch (undoError) {
      console.error("[rejournalize] 元の仕訳の復元に失敗:", undoError);
    }
    throw e;
  }

  // 作り直しに成功したので、元の仕訳のスナップショットは捨てる。
  // 残しておくと「直近の差し戻しを取り消す」で古い仕訳が新しい仕訳の隣に復活し、
  // 同じ経費が 2 回計上される。
  await dropUndoSnapshotFor(journalId);

  if (!opts.presetOcr) {
    await logAiOcr({
      inboxId: row.id,
      receiptId: newReceiptId,
      endpoint: "/api/ocr",
      bytesSent,
      resultSummary: `${ocr.vendor_name ?? "?"} ${ocr.amount ?? "?"}円 (再仕訳化)`,
    });
  }
  return newReceiptId;
}

/**
 * 直近の差し戻しを取り消して、journal/lines/receipt/photo_inbox を全部
 * 元に戻す (Round 6 ㊍).
 *
 * 差し戻した写真がその後もう一度仕訳化されている場合は復元しない (同じ写真の
 * 仕訳が 2 本になるため)。その時はスタックを消費せずにエラーを投げる。
 *
 * @returns { restored: true, journalId } もしくは { restored: false } (stack 空)
 */
export async function undoLastReverse(): Promise<
  { restored: true; journalId: string } | { restored: false }
> {
  const stack = await getUndoStack();
  const snap = stack[0];
  if (!snap) return { restored: false };
  const journalId = snap.journal.id as string;

  // 既に同じ仕訳が存在する (二重実行など) なら、スナップショットだけ捨てる
  const { data: existing, error: existingError } = await db
    .from("journals")
    .select("id")
    .eq("id", journalId)
    .single();
  if (existingError) throw existingError;
  if (existing) {
    await setUndoStack(stack.slice(1));
    return { restored: false };
  }

  if (snap.inboxId) {
    const { data: inboxData, error: inboxError } = await db
      .from("photo_inbox")
      .select("id, state, imported_receipt_id")
      .eq("id", snap.inboxId)
      .single();
    if (inboxError) throw inboxError;
    const inbox = inboxData as
      | { id: string; state: string; imported_receipt_id: string | null }
      | null;
    if (inbox && inbox.state === "imported" && inbox.imported_receipt_id) {
      throw new Error(
        "この写真は差し戻した後にもう一度仕訳化されています。取り消すと同じ写真の仕訳が 2 本になるため中止しました。" +
          "古い仕訳に戻したい時は、先に新しい仕訳を「受信箱に戻す」してから取り消してください。",
      );
    }
  }

  // 順番が大事: receipts 復元 → journals → journal_lines → photo_inbox
  // (FK でくくられている方を先に作る)。途中で失敗したら作った分を消して例外にする。
  let receiptInserted = false;
  let journalInserted = false;
  try {
    if (snap.receipt) {
      const { error } = await db.from("receipts").insert(snap.receipt);
      if (error) throw error;
      receiptInserted = true;
    }
    const { error: journalError } = await db.from("journals").insert(snap.journal);
    if (journalError) throw journalError;
    journalInserted = true;
    if (snap.journalLines.length > 0) {
      const { error: linesError } = await db.from("journal_lines").insert(snap.journalLines);
      if (linesError) throw linesError;
    }
    if (snap.inboxId && snap.inboxPrev) {
      const { error: inboxError } = await db
        .from("photo_inbox")
        .update({
          state: snap.inboxPrev.state,
          imported_receipt_id: snap.inboxPrev.imported_receipt_id,
          imported_at: snap.inboxPrev.imported_at,
          last_error: snap.inboxPrev.last_error,
          attempts: snap.inboxPrev.attempts,
        })
        .eq("id", snap.inboxId);
      if (inboxError) throw inboxError;
    }
  } catch (e) {
    if (journalInserted) await db.from("journals").delete().eq("id", journalId);
    if (receiptInserted && snap.receipt) {
      await db.from("receipts").delete().eq("id", snap.receipt.id as string);
    }
    throw e;
  }

  await setUndoStack(stack.slice(1));
  return { restored: true, journalId };
}

/**
 * receipt_failed 状態の写真を「もう一度試す」。state を 'receipt' に戻すだけ。
 * 直後に autoJournalizeAllReceipts を呼ぶか、UI の「領収書をすべて自動仕訳」を
 * 押すと、再度 AI OCR にかかる。
 */
export async function resetFailedToReceipt(inboxId: string): Promise<void> {
  // Round 28: attempts も 0 に戻して、auto-retry (network/server bucket) を
  // 再度発火できるようにする
  await db
    .from("photo_inbox")
    .update({ state: "receipt", last_error: null, attempts: 0 })
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
    .update({ state: "receipt", last_error: null, attempts: 0 })
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

// ────────────────────────────────────────────────────────────
// Round 26 ⓓ: 仕訳 bulk delete + Undo
//
// journals/page.tsx の bulk action toolbar から呼ぶ。複数仕訳 + 紐付く lines を
// 削除する前にスナップショットを撮って、Undo で復元できるようにする。
// reverse stack (UNDO_KEY) とは別の stack を使う (差し戻しと混ざらないため)。
// ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/**
 * 一括削除のスナップショット。
 *
 * 仕訳を消すと、それを参照している他のテーブルにも影響が出る (FK は SET NULL):
 *   - 明細取込の行 (bank_transactions) は「仕訳済」のまま参照だけ外れ、操作不能になる
 *   - 減価償却の記録 (fixed_asset_depreciations) が残り、その年を二度と仕訳化できなくなる
 *   - 受信箱の写真は「取り込み済み」のまま、仕訳の無い領収書だけが残る
 * そこで削除時にこれらを整合する状態へ直し、直す前の値をここに控えて、
 * 取り消し (undo) で元通りに戻せるようにする。
 *
 * journals / journal_lines 以外は後から足した項目なので、古いスナップショットには無い。
 */
interface BulkDeleteSnapshot {
  ts: string; // ISO
  journals: Row[];
  journal_lines: Row[];
  /** 一緒に削除した領収書 (受信箱由来で、他の仕訳から参照されていないもの) */
  receipts?: Row[];
  /** 削除はせず status だけ戻した領収書の、元の status */
  receiptStatus?: { id: string; status: string }[];
  /** 受信箱行の、元の状態 */
  inbox?: InboxLink[];
  /** 明細取込行の、元の状態 */
  bankTx?: { id: string; journal_id: string | null; status: string }[];
  /** 一緒に削除した減価償却の記録 */
  depreciations?: Row[];
  /** 家事按分ルールの、元の generated_journal_id */
  allocations?: { id: string; generated_journal_id: string | null }[];
  /** 請求書の、元の journal_id */
  invoices?: { id: string; journal_id: string | null }[];
}

async function getBulkDeleteUndoStack(): Promise<BulkDeleteSnapshot[]> {
  try {
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("id", BULK_DELETE_UNDO_KEY)
      .single();
    const raw = (data as { value?: string } | null)?.value;
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function setBulkDeleteUndoStack(stack: BulkDeleteSnapshot[]): Promise<void> {
  const value = JSON.stringify(stack);
  const updated_at = new Date().toISOString();
  const { data: existing } = await db
    .from("app_settings")
    .select("id")
    .eq("id", BULK_DELETE_UNDO_KEY)
    .single();
  if (existing) {
    await db
      .from("app_settings")
      .update({ value, updated_at })
      .eq("id", BULK_DELETE_UNDO_KEY);
  } else {
    await db
      .from("app_settings")
      .insert({ id: BULK_DELETE_UNDO_KEY, value, updated_at });
  }
}

export async function getBulkDeleteUndoCount(): Promise<number> {
  return (await getBulkDeleteUndoStack()).length;
}

/**
 * 複数の仕訳を一括削除。事前にスナップショットを undo stack に push する。
 * 仕訳を参照している明細取込・減価償却の記録・受信箱・領収書も整合する状態に直す。
 * @returns 実際に削除できた件数
 */
export async function bulkDeleteJournals(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  const snap: Required<BulkDeleteSnapshot> = {
    ts: new Date().toISOString(),
    journals: [],
    journal_lines: [],
    receipts: [],
    receiptStatus: [],
    inbox: [],
    bankTx: [],
    depreciations: [],
    allocations: [],
    invoices: [],
  };

  // ── スナップショット採取 (ここでは何も変更しない) ──
  type Plan = {
    id: string;
    receiptId: string | null;
    inbox: InboxLink | null;
    /** 領収書を一緒に消すか (受信箱由来で、他の仕訳が参照していない時) */
    deleteReceipt: boolean;
    /** 領収書を残して status を戻すか (受信箱由来でなく、他の仕訳が参照していない時) */
    resetReceiptStatus: boolean;
  };
  const plans: Plan[] = [];
  const idSet = new Set(ids);

  for (const id of ids) {
    const { data: j, error: jError } = await db.from("journals").select("*").eq("id", id).single();
    if (jError) throw jError;
    if (!j) continue; // 既に無い
    const journal = j as Row;
    const { data: lns, error: lError } = await db
      .from("journal_lines")
      .select("*")
      .eq("journal_id", id);
    if (lError) throw lError;
    snap.journals.push(journal);
    snap.journal_lines.push(...((lns as Row[] | null) ?? []));

    const plan: Plan = {
      id,
      receiptId: (journal.receipt_id as string | null) ?? null,
      inbox: null,
      deleteReceipt: false,
      resetReceiptStatus: false,
    };

    if (plan.receiptId) {
      // 今回消さない別の仕訳が同じ領収書を参照しているなら、領収書には触らない
      const { data: others, error: oError } = await db
        .from("journals")
        .select("id")
        .eq("receipt_id", plan.receiptId);
      if (oError) throw oError;
      const sharedWithSurvivor = ((others as { id: string }[] | null) ?? []).some(
        (o) => !idSet.has(o.id),
      );
      if (!sharedWithSurvivor) {
        const { data: r, error: rError } = await db
          .from("receipts")
          .select("*")
          .eq("id", plan.receiptId)
          .single();
        if (rError) throw rError;
        const receipt = r as Row | null;
        plan.inbox = await findInboxByReceipt(plan.receiptId);
        if (receipt) {
          const alreadyPlanned =
            snap.receipts.some((x) => x.id === receipt.id) ||
            snap.receiptStatus.some((x) => x.id === receipt.id);
          if (plan.inbox) {
            plan.deleteReceipt = true;
            if (!alreadyPlanned) {
              snap.receipts.push(receipt);
              snap.inbox.push(plan.inbox);
            }
          } else if (receipt.status === "confirmed") {
            plan.resetReceiptStatus = true;
            if (!alreadyPlanned) {
              snap.receiptStatus.push({ id: receipt.id as string, status: receipt.status as string });
            }
          }
        }
      }
    }

    const links = [
      ["bank_transactions", "journal_id", "id, journal_id, status"],
      ["fixed_asset_depreciations", "posted_journal_id", "*"],
      ["biz_allocations", "generated_journal_id", "id, generated_journal_id"],
      ["invoices", "journal_id", "id, journal_id"],
    ] as const;
    for (const [table, col, cols] of links) {
      const { data, error } = await db.from(table).select(cols).eq(col, id);
      if (error) throw error;
      const rows = (data as Row[] | null) ?? [];
      if (table === "bank_transactions") snap.bankTx.push(...(rows as Required<BulkDeleteSnapshot>["bankTx"]));
      else if (table === "fixed_asset_depreciations") snap.depreciations.push(...rows);
      else if (table === "biz_allocations") snap.allocations.push(...(rows as Required<BulkDeleteSnapshot>["allocations"]));
      else snap.invoices.push(...(rows as Required<BulkDeleteSnapshot>["invoices"]));
    }
    plans.push(plan);
  }
  if (plans.length === 0) return 0;

  // stack に push (古いものから捨てる)
  const stack = await getBulkDeleteUndoStack();
  stack.unshift(snap);
  while (stack.length > BULK_DELETE_UNDO_MAX) stack.pop();
  await setBulkDeleteUndoStack(stack);

  // ── 実削除 ──
  let deleted = 0;
  for (const plan of plans) {
    // 明細取込: 「未仕訳」に戻して、もう一度仕訳を作れるようにする
    await db
      .from("bank_transactions")
      .update({ status: "unmatched", journal_id: null })
      .eq("journal_id", plan.id);
    // 減価償却の記録: 残すと「その年は仕訳化済み」と判定され続け、二度と計上できなくなる
    await db.from("fixed_asset_depreciations").delete().eq("posted_journal_id", plan.id);

    await db.from("journal_lines").delete().eq("journal_id", plan.id);
    const { error } = await db.from("journals").delete().eq("id", plan.id);
    if (error) {
      console.warn(`bulkDeleteJournals delete ${plan.id} failed:`, error);
      continue;
    }
    deleted++;

    if (plan.receiptId && plan.deleteReceipt && plan.inbox) {
      // 受信箱の写真から作った仕訳: 写真を「未判定」に戻し、領収書は消す。
      // 「取り込み済み」のままにすると、仕訳が無いのに受信箱からは処理済みに見え、
      // その領収書を仕訳化し直す手段が無くなる。
      await db
        .from("photo_inbox")
        .update({
          state: "candidate",
          imported_receipt_id: null,
          imported_at: null,
          last_error: null,
          attempts: 0,
        })
        .eq("id", plan.inbox.id);
      await db.from("receipts").delete().eq("id", plan.receiptId);
    } else if (plan.receiptId && plan.resetReceiptStatus) {
      // 手動登録の領収書: 仕訳が無くなったので「確認済」から戻す
      await db.from("receipts").update({ status: "processed" }).eq("id", plan.receiptId);
    }
  }
  return deleted;
}

/**
 * 直近の bulk delete を取り消して、仕訳・明細と、削除時に直した関連データを元に戻す。
 * @returns 復元した仕訳件数 (0 なら stack 空)
 */
export async function undoBulkDelete(): Promise<{ restored: number }> {
  const stack = await getBulkDeleteUndoStack();
  if (stack.length === 0) return { restored: 0 };
  const snap = stack[0];

  // 領収書 → 仕訳 → 明細 の順 (FK の親から)
  const restoredReceipts = new Set<string>();
  for (const r of snap.receipts ?? []) {
    const { error } = await db.from("receipts").insert(r);
    if (error) console.warn("undoBulkDelete receipts.insert failed:", error);
    else restoredReceipts.add(r.id as string);
  }

  let restored = 0;
  const restoredJournals = new Set<string>();
  for (const j of snap.journals) {
    const { error } = await db.from("journals").insert(j);
    if (error) {
      console.warn("undoBulkDelete journals.insert failed:", error);
      continue;
    }
    restored++;
    restoredJournals.add(j.id as string);
  }
  for (const ln of snap.journal_lines) {
    if (!restoredJournals.has(ln.journal_id as string)) continue;
    const { error } = await db.from("journal_lines").insert(ln);
    if (error) console.warn("undoBulkDelete journal_lines.insert failed:", error);
  }

  // 関連データを削除前の状態へ (参照先の仕訳・領収書が戻せた行だけ)
  for (const ib of snap.inbox ?? []) {
    if (ib.imported_receipt_id && !restoredReceipts.has(ib.imported_receipt_id)) continue;
    // 削除後にその写真がもう一度仕訳化されていたら上書きしない
    const { data } = await db.from("photo_inbox").select("state").eq("id", ib.id).single();
    if ((data as { state?: string } | null)?.state === "imported") continue;
    await db
      .from("photo_inbox")
      .update({
        state: ib.state,
        imported_receipt_id: ib.imported_receipt_id,
        imported_at: ib.imported_at,
        last_error: ib.last_error,
        attempts: ib.attempts,
      })
      .eq("id", ib.id);
  }
  for (const rs of snap.receiptStatus ?? []) {
    await db.from("receipts").update({ status: rs.status }).eq("id", rs.id);
  }
  for (const tx of snap.bankTx ?? []) {
    if (!tx.journal_id || !restoredJournals.has(tx.journal_id)) continue;
    // 削除後に別の仕訳が作られている行は上書きしない
    const { data } = await db
      .from("bank_transactions")
      .select("journal_id")
      .eq("id", tx.id)
      .single();
    if ((data as { journal_id?: string | null } | null)?.journal_id) continue;
    await db
      .from("bank_transactions")
      .update({ status: tx.status, journal_id: tx.journal_id })
      .eq("id", tx.id);
  }
  for (const dep of snap.depreciations ?? []) {
    if (dep.posted_journal_id && !restoredJournals.has(dep.posted_journal_id as string)) continue;
    const { error } = await db.from("fixed_asset_depreciations").insert(dep);
    if (error) console.warn("undoBulkDelete fixed_asset_depreciations.insert failed:", error);
  }
  for (const al of snap.allocations ?? []) {
    if (!al.generated_journal_id || !restoredJournals.has(al.generated_journal_id)) continue;
    await db
      .from("biz_allocations")
      .update({ generated_journal_id: al.generated_journal_id })
      .eq("id", al.id);
  }
  for (const inv of snap.invoices ?? []) {
    if (!inv.journal_id || !restoredJournals.has(inv.journal_id)) continue;
    await db.from("invoices").update({ journal_id: inv.journal_id }).eq("id", inv.id);
  }

  await setBulkDeleteUndoStack(stack.slice(1));
  return { restored };
}
