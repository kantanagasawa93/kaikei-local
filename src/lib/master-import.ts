/**
 * マスタデータ（勘定科目・取引先）の CSV インポート。
 * 主に freee からエクスポートした Shift-JIS CSV をサポート。
 */

import { db } from "@/lib/localDb";
import { DEFAULT_ACCOUNTS } from "@/lib/accounts";
import { decodeCsvBytes, parseCsvLines } from "@/lib/journal-import";

// -------------------------------------------------------------
// 勘定科目テーブルの初期シード
// -------------------------------------------------------------

export async function ensureAccountsSeeded(): Promise<number> {
  try {
    const { data } = await db.from("accounts").select("code");
    const existing = (data as { code: string }[] | null) || [];
    if (existing.length > 0) return existing.length;

    // 空なら DEFAULT_ACCOUNTS から挿入
    for (const a of DEFAULT_ACCOUNTS) {
      await db.from("accounts").insert({
        code: a.code,
        name: a.name,
        category: a.category,
        name_en: (a as { name_en?: string }).name_en || null,
        is_default: (a as { is_default?: boolean }).is_default ? 1 : 0,
      });
    }
    return DEFAULT_ACCOUNTS.length;
  } catch (e) {
    console.error("ensureAccountsSeeded failed:", e);
    return 0;
  }
}

// -------------------------------------------------------------
// freee 勘定科目 CSV (12列, Shift-JIS)
// 列: 勘定科目, 表示名（決算書）, 小分類, 中分類, 大分類,
//     収入取引相手方勘定科目, 支出取引相手方勘定科目, 税区分,
//     ショートカット1, ショートカット2, 入力候補, 補助科目優先タグ
// -------------------------------------------------------------

export interface ParsedAccount {
  name: string;                 // 勘定科目
  display_name: string | null;  // 表示名（決算書）
  sub_category: string | null;  // 小分類
  mid_category: string | null;  // 中分類
  parent_category: string | null; // 大分類
  tax_code: string | null;      // 税区分
  shortcut1: string | null;
  shortcut2: string | null;
  category: "asset" | "liability" | "equity" | "revenue" | "expense" | "other";
}

function categoryFromFreee(dai: string): ParsedAccount["category"] {
  if (dai.includes("資産")) return "asset";
  if (dai.includes("負債")) return "liability";
  if (dai.includes("純資産") || dai.includes("資本")) return "equity";
  if (dai.includes("収益") || dai.includes("収入") || dai.includes("売上")) return "revenue";
  if (dai.includes("費用") || dai.includes("経費")) return "expense";
  return "other";
}

export function parseFreeeAccountsCsv(rows: string[][]): ParsedAccount[] {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const findCol = (name: string) => header.findIndex((h) => h === name);
  const COL = {
    name: findCol("勘定科目"),
    display: findCol("表示名（決算書）"),
    sub: findCol("小分類"),
    mid: findCol("中分類"),
    parent: findCol("大分類"),
    tax: findCol("税区分"),
    s1: findCol("ショートカット1"),
    s2: findCol("ショートカット2"),
  };

  const out: ParsedAccount[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[COL.name] || "").trim();
    if (!name) continue;
    const parent = (r[COL.parent] || "").trim();
    out.push({
      name,
      display_name: (r[COL.display] || "").trim() || null,
      sub_category: (r[COL.sub] || "").trim() || null,
      mid_category: (r[COL.mid] || "").trim() || null,
      parent_category: parent || null,
      tax_code: (r[COL.tax] || "").trim() || null,
      shortcut1: (r[COL.s1] || "").trim() || null,
      shortcut2: (r[COL.s2] || "").trim() || null,
      category: categoryFromFreee(parent),
    });
  }
  return out;
}

/**
 * 勘定科目をDBに取り込む。
 * code は freee 側に無いため、既存の名称一致で code を再利用するか、
 * 新規は `A###` 形式で自動採番。
 */
