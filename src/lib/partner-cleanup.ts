// ────────────────────────────────────────────────────────────
// Round 28: AI OCR で抜き出した取引先を partners マスタに自動登録する.
//
// 既存と同名 (前後空白を除いた一致) の partner があればその ID を返し、
// 役割フラグ (is_customer / is_vendor) や address が未設定なら追記する。
// 無ければ新規 INSERT して [auto-learned] notes を付ける。
//
// - 領収書 OCR → vendor (買い手から見た売り手) → is_vendor=1
// - 発注書 OCR → customer (請求先) → is_customer=1
// 同じ会社が両方の役割を持つこともあるので、フラグは OR で立てる。
// ────────────────────────────────────────────────────────────

export interface FindOrCreatePartnerArgs {
  name: string | null;
  address?: string | null;
  isCustomer?: boolean;
  isVendor?: boolean;
  /** OCR 学習の出所 (notes に追記) — "OCR 領収書" / "OCR 発注書" 等 */
  source?: string;
  /** receipts.account_code 相当。partners.default_account_code に入れる */
  defaultAccountCode?: string | null;
}

const NAME_NOISE_RE = /^(不明|nil|null|none|n\/a|-+|\?+)$/i;
const AUTO_LEARNED_NOTE = "[auto-learned]";

export async function findOrCreatePartner(
  args: FindOrCreatePartnerArgs,
): Promise<string | null> {
  const rawName = (args.name ?? "").trim();
  if (rawName.length < 2 || rawName.length > 80) return null;
  if (NAME_NOISE_RE.test(rawName)) return null;

  const isCustomer = args.isCustomer ? 1 : 0;
  const isVendor = args.isVendor ? 1 : 0;

  // 既存検索 (完全一致)
  try {
    const { data } = await db
      .from("partners")
      .select("id, address, is_customer, is_vendor, notes")
      .eq("name", rawName)
      .single();
    const row = data as
      | {
          id: string;
          address: string | null;
          is_customer: number | null;
          is_vendor: number | null;
          notes: string | null;
        }
      | null;
    if (row?.id) {
      // 既存 partner: 役割フラグ / address を埋め足す (上書きはしない)
      const patch: Record<string, unknown> = {};
      if (isCustomer && !row.is_customer) patch.is_customer = 1;
      if (isVendor && !row.is_vendor) patch.is_vendor = 1;
      if (args.address && !row.address) patch.address = args.address;
      if (Object.keys(patch).length > 0) {
        try {
          await db.from("partners").update(patch).eq("id", row.id);
        } catch (e) {
          console.warn("findOrCreatePartner: update failed", e);
        }
      }
      return row.id;
    }
  } catch {
    // single() は 0 件で error — 下の INSERT に進む
  }

  // 新規 INSERT
  const id = crypto.randomUUID();
  const note = `${AUTO_LEARNED_NOTE} ${args.source ?? "OCR"} で初出 — レビューしてください`;
  try {
    await db.from("partners").insert({
      id,
      name: rawName,
      address: args.address ?? null,
      is_customer: isCustomer,
      is_vendor: isVendor,
      default_account_code: args.defaultAccountCode ?? null,
      notes: note,
    });
    return id;
  } catch (e) {
    // UNIQUE 違反など競合時は再 SELECT
    console.warn("findOrCreatePartner: insert failed:", e);
    try {
      const { data } = await db
        .from("partners")
        .select("id")
        .eq("name", rawName)
        .single();
      const row = data as { id: string } | null;
      return row?.id ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * Round 26 ㊣: 取引先 (partners) の自動掃除候補を検出する.
 *
 * Round 21 ⓕ で OCR から自動学習した partner が増えるので、
 * - 一度も使われてない (receipts.partner_id / journal_lines.partner_id 両方 0 件)
 * - 30 日以上前に追加された
 * - notes に [auto-learned] が残っている
 * これらは「実は誤読だった」「同じ店の表記揺れ」等で使われずに溜まっている。
 *
 * boot.tsx 起動時に 1 ヶ月に 1 回チェックし、N 件あれば toast.info で
 * 「取引先一覧で削除候補を確認」と促す。ユーザの作業を増やさないため
 * 削除自体は自動でやらない (誤削除リスク回避)。
 */

import { db } from "@/lib/localDb";
import { toast } from "@/lib/toast";

const SETTING_LAST_CHECK = "partner_cleanup_last_check_unix";
const AUTO_LEARNED_TAG = "[auto-learned]";

export interface PartnerCleanupResult {
  /** 削除候補の件数 (0 なら通知なし) */
  candidates: number;
  /** チェックを実行したか (24h 内なら false) */
  ran: boolean;
}

export async function checkPartnerCleanup(): Promise<PartnerCleanupResult> {
  const now = Math.floor(Date.now() / 1000);
  // 1 ヶ月に 1 回まで (前回チェックから 30 日以上経ってない時は skip)
  try {
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("id", SETTING_LAST_CHECK)
      .single();
    const last = parseInt((data as { value?: string } | null)?.value ?? "0", 10);
    if (now - last < 30 * 24 * 3600) {
      return { candidates: 0, ran: false };
    }
  } catch {
    /* 未設定 → 走らせる */
  }

  // すべての partners を取得
  const { data: ps } = await db
    .from("partners")
    .select("id, notes, created_at");
  const partners =
    (ps as { id: string; notes: string | null; created_at: string }[] | null) ?? [];

  // 30 日以上前の auto-learned partner だけ抽出
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const autoOld = partners.filter(
    (p) =>
      p.notes &&
      p.notes.includes(AUTO_LEARNED_TAG) &&
      p.created_at &&
      p.created_at < cutoff,
  );
  if (autoOld.length === 0) {
    await markChecked(now);
    return { candidates: 0, ran: true };
  }

  // 使用回数を集計 (両テーブル合算)
  const usage = new Map<string, number>();
  try {
    const { data: rec } = await db.from("receipts").select("partner_id");
    for (const r of (rec as { partner_id: string | null }[] | null) ?? []) {
      if (r.partner_id) usage.set(r.partner_id, (usage.get(r.partner_id) ?? 0) + 1);
    }
    const { data: jl } = await db.from("journal_lines").select("partner_id");
    for (const r of (jl as { partner_id: string | null }[] | null) ?? []) {
      if (r.partner_id) usage.set(r.partner_id, (usage.get(r.partner_id) ?? 0) + 1);
    }
  } catch {
    /* DB 取得失敗 → 全部「不明」扱いだが、誤判定でユーザに通知してしまうので safe 側 (skip) */
    await markChecked(now);
    return { candidates: 0, ran: true };
  }

  const candidates = autoOld.filter((p) => (usage.get(p.id) ?? 0) === 0);
  await markChecked(now);

  if (candidates.length > 0) {
    // toast.info で控えめに通知 (ユーザが押さなくてもいい、押せば一覧へ)
    try {
      toast.info(
        `OCR 学習で増えた取引先 ${candidates.length} 件が一度も使われていません — 取引先一覧で確認 (右上 → 取引先 → 「自動学習のみ」)`,
      );
    } catch {
      /* toast 失敗は致命的ではない */
    }
  }

  return { candidates: candidates.length, ran: true };
}

async function markChecked(unix: number): Promise<void> {
  const value = String(unix);
  const updated_at = new Date().toISOString();
  const { data } = await db
    .from("app_settings")
    .select("id")
    .eq("id", SETTING_LAST_CHECK)
    .single();
  if (data) {
    await db
      .from("app_settings")
      .update({ value, updated_at })
      .eq("id", SETTING_LAST_CHECK);
  } else {
    await db.from("app_settings").insert({ id: SETTING_LAST_CHECK, value, updated_at });
  }
}

// ────────────────────────────────────────────────────────────
// Round 27 ⓐ: partner 名の表記ゆれ自動検出
//
// 「タリーズコーヒー トリアス久山店」「タリーズコーヒー」「タリーズ」のように
// 共通 prefix が長い partner ペアを検出して「同一かも」と提案する。
//
// 完全自動マージは誤統合リスクが高いので、検出だけして UI で「統合する?」
// ボタンを出す。
// ────────────────────────────────────────────────────────────

export interface PartnerVariantPair {
  /** 短い名前 (= 元の partner、ID とともに残す候補) */
  base: { id: string; name: string; usage: number };
  /** 長い名前 (= マージ先候補) */
  variant: { id: string; name: string; usage: number };
  /** 一致した共通 prefix の文字数 */
  prefixLen: number;
}

/** 漢字・ひらがな・カタカナ・英字の混在を考慮した「先頭一致長」を計算 */
function commonPrefixLen(a: string, b: string): number {
  const min = Math.min(a.length, b.length);
  let i = 0;
  while (i < min && a[i] === b[i]) i++;
  return i;
}

/**
 * partner 一覧から表記ゆれ候補のペアを検出する.
 *
 * 条件 (誤統合を最小化するため):
 *   - 共通 prefix が 4 文字以上 (= 「タリーズ」レベル)
 *   - 短い方の長さの 60% 以上を共通 prefix が占める
 *   - 短い方が 2 文字以下なら除外 ("AB" + "ABC" のような誤検知防止)
 *
 * @param partners {id, name} のリスト
 * @param usageMap 使用回数マップ (partner_id → count)
 * @returns 検出されたペア (重複は除外)
 */
export function detectPartnerVariants(
  partners: { id: string; name: string }[],
  usageMap: Record<string, number>,
): PartnerVariantPair[] {
  const out: PartnerVariantPair[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < partners.length; i++) {
    for (let j = i + 1; j < partners.length; j++) {
      const a = partners[i];
      const b = partners[j];
      const shorter = a.name.length <= b.name.length ? a : b;
      const longer = a.name.length <= b.name.length ? b : a;
      if (shorter.name.length < 3) continue;
      const prefixLen = commonPrefixLen(shorter.name, longer.name);
      if (prefixLen < 4) continue;
      if (prefixLen / shorter.name.length < 0.6) continue;
      const key = [shorter.id, longer.id].sort().join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        base: {
          id: shorter.id,
          name: shorter.name,
          usage: usageMap[shorter.id] ?? 0,
        },
        variant: {
          id: longer.id,
          name: longer.name,
          usage: usageMap[longer.id] ?? 0,
        },
        prefixLen,
      });
    }
  }
  // 共通 prefix が長い順 (信頼度高い順)
  out.sort((a, b) => b.prefixLen - a.prefixLen);
  return out;
}

// ────────────────────────────────────────────────────────────
// Round 28 ⓑ: partner 統合 (variant → base) + Undo
//
// mergeVariantPair の本体をここに移し、統合前にスナップショット (variant の
// partner 行 + 書き換えた receipts / journal_lines の id 一覧) を app_settings の
// undo stack に push する。誤統合を取り消せるようにするため。
// ────────────────────────────────────────────────────────────

const PARTNER_MERGE_UNDO_KEY = "partner_merge_undo_stack";
const PARTNER_MERGE_UNDO_MAX = 5;

interface PartnerMergeSnapshot {
  ts: string;
  variant: Record<string, unknown>; // 削除した partner 行 (全カラム)
  baseName: string;
  variantName: string;
  receiptIds: string[]; // partner_id を base に書き換えた receipts.id
  journalLineIds: string[]; // 同 journal_lines.id
}

async function getMergeUndoStack(): Promise<PartnerMergeSnapshot[]> {
  try {
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("id", PARTNER_MERGE_UNDO_KEY)
      .single();
    const raw = (data as { value?: string } | null)?.value;
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function setMergeUndoStack(stack: PartnerMergeSnapshot[]): Promise<void> {
  const value = JSON.stringify(stack);
  const updated_at = new Date().toISOString();
  const { data: existing } = await db
    .from("app_settings")
    .select("id")
    .eq("id", PARTNER_MERGE_UNDO_KEY)
    .single();
  if (existing) {
    await db
      .from("app_settings")
      .update({ value, updated_at })
      .eq("id", PARTNER_MERGE_UNDO_KEY);
  } else {
    await db
      .from("app_settings")
      .insert({ id: PARTNER_MERGE_UNDO_KEY, value, updated_at });
  }
}

export async function getPartnerMergeUndoCount(): Promise<number> {
  return (await getMergeUndoStack()).length;
}

/**
 * variant partner を base partner に統合する.
 * receipts / journal_lines の partner_id を base に書き換え、variant 行を削除。
 * 実行前にスナップショットを undo stack に push する。
 */
export async function mergePartnerVariant(args: {
  variantId: string;
  baseId: string;
  variantName: string;
  baseName: string;
}): Promise<void> {
  const { variantId, baseId, variantName, baseName } = args;

  // variant の partner 行を丸ごと取得 (Undo で復元するため)
  const { data: vRow } = await db
    .from("partners")
    .select("*")
    .eq("id", variantId)
    .single();
  if (!vRow) throw new Error("統合元の取引先が見つかりません");

  // 書き換え対象の id を収集
  const { data: rec } = await db
    .from("receipts")
    .select("id")
    .eq("partner_id", variantId);
  const receiptIds = ((rec as { id: string }[] | null) ?? []).map((r) => r.id);
  const { data: jl } = await db
    .from("journal_lines")
    .select("id")
    .eq("partner_id", variantId);
  const journalLineIds = ((jl as { id: string }[] | null) ?? []).map((r) => r.id);

  // スナップショットを push
  const stack = await getMergeUndoStack();
  stack.unshift({
    ts: new Date().toISOString(),
    variant: vRow as Record<string, unknown>,
    baseName,
    variantName,
    receiptIds,
    journalLineIds,
  });
  while (stack.length > PARTNER_MERGE_UNDO_MAX) stack.pop();
  await setMergeUndoStack(stack);

  // 書き換え + 削除
  for (const id of receiptIds) {
    await db.from("receipts").update({ partner_id: baseId }).eq("id", id);
  }
  for (const id of journalLineIds) {
    await db.from("journal_lines").update({ partner_id: baseId }).eq("id", id);
  }
  await db.from("partners").delete().eq("id", variantId);
}

/**
 * 直近の partner 統合を取り消す.
 * @returns 復元した取引先名 (null なら stack 空)
 */
export async function undoPartnerMerge(): Promise<{
  restored: { variantName: string; baseName: string } | null;
}> {
  const stack = await getMergeUndoStack();
  if (stack.length === 0) return { restored: null };
  const snap = stack.shift()!;
  await setMergeUndoStack(stack);

  // variant partner 行を復元
  try {
    await db.from("partners").insert(snap.variant);
  } catch (e) {
    console.warn("undoPartnerMerge: partners.insert failed", e);
  }
  const variantId = (snap.variant as { id?: string }).id;
  if (variantId) {
    for (const id of snap.receiptIds) {
      await db.from("receipts").update({ partner_id: variantId }).eq("id", id);
    }
    for (const id of snap.journalLineIds) {
      await db.from("journal_lines").update({ partner_id: variantId }).eq("id", id);
    }
  }
  return { restored: { variantName: snap.variantName, baseName: snap.baseName } };
}
