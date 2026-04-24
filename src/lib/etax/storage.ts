/**
 * TaxpayerInfo を app_settings テーブルに永続化するラッパ。
 *
 * 保存形式: id = "taxpayer_info", value = JSON 文字列化した TaxpayerInfo
 *
 * 利用者識別番号を含むため、バックアップ範囲 (kaikei.db) には入るが、
 * ネットワーク送信はしない (ローカルのみ)。
 */

import type { TaxpayerInfo } from "./types";

const STORAGE_KEY = "taxpayer_info";

/**
 * TaxpayerInfo を読み出す。未登録なら null。
 */
export async function loadTaxpayerInfo(): Promise<TaxpayerInfo | null> {
  const { db } = await import("@/lib/localDb");
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("id", STORAGE_KEY)
    .single();
  const raw = (data as { value?: string } | null)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TaxpayerInfo;
  } catch {
    return null;
  }
}

/**
 * TaxpayerInfo を保存。既存行があれば update、無ければ insert。
 */
export async function saveTaxpayerInfo(info: TaxpayerInfo): Promise<void> {
  const { db } = await import("@/lib/localDb");
  const value = JSON.stringify(info);
  const { data: existing } = await db
    .from("app_settings")
    .select("id")
    .eq("id", STORAGE_KEY)
    .single();
  if (existing) {
    await db
      .from("app_settings")
      .update({ value, updated_at: new Date().toISOString() })
      .eq("id", STORAGE_KEY);
  } else {
    await db
      .from("app_settings")
      .insert({
        id: STORAGE_KEY,
        value,
        updated_at: new Date().toISOString(),
      });
  }
}

/**
 * 空の TaxpayerInfo テンプレート。新規入力フォームの初期値に使う。
 */
export function emptyTaxpayerInfo(): TaxpayerInfo {
  return {
    zeimusho_cd: "",
    zeimusho_nm: "",
    name: "",
    name_kana: "",
    birthday_wareki: { era: "昭和", yy: 60, mm: 1, dd: 1 },
    postal_code: "",
    address: "",
    phone: "",
    riyosha_shikibetsu_bango: "",
  };
}
