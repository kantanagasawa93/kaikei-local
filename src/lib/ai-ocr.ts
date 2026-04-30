/**
 * KAIKEI LOCAL のサーバ経由で Claude AI OCR を呼び出す。
 * ユーザはライセンスキーを入力して、サーバ側で API コスト・制限を管理する。
 */

import { suggestAccount } from "@/lib/accounts";
import { extractOcrFields, type PartialOcrFields } from "@/lib/partial-json";
import type { OcrResult } from "@/types";

// デフォルトのAPIベース（独自ドメインが紐付くまでは Vercel のURL）
const DEFAULT_API_BASE = "https://api.kaikei-local.com";

async function getApiBase(): Promise<string> {
  try {
    const { db } = await import("@/lib/localDb");
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("id", "api_base_override")
      .single();
    const override = (data as { value?: string } | null)?.value;
    if (override) return override;
  } catch {}
  return DEFAULT_API_BASE;
}

/**
 * サーバ経由で OCR 実行
 */
export async function ocrWithClaude(
  imageBase64: string,
  mediaType: string,
  licenseKey: string
): Promise<OcrResult & { usage?: { used: number; limit: number } }> {
  const base = await getApiBase();
  const response = await fetch(`${base}/api/ocr`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-License-Key": licenseKey,
    },
    body: JSON.stringify({
      image: imageBase64,
      media_type: mediaType,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "unknown" }));
    throw new Error(err.error || `API error (${response.status})`);
  }

  const json = await response.json();

  // 勘定科目を推測
  const combinedText = [
    json.vendor_name || "",
    ...(json.items || []),
    json.raw_text || "",
  ].join(" ");
  const suggested = suggestAccount(combinedText);

  return {
    raw_text: json.raw_text || "",
    vendor_name: json.vendor_name || null,
    amount: json.amount ? Number(json.amount) : null,
    date: json.date || null,
    suggested_account_code: suggested?.code || null,
    suggested_account_name: suggested?.name || null,
    usage: json.usage,
  };
}

/**
 * ストリーミング版 OCR。完了済みフィールドが取れる度に onPartial が呼ばれる。
 * Claude の text_delta を SSE で受け、partial-json で正規表現抽出する。
 *
 * UI 体感: 「保存」を押すまでに金額・店名・日付が見え始めるので、
 * 全部届くのを待たずにユーザがフォーム調整に入れる。
 */
export async function ocrWithClaudeStream(
  imageBase64: string,
  mediaType: string,
  licenseKey: string,
  onPartial?: (partial: PartialOcrFields) => void
): Promise<OcrResult & { usage?: { used: number; limit: number } }> {
  const base = await getApiBase();
  const response = await fetch(`${base}/api/ocr?stream=1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-License-Key": licenseKey,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      image: imageBase64,
      media_type: mediaType,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "unknown" }));
    throw new Error(err.error || `API error (${response.status})`);
  }
  if (!response.body) {
    throw new Error("ストリーム未対応のレスポンスでした");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let accumulated = "";
  let usage: { used: number; limit: number } | undefined;
  let lastEmitted = "";
  let serverError: string | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const events = buf.split("\n\n");
    buf = events.pop() || "";

    for (const evt of events) {
      const lines = evt.split("\n");
      const eventType = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
      const dataLine = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
      if (!eventType || !dataLine) continue;

      let payload: { text?: string; usage?: { used: number; limit: number }; error?: string } = {};
      try {
        payload = JSON.parse(dataLine);
      } catch {
        continue;
      }

      if (eventType === "chunk" && typeof payload.text === "string") {
        accumulated += payload.text;
        if (onPartial) {
          const partial = extractOcrFields(accumulated);
          const sig = JSON.stringify(partial);
          if (sig !== lastEmitted) {
            lastEmitted = sig;
            onPartial(partial);
          }
        }
      } else if (eventType === "done") {
        usage = payload.usage;
      } else if (eventType === "error") {
        serverError = payload.error || "ストリームでエラーが発生しました";
      }
    }
  }

  if (serverError) throw new Error(serverError);

  // 蓄積テキストから最終 JSON を抽出
  let finalParsed: Record<string, unknown> = {};
  try {
    const match = accumulated.match(/\{[\s\S]*\}/);
    if (match) finalParsed = JSON.parse(match[0]);
  } catch {
    // パース失敗。partial が取れていれば最低限の result を返す。
  }

  const items = Array.isArray(finalParsed.items) ? (finalParsed.items as string[]) : [];
  const combinedText = [
    (finalParsed.vendor_name as string) || "",
    ...items,
    (finalParsed.raw_text as string) || "",
  ].join(" ");
  const suggested = suggestAccount(combinedText);

  const amountRaw = finalParsed.amount;
  return {
    raw_text: (finalParsed.raw_text as string) || "",
    vendor_name: (finalParsed.vendor_name as string) || null,
    amount:
      typeof amountRaw === "number"
        ? amountRaw
        : amountRaw
          ? Number(amountRaw)
          : null,
    date: (finalParsed.date as string) || null,
    suggested_account_code: suggested?.code || null,
    suggested_account_name: suggested?.name || null,
    usage,
  };
}

/**
 * ライセンスキー検証
 */
export async function verifyLicense(licenseKey: string): Promise<{
  valid: boolean;
  status?: string;
  plan?: string;
  expires_at?: string;
  monthly_limit?: number;
  used_this_month?: number;
  reason?: string;
}> {
  const base = await getApiBase();
  const res = await fetch(`${base}/api/license/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ license_key: licenseKey }),
  });
  if (!res.ok) return { valid: false, reason: "network_error" };
  return res.json();
}