export async function commitAccounts(
  parsed: ParsedAccount[],
  opts: { updateExisting?: boolean } = {}
): Promise<{ added: number; updated: number; skipped: number }> {
  await ensureAccountsSeeded(); // 既存がない場合はデフォルトを入れておく

  const { data: existing } = await db.from("accounts").select("code,name");
  const existingRows = (existing as { code: string; name: string }[] | null) || [];
  const byName = new Map(existingRows.map((a) => [a.name, a.code]));
  const allCodes = new Set(existingRows.map((a) => a.code));

  let nextAutoIdx = 900;
  const nextCode = (): string => {
    let c = `A${nextAutoIdx++}`;
    while (allCodes.has(c)) c = `A${nextAutoIdx++}`;
    allCodes.add(c);
    return c;
  };

  let added = 0, updated = 0, skipped = 0;

  for (const p of parsed) {
    const existingCode = byName.get(p.name);
    if (existingCode) {
      if (opts.updateExisting) {
        await db
          .from("accounts")
          .update({
            display_name: p.display_name,
            sub_category: p.sub_category,
            parent_category: p.parent_category,
            short_cut_1: p.shortcut1,
            short_cut_2: p.shortcut2,
            category: p.category,
          })
          .eq("code", existingCode);
        updated++;
      } else {
        skipped++;
      }
    } else {
      const code = nextCode();
      await db.from("accounts").insert({
        code,
        name: p.name,
        category: p.category,
        display_name: p.display_name,
        sub_category: p.sub_category,
        parent_category: p.parent_category,
        short_cut_1: p.shortcut1,
        short_cut_2: p.shortcut2,
        default_tax_code: p.tax_code,
        is_default: 0,
      });
      added++;
      byName.set(p.name, code);
    }
  }
  return { added, updated, skipped };
}

// -------------------------------------------------------------
// freee 取引先 CSV (56列, Shift-JIS)
// -------------------------------------------------------------

export interface ParsedPartner {
  name: string;
  name_kana: string | null;
  formal_name: string | null;
  registered_number: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  is_customer: boolean;
  is_vendor: boolean;
  notes: string | null;
}

export function parseFreeePartnersCsv(rows: string[][]): ParsedPartner[] {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const findCol = (name: string) => header.findIndex((h) => h === name);
  const COL = {
    name: findCol("名前（通称）"),
    formal: findCol("正式名称（帳票出力時に使用される名称）"),
    kana: findCol("カナ名称"),
    zip: findCol("郵便番号"),
    pref: findCol("都道府県"),
    city: findCol("市区町村・番地"),
    building: findCol("建物名・部屋番号など"),
    phone: findCol("電話番号"),
    email: findCol("営業担当者メールアドレス"),
    registered: findCol("適格請求書発行事業者の登録番号"),
    isCustomer: findCol("顧客として利用する"),
    isVendor: findCol("仕入先として利用する"),
  };

  const out: ParsedPartner[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[COL.name] || "").trim();
    if (!name) continue;
    const addressParts = [
      (r[COL.zip] || "").trim(),
      (r[COL.pref] || "").trim(),
      (r[COL.city] || "").trim(),
      (r[COL.building] || "").trim(),
    ].filter(Boolean);
    out.push({
      name,
      name_kana: (r[COL.kana] || "").trim() || null,
      formal_name: (r[COL.formal] || "").trim() || null,
      registered_number: (r[COL.registered] || "").trim() || null,
      phone: (r[COL.phone] || "").trim() || null,
      email: (r[COL.email] || "").trim() || null,
      address: addressParts.join(" ") || null,
      is_customer: /YES|はい|\bTRUE\b|する|有効/i.test(r[COL.isCustomer] || ""),
      is_vendor: /YES|はい|\bTRUE\b|する|有効/i.test(r[COL.isVendor] || ""),
      notes: null,
    });
  }
  return out;
}

export async function commitPartners(
  parsed: ParsedPartner[],
  opts: { updateExisting?: boolean } = {}
): Promise<{ added: number; updated: number; skipped: number }> {
  const { data: existing } = await db.from("partners").select("id,name");
  const existingRows = (existing as { id: string; name: string }[] | null) || [];
  const byName = new Map(existingRows.map((p) => [p.name, p.id]));

  let added = 0, updated = 0, skipped = 0;

  for (const p of parsed) {
    const existingId = byName.get(p.name);
    if (existingId) {
      if (opts.updateExisting) {
        await db
          .from("partners")
          .update({
            name_kana: p.name_kana,
            registered_number: p.registered_number,
            is_customer: p.is_customer ? 1 : 0,
            is_vendor: p.is_vendor ? 1 : 0,
            email: p.email,
            phone: p.phone,
            address: p.address,
          })
          .eq("id", existingId);
        updated++;
      } else {
        skipped++;
      }
    } else {
      await db.from("partners").insert({
        name: p.name,
        name_kana: p.name_kana,
        registered_number: p.registered_number,
        is_customer: p.is_customer ? 1 : 0,
        is_vendor: p.is_vendor ? 1 : 0,
        email: p.email,
        phone: p.phone,
        address: p.address,
        notes: p.notes,
      });
      added++;
    }
  }
  return { added, updated, skipped };
}

// -------------------------------------------------------------
// トップレベル helpers
// -------------------------------------------------------------

export async function readCsvFile(file: File): Promise<string[][]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = decodeCsvBytes(bytes);
  return parseCsvLines(text);
}
