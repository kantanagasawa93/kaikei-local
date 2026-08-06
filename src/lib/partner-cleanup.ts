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
