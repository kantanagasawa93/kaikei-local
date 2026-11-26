import { describe, it, expect } from "vitest";
import {
  classifyGeminiFailure,
  CREDITS_DEPLETED_MESSAGE,
  DAILY_QUOTA_MESSAGE,
  GENERIC_UPSTREAM_MESSAGE,
} from "../../api-server/lib/gemini-errors";
import { GEMINI_MODEL, extractionGenerationConfig } from "../../api-server/lib/gemini-config";
import { classifyOcrError } from "@/lib/auto-journal";
import { isQuotaError } from "@/lib/vision-ocr-fallback";

describe("Gemini の呼び出し設定 — モデル ID と thinking の指定は組で変える", () => {
  // 2026-11-26 に実際のリクエストで確かめた組み合わせ:
  //   gemini-3.5-flash-lite + thinkingBudget: 0   → 400 (invalid argument)
  //   gemini-3.5-flash-lite + thinkingLevel       → 200
  //   gemini-2.5-flash      + thinkingLevel       → 400 (not supported for this model)
  // 2.5-flash へのリクエストは 2026-12-01 から 3.5-flash-lite に回されるので、2.5 用の指定を残すと全滅する。
  const config = extractionGenerationConfig(4096) as Record<string, unknown>;

  it("Gemini 3.x のモデルには thinkingBudget を送らない", () => {
    expect(GEMINI_MODEL).toBe("gemini-3.5-flash-lite");
    expect(config.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(JSON.stringify(config)).not.toContain("thinkingBudget");
  });

  it("廃止予定の sampling パラメータを送らず、JSON だけを返させる", () => {
    expect(config).not.toHaveProperty("temperature");
    expect(config).not.toHaveProperty("topP");
    expect(config).not.toHaveProperty("topK");
    expect(config.responseMimeType).toBe("application/json");
    expect(config.maxOutputTokens).toBe(4096);
  });
});

// 2026-11-26 に本番で実際に返ってきた本文 (前払いクレジット切れ)
const DEPLETED_BODY = JSON.stringify({
  error: {
    code: 402,
    message:
      "Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.",
    status: "RESOURCE_EXHAUSTED",
  },
});

describe("classifyGeminiFailure — 上流 (Gemini) のエラーを利用者向けに変換", () => {
  it("前払いクレジット切れ (402) は 503 + 原因が分かる文言", () => {
    const f = classifyGeminiFailure(402, DEPLETED_BODY);
    expect(f).toEqual({
      status: 503,
      code: "upstream_credits_depleted",
      error: CREDITS_DEPLETED_MESSAGE,
    });
    expect(f.error).toContain("利用残高");
  });

  it("同じ内容が 429 で返ってきても「本日の枠切れ」と案内しない", () => {
    const f = classifyGeminiFailure(429, DEPLETED_BODY);
    expect(f.code).toBe("upstream_credits_depleted");
    expect(f.status).toBe(503);
  });

  it("当日枠切れ (429) は従来どおり", () => {
    const body = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } });
    expect(classifyGeminiFailure(429, body)).toEqual({
      status: 429,
      code: "upstream_daily_quota",
      error: DAILY_QUOTA_MESSAGE,
    });
  });

  it("それ以外は従来どおり 502", () => {
    expect(classifyGeminiFailure(500, "internal")).toEqual({
      status: 502,
      code: "upstream_error",
      error: GENERIC_UPSTREAM_MESSAGE,
    });
    expect(classifyGeminiFailure(400, "")).toMatchObject({ status: 502, code: "upstream_error" });
  });
});

describe("配布済みのアプリが、新しい文言を別の原因と取り違えない", () => {
  // アプリはサーバの文言を正規表現で分類する。残高切れの文言が「本日の枠切れ (16 時に復活)」
  // 「ライセンスの上限」「ネットワーク不調」などに分類されると、利用者に誤った対処を案内してしまう。
  it("残高切れの文言は quota / license / consent / network / image / server のどれにも入らない", () => {
    expect(classifyOcrError(CREDITS_DEPLETED_MESSAGE).bucket).toBe("unknown");
  });

  it("残高切れは当日枠切れ扱いにならない (16 時に復活するという案内を出さない)", () => {
    expect(isQuotaError(new Error(CREDITS_DEPLETED_MESSAGE))).toBe(false);
  });

  it("当日枠切れの文言は、これまでどおり quota に分類される", () => {
    expect(classifyOcrError(DAILY_QUOTA_MESSAGE).bucket).toBe("quota");
    expect(isQuotaError(new Error(DAILY_QUOTA_MESSAGE))).toBe(true);
  });
});
