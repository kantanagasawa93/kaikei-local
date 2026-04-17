import { suggestAccount } from "./accounts";

export interface ParsedTransaction {
  date: string;
  description: string;
  amount: number;
  is_income: boolean;
  balance_after: number | null;
  suggested_account_code: string | null;
  suggested_account_name: string | null;
}

// CSV文字列をパースして取引データに変換
export function parseCSV(csvText: string): string[][] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  return lines.map((line) => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  });
}

// 銀行口座CSV（一般的な形式）
export function parseBankCSV(csvText: string): ParsedTransaction[] {
  const rows = parseCSV(csvText);
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.toLowerCase());
  const dateIdx = header.findIndex((h) => h.includes("日付") || h.includes("date") || h.includes("取引日"));
  const descIdx = header.findIndex((h) => h.includes("摘要") || h.includes("内容") || h.includes("description") || h.includes("取引内容"));
  const depositIdx = header.findIndex((h) => h.includes("入金") || h.includes("お預り") || h.includes("deposit") || h.includes("credit"));
  const withdrawalIdx = header.findIndex((h) => h.includes("出金") || h.includes("お引出") || h.includes("withdrawal") || h.includes("debit"));
  const balanceIdx = header.findIndex((h) => h.includes("残高") || h.includes("balance"));

  // 必須カラムの検証
  if (dateIdx === -1 || descIdx === -1) {
    console.warn("CSVに必須カラム（日付、摘要）が見つかりません。ヘッダー:", header);
    return [];
  }
  if (depositIdx === -1 && withdrawalIdx === -1) {
    console.warn("CSVに金額カラム（入金/出金）が見つかりません。ヘッダー:", header);
    return [];
  }

  return rows.slice(1)
    .filter((row) => row.length > Math.max(dateIdx, descIdx))
    .map((row) => {
      const description = row[descIdx] || "";
      const deposit = depositIdx >= 0 ? parseAmount(row[depositIdx]) : 0;
      const withdrawal = withdrawalIdx >= 0 ? parseAmount(row[withdrawalIdx]) : 0;
      const amount = deposit > 0 ? deposit : -withdrawal;
      const suggestion = suggestAccount(description);

      return {
        date: normalizeDate(row[dateIdx] || ""),
        description,
        amount: Math.abs(amount),
        is_income: amount > 0,
        balance_after: balanceIdx >= 0 ? parseAmount(row[balanceIdx]) : null,
        suggested_account_code: suggestion?.code ?? null,
        suggested_account_name: suggestion?.name ?? null,
      };
    })
    .filter((t) => t.description && t.date);
}

// クレジットカードCSV
export function parseCreditCardCSV(csvText: string): ParsedTransaction[] {
  const rows = parseCSV(csvText);
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.toLowerCase());
  const dateIdx = header.findIndex((h) => h.includes("日付") || h.includes("利用日") || h.includes("date"));
  const descIdx = header.findIndex((h) => h.includes("利用先") || h.includes("摘要") || h.includes("内容") || h.includes("description") || h.includes("店名"));
  const amountIdx = header.findIndex((h) => h.includes("金額") || h.includes("利用金額") || h.includes("amount"));

  if (dateIdx === -1 || descIdx === -1 || amountIdx === -1) {
    console.warn("CSVに必須カラム（日付、利用先、金額）が見つかりません。ヘッダー:", header);
    return [];
  }

  return rows.slice(1)
    .filter((row) => row.length > Math.max(dateIdx, descIdx, amountIdx))
    .map((row) => {
      const description = row[descIdx] || "";
      const amount = parseAmount(row[amountIdx]);
      const suggestion = suggestAccount(description);

      return {
        date: normalizeDate(row[dateIdx] || ""),
        description,
        amount: Math.abs(amount),
        is_income: false,
        balance_after: null,
        suggested_account_code: suggestion?.code ?? null,
        suggested_account_name: suggestion?.name ?? null,
      };
    })
    .filter((t) => t.description && t.date);
}

function parseAmount(value: string | undefined): number {
  if (!value) return 0;
  return parseInt(value.replace(/[,¥￥円\s]/g, ""), 10) || 0;
}

function normalizeDate(dateStr: string): string {
  // 2024/01/15 or 2024-01-15 or 2024年1月15日
  const match = dateStr.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  }
  return dateStr;
}