export function fileToBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const [header, base64] = dataUrl.split(",");
      const mediaType = header.match(/data:(.*);/)?.[1] || "image/jpeg";
      resolve({ base64, mediaType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * ライセンスキーをローカル DB に保存/読み込み
 */
export async function getLicenseKey(): Promise<string | null> {
  try {
    const { db } = await import("@/lib/localDb");
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("id", "license_key")
      .single();
    return (data as { value?: string } | null)?.value || null;
  } catch {
    return null;
  }
}

export async function saveLicenseKey(key: string): Promise<void> {
  const { db } = await import("@/lib/localDb");
  const { data: existing } = await db
    .from("app_settings")
    .select("id")
    .eq("id", "license_key")
    .single();
  if (existing) {
    await db
      .from("app_settings")
      .update({ value: key, updated_at: new Date().toISOString() })
      .eq("id", "license_key");
  } else {
    await db.from("app_settings").insert({
      id: "license_key",
      value: key,
      updated_at: new Date().toISOString(),
    });
  }
}

// 後方互換: 既存コードが getApiKey を参照している
export const getApiKey = getLicenseKey;
export const saveApiKey = saveLicenseKey;

/**
 * API サーバーが生きているか確認する。
 * 未デプロイだと AI OCR/ライセンス系機能が全滅するので、UI で
 * 「有料プラン準備中」と表示するために使う。
 *
 * 判定: HEAD or OPTIONS で 2xx/3xx が返れば生存。TypeError/timeout なら死亡。
 * 結果は 5分キャッシュ (頻繁に叩かない)。
 */
let _probeCache: { ok: boolean; at: number } | null = null;
const PROBE_TTL_MS = 5 * 60 * 1000;

export async function probeApiServer(): Promise<boolean> {
  const now = Date.now();
  if (_probeCache && now - _probeCache.at < PROBE_TTL_MS) return _probeCache.ok;
  const base = await getApiBase();
  try {
    // 3秒 timeout
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${base}/api/license/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: "__probe__" }),
      signal: controller.signal,
    });
    clearTimeout(t);
    // 401 でもサーバー生存なので OK
    const ok = res.status < 500;
    _probeCache = { ok, at: now };
    return ok;
  } catch {
    _probeCache = { ok: false, at: now };
    return false;
  }
}

// ──────────────────────────────────────────────────────────
// AI OCR データ送信同意フラグ
// ──────────────────────────────────────────────────────────
//
// 領収書画像を外部サーバー (api.kaikei-local.com 経由 Gemini) に送信するため、
// 初回に明示同意を取得する。app_settings.id="ai_ocr_consent" に "1" / "0" で保持。

const CONSENT_KEY = "ai_ocr_consent";

export async function hasAiOcrConsent(): Promise<boolean> {
  try {
    const { db } = await import("@/lib/localDb");
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("id", CONSENT_KEY)
      .single();
    return (data as { value?: string } | null)?.value === "1";
  } catch {
    return false;
  }
}

export async function setAiOcrConsent(consented: boolean): Promise<void> {
  const { db } = await import("@/lib/localDb");
  const value = consented ? "1" : "0";
  const { data: existing } = await db
    .from("app_settings")
    .select("id")
    .eq("id", CONSENT_KEY)
    .single();
  if (existing) {
    await db
      .from("app_settings")
      .update({ value, updated_at: new Date().toISOString() })
      .eq("id", CONSENT_KEY);
  } else {
    await db.from("app_settings").insert({
      id: CONSENT_KEY,
      value,
      updated_at: new Date().toISOString(),
    });
  }
}
