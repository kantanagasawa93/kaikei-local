import { DEFAULT_ACCOUNTS } from "@/lib/accounts";
import type { Account } from "@/types";

export type MonthlyRow = {
  code: string;
  name: string;
  category: Account["category"];
  // 月ごとの金額（index 0 = 期首, 1..12 = 1月..12月）
  months: number[];
  total: number;
};

export type ReportLine = {
  account_code: string;
  account_name: string | null;
  debit_amount: number;
  credit_amount: number;
  date: string;
};

/**
 * 仕訳行リストを月次マトリクスに集計する
 * 残高型 (BS) と 期間損益型 (PL) で符号の取り方を切り替える
 */
export function buildMonthlyMatrix(
  lines: ReportLine[],
  year: number,
  mode: "bs" | "pl"
): MonthlyRow[] {
  const rowsMap = new Map<string, MonthlyRow>();

  const getRow = (code: string): MonthlyRow => {
    if (!rowsMap.has(code)) {
      const account = DEFAULT_ACCOUNTS.find((a) => a.code === code);
      rowsMap.set(code, {
        code,
        name: account?.name || code,
        category: account?.category || "expense",
        months: new Array(13).fill(0),
        total: 0,
      });
    }
    return rowsMap.get(code)!;
  };

  for (const line of lines) {
    const d = new Date(line.date);
    const lineYear = d.getFullYear();
    const month = d.getMonth() + 1; // 1..12

    const row = getRow(line.account_code);

    // 増減計算：資産/費用は借方プラス、負債/資本/収益は貸方プラス
    const normalSide: "debit" | "credit" =
      row.category === "asset" || row.category === "expense" ? "debit" : "credit";
    const delta =
      normalSide === "debit"
        ? line.debit_amount - line.credit_amount
        : line.credit_amount - line.debit_amount;

    if (mode === "pl") {
      // PLは収益・費用のみ
      if (row.category !== "revenue" && row.category !== "expense") continue;
      if (lineYear !== year) continue;
      row.months[month] += delta;
      row.total += delta;
    } else {
      // BSは資産・負債・資本
      if (row.category === "revenue" || row.category === "expense") continue;
      if (lineYear < year) {
        // 期首残高に積む
        row.months[0] += delta;
      } else if (lineYear === year) {
        row.months[month] += delta;
      }
    }
  }

  // BSの場合は累積残高に変換
  if (mode === "bs") {
    for (const row of rowsMap.values()) {
      let running = row.months[0];
      for (let m = 1; m <= 12; m++) {
        running += row.months[m];
        row.months[m] = running;
      }
      row.total = row.months[12];
    }
  }

  return Array.from(rowsMap.values()).sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * カテゴリ別のサブトータル
 */
export function subtotalByCategory(rows: MonthlyRow[]): Record<Account["category"], number[]> {
  const init = (): number[] => new Array(13).fill(0);
  const result: Record<Account["category"], number[]> = {
    asset: init(),
    liability: init(),
    equity: init(),
    revenue: init(),
    expense: init(),
  };
  for (const row of rows) {
    for (let m = 0; m <= 12; m++) {
      result[row.category][m] += row.months[m];
    }
  }
  return result;
}

export const CATEGORY_LABEL: Record<Account["category"], string> = {
  asset: "資産",
  liability: "負債",
  equity: "資本",
  revenue: "収益",
  expense: "費用",
};
