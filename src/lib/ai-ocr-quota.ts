/**
 * Round 28: AI OCR (Gemini Free Tier) の本日利用枠超過を記録 / 復旧判定する.
 *
 * api-server が 429 RESOURCE_EXHAUSTED を返した時、クライアント側で
 * app_settings.ai_ocr_quota_exhausted_at に timestamp を記録する。
 * 受信箱 / 設定 等の主要画面でバナー表示し、ユーザに「明日のリセットを待つ
 * か、課金を有効化するか」を案内する。
 *
 * Gemini Free Tier の日次クォータは Pacific Time の 0:00 にリセットされる。
 * PDT (3-11月) なら JST 16:00、PST (11-3月) なら JST 17:00。
 * 簡易のため JST 16:00 で固定する (PST の時は +1 時間早く判定されるが、
 * その時刻に再試行して 429 ならまだ残ってないのでもう少し待つ、で実用上問題なし)。
 */

import { db } from "./localDb";

const KEY = "ai_ocr_quota_exhausted_at";

/** 429 を受けた時に呼ぶ. timestamp (ISO) を app_settings に保存 */
export async function markQuotaExhausted(): Promise<void> {
  const now = new Date().toISOString();
  try {
    const { data } = await db
      .from("app_settings")
      .select("id")
      .eq("id", KEY)
      .single();
    if (data) {
      await db.from("app_settings").update({ value: now, updated_at: now }).eq("id", KEY);
    } else {
      await db.from("app_settings").insert({ id: KEY, value: now, updated_at: now });
    }
  } catch (e) {
    // 失敗してもアプリ全体を止めない
    console.warn("[ai-ocr-quota] markQuotaExhausted failed:", e);
  }
}

/** 成功時に呼ぶ (枠が復活した証拠なのでバナーを消す) */
export async function clearQuotaExhausted(): Promise<void> {
  try {
    await db.from("app_settings").delete().eq("id", KEY);
  } catch {
    /* silent */
  }
}

/**
 * 次の Gemini Free Tier リセット時刻 (JST 16:00 = PT 0:00 in PDT).
 * 与えられた基準時刻がまだ今日の 16:00 前ならその日の 16:00、
 * 過ぎていれば翌日の 16:00 を返す。
 */
export function nextResetTime(now: Date = new Date()): Date {
  const next = new Date(now);
  next.setHours(16, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

export interface QuotaState {
  /** 上限超過の状態か */
  exhausted: boolean;
  /** 超過を検知した時刻 (ISO) */
  exhaustedAt?: Date;
  /** 次のリセット時刻 */
  nextReset?: Date;
  /** リセットまで残り時間 (時間単位、小数あり) */
  hoursUntilReset?: number;
}

/**
 * 現在の quota 状態を取得.
 * exhaustedAt 以後のリセット時刻を過ぎていれば自動的に枠を解放した扱いにする。
 */
export async function getQuotaState(now: Date = new Date()): Promise<QuotaState> {
  try {
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("id", KEY)
      .single();
    const raw = (data as { value?: string } | null)?.value;
    if (!raw) return { exhausted: false };
    const ts = new Date(raw);
    if (isNaN(ts.getTime())) return { exhausted: false };
    // 「ts 時点」の次のリセットを基準にする
    const reset = nextResetTime(ts);
    if (now >= reset) {
      // リセット時刻を過ぎた → 自動クリア
      await clearQuotaExhausted();
      return { exhausted: false };
    }
    const hoursLeft = (reset.getTime() - now.getTime()) / 3600000;
    return {
      exhausted: true,
      exhaustedAt: ts,
      nextReset: reset,
      hoursUntilReset: hoursLeft,
    };
  } catch {
    return { exhausted: false };
  }
}
