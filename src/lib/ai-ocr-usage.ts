/**
 * AI OCR 使用量モニタ.
 *
 * 各 AI OCR コール (ocrWithClaude / ocrPurchaseOrder) を完了時にカウントして、
 * app_settings に月単位で集計を保持する。
 *
 * 表示:
 *   - 設定画面の AI 読み取りカード:「今月: 47 回 / 推定コスト ¥3」
 *   - 異常検知: 直近 1 時間で 100 件超なら warning toast
 *
 * 推定コスト (gemini-2.5-flash, 1 領収書あたり):
 *   - 入力: ~600 tok × $0.075/1M = $0.000045 ≈ 0.007 円
 *   - 出力: ~300 tok × $0.30/1M  = $0.000090 ≈ 0.014 円
 *   - 合計 ~0.021 円/回 (= 100 回で 2 円、1000 回で 21 円)
 */

import { db } from "./localDb";

const KEY_PREFIX = "ai_ocr_usage_";
/** 1 回あたりの推定コスト (円). 簡易: 0.02 円/回として固定. */
export const ESTIMATED_YEN_PER_CALL = 0.02;
/** 1 時間 100 件超で警告 */
const HOURLY_WARN_THRESHOLD = 100;

/** "YYYY-MM" 形式 */
function monthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

interface MonthlyRecord {
  /** 累計呼び出し回数 */
  count: number;
  /** 最終呼び出し ISO timestamp */
  last_at: string;
  /** 直近 60 件のタイムスタンプ unix (ミリ秒) — レート警告判定用 */
  recent_ts: number[];
}

async function readRecord(key: string): Promise<MonthlyRecord | null> {
  try {
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("id", key)
      .single();
    const raw = (data as { value?: string } | null)?.value;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.count === "number"
    ) {
      return {
        count: parsed.count,
        last_at: typeof parsed.last_at === "string" ? parsed.last_at : "",
        recent_ts: Array.isArray(parsed.recent_ts) ? parsed.recent_ts : [],
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeRecord(key: string, rec: MonthlyRecord): Promise<void> {
  const value = JSON.stringify(rec);
  const updated_at = new Date().toISOString();
  try {
    const { data } = await db
      .from("app_settings")
      .select("id")
      .eq("id", key)
      .single();
    if (data) {
      await db.from("app_settings").update({ value, updated_at }).eq("id", key);
    } else {
      await db.from("app_settings").insert({ id: key, value, updated_at });
    }
  } catch (e) {
    console.warn("[ai-ocr-usage] writeRecord failed:", e);
  }
}

/**
 * 成功 OCR コールごとに呼ぶ.
 * 警告閾値 (1 時間 100 件超) を返すので、呼び出し元で toast を出してもよい。
 */
export async function recordOcrCall(): Promise<{ overRate: boolean; rateCount: number }> {
  const key = `${KEY_PREFIX}${monthKey()}`;
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const rec = (await readRecord(key)) ?? {
    count: 0,
    last_at: "",
    recent_ts: [],
  };
  rec.count += 1;
  rec.last_at = new Date(now).toISOString();
  // recent_ts: 1 時間以内のものだけ保持、最大 200 件
  rec.recent_ts = [...rec.recent_ts.filter((t) => t > oneHourAgo), now].slice(-200);
  await writeRecord(key, rec);
  const rateCount = rec.recent_ts.length;
  return { overRate: rateCount > HOURLY_WARN_THRESHOLD, rateCount };
}

export interface UsageSummary {
  monthKey: string;
  count: number;
  estimatedYen: number;
  lastCallAt: Date | null;
}

/** 今月の集計を取得 */
export async function getThisMonthUsage(): Promise<UsageSummary> {
  const mk = monthKey();
  const rec = await readRecord(`${KEY_PREFIX}${mk}`);
  return {
    monthKey: mk,
    count: rec?.count ?? 0,
    estimatedYen: Math.round((rec?.count ?? 0) * ESTIMATED_YEN_PER_CALL * 10) / 10,
    lastCallAt: rec?.last_at ? new Date(rec.last_at) : null,
  };
}

/** 過去 6 か月の集計 (新しい順) */
export async function getRecentMonthlyUsage(months = 6): Promise<UsageSummary[]> {
  const out: UsageSummary[] = [];
  const now = new Date();
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mk = monthKey(d);
    const rec = await readRecord(`${KEY_PREFIX}${mk}`);
    out.push({
      monthKey: mk,
      count: rec?.count ?? 0,
      estimatedYen: Math.round((rec?.count ?? 0) * ESTIMATED_YEN_PER_CALL * 10) / 10,
      lastCallAt: rec?.last_at ? new Date(rec.last_at) : null,
    });
  }
  return out;
}
