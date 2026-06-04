/**
 * 受信箱 UI コンポーネント群で共有するユーティリティ.
 * (旧 src/app/(app)/inbox/page.tsx から切り出し)
 */

/** AI OCR 結果 JSON を編集モード用の string 3 つに分解 */
export function parseClaudeResult(json: string | null): {
  vendor_name: string;
  amount: string;
  date: string;
} {
  if (!json) return { vendor_name: "", amount: "", date: "" };
  try {
    const p = JSON.parse(json) as {
      vendor_name?: string;
      amount?: number;
      date?: string;
    };
    return {
      vendor_name: p.vendor_name ?? "",
      amount: p.amount != null ? String(p.amount) : "",
      date: p.date ?? "",
    };
  } catch {
    return { vendor_name: "", amount: "", date: "" };
  }
}
