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
