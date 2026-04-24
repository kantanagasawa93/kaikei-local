/**
 * KAIKEI LOCAL のサーバ経由で Claude AI OCR を呼び出す。
 * ユーザはライセンスキーを入力して、サーバ側で API コスト・制限を管理する。
 */

import { suggestAccount } from "@/lib/accounts";
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
