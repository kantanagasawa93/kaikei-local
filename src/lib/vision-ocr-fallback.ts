/**
 * Vision OCR フォールバック: AI OCR (Gemini) が 429 等で失敗した時、
 * 受信箱に既に取られている Vision OCR テキストから簡易ヒューリスティクスで
 * 領収書フィールドを抽出する。
 *
 * 完全失敗 (= 手入力強要) より遥かにマシ、確度は低いので
 *   - confidence: "low" として記録
 *   - 受信箱カードに「⚠️ Vision フォールバック (要確認)」バッジを出す予定
 * というスタンスで運用する。
 */

import type { OcrResult } from "@/types";
import { classifyReceiptLines } from "./receipt-classifier";

/** 日本円の金額っぽい文字列を整数化 */
function parseYen(s: string): number | null {
  const cleaned = s.replace(/[¥￥,，円]/g, "").trim();
  if (!/^\d+$/.test(cleaned)) return null;
  const n = parseInt(cleaned, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) return null;
  return n;
}

/** YYYY-MM-DD 形式に正規化 (和暦は無視、対応するなら後で拡張) */
function normalizeDate(s: string): string | null {
  // YYYY/MM/DD or YYYY-MM-DD or YYYY.MM.DD or YYYY年M月D日
  const m =
    /(\d{4})[\/年.\-](\d{1,2})[\/月.\-](\d{1,2})/.exec(s) ||
    /(20\d{2})(\d{2})(\d{2})/.exec(s);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 「合計 / total / 計」キーワードを含む行を高優先で金額抽出 */
function pickTotalAmount(lines: { line: string; kind: string }[]): number | null {
  const totalRe = /合\s*計|小\s*計|総\s*計|お支払|total|合計金額/i;
  const candidates: number[] = [];
  for (const ln of lines) {
    if (ln.kind !== "total" && !totalRe.test(ln.line)) continue;
    const yenMatches = ln.line.match(/[¥￥]?\s*([\d,，]{3,})/g) ?? [];
    for (const m of yenMatches) {
      const n = parseYen(m);
      if (n !== null) candidates.push(n);
    }
  }
  if (candidates.length === 0) return null;
  // 「合計」行の中で最大 = 税込合計の可能性大
  return Math.max(...candidates);
}

/** total が拾えなかった場合の保険: テキスト全体から最大の yen-like を返す */
function pickFallbackAmount(text: string): number | null {
  const matches = text.match(/[¥￥]?\s*([\d,，]{3,})/g) ?? [];
  const values: number[] = [];
  for (const m of matches) {
    const n = parseYen(m);
    if (n !== null) values.push(n);
  }
  if (values.length === 0) return null;
  return Math.max(...values);
}

/** Vendor 推定: classifier の vendor 行 → 先頭にあるもの */
function pickVendor(lines: { line: string; kind: string }[]): string | null {
  const vendor = lines.find((l) => l.kind === "vendor" && l.line.trim().length >= 2);
  if (vendor) return vendor.line.trim().slice(0, 60);
  // フォールバック: 1 番目の有意な行
  const first = lines.find((l) => l.line.trim().length >= 2);
  return first?.line.trim().slice(0, 60) ?? null;
}

/** Date 抽出 */
function pickDate(text: string, lines: { line: string; kind: string }[]): string | null {
  for (const ln of lines) {
    if (ln.kind === "date") {
      const d = normalizeDate(ln.line);
      if (d) return d;
    }
  }
  // 全体検索フォールバック
  return normalizeDate(text);
}

/**
 * Vision OCR テキストから OcrResult を組み立てる (suggestion なし、items なし).
 * confidence は低いが、手入力よりはずっと楽な「叩き台」を返す。
 */
export function buildFallbackOcrResult(visionText: string | null): OcrResult {
  if (!visionText || visionText.trim().length === 0) {
    return {
      raw_text: "",
      vendor_name: null,
      amount: null,
      date: null,
      suggested_account_code: null,
      suggested_account_name: null,
      items: [],
    };
  }

  const lines = classifyReceiptLines(visionText);
  const vendor = pickVendor(lines);
  const amount = pickTotalAmount(lines) ?? pickFallbackAmount(visionText);
  const date = pickDate(visionText, lines);

  return {
    raw_text: visionText,
    vendor_name: vendor,
    amount: amount,
    date: date,
    suggested_account_code: null,
    suggested_account_name: null,
    items: [],
  };
}

/**
 * エラーが「Gemini quota 系」かを判定する.
 * これに該当する時だけ Vision フォールバックを発動する (他のエラーは raw 通り throw)。
 */
export function isQuotaError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    /本日利用枠|本日.*超え|free.?tier|gemini.*quota|resource.?exhausted|429|api error \(429\)/i.test(
      msg,
    )
  );
}
