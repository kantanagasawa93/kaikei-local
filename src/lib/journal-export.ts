/**
 * Round 7 ㊒ 仕訳エクスポート CSV
 *
 * 仕訳帳から CSV を生成する。受信箱から自動仕訳されたものは receipts.image_url
 * (= ローカルファイルパス) を「領収書画像」コラムに、Round 4 で実装した
 * 「受信箱由来」フラグを「ソース」コラムに含める。
 *
 * 列:
 *   日付, 摘要, 借方科目コード, 借方科目名, 借方金額, 貸方科目コード, 貸方科目名,
 *   貸方金額, 税区分, 税額, メモ, 仕訳ID, 行ID, 領収書画像, ソース
 *
 * 仕様:
 *   - UTF-8 BOM 付き (Excel が文字化けしないように)
 *   - 改行は CRLF (Windows 互換)
 *   - フィールドにダブルクォート / カンマ / 改行があれば全体を "..." で囲み、
 *     内部のダブルクォートは "" にエスケープ
 *   - 1 仕訳に複数 lines があれば 1 行ごとに展開 (= journal_lines の行数)
 *
 * 既存 journal-import.ts は他社会計ソフトの読込用。export は対称の責務として
 * 別ファイルに分離する。
 */

import { db } from "@/lib/localDb";

export interface ExportableJournalLine {
  id: string;
  journal_id: string;
  date: string;
  description: string;
  account_code: string | null;
  account_name: string;
  debit_amount: number;
  credit_amount: number;
  tax_code: string | null;
  tax_amount: number;
  memo: string | null;
  receipt_id: string | null;
  receipt_image_url: string | null; // receipts.image_url (受信箱由来なら file://...)
}

const HEADERS = [
  "日付",
  "摘要",
  "借方科目コード",
  "借方科目名",
  "借方金額",
  "貸方科目コード",
  "貸方科目名",
  "貸方金額",
  "税区分",
  "税額",
  "メモ",
  "仕訳ID",
  "行ID",
  "領収書画像",
  "ソース",
] as const;

function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * 借方/貸方を 1 行で並べる「振替形式」ではなく、journal_lines 1 行 = CSV 1 行の
 * 「単一行形式」で出す。account 列を debit / credit のどちらに金額が入っている
 * かで分岐させる。
 */
function lineToCsvRow(j: ExportableJournalLine): string[] {
  const isDebit = j.debit_amount > 0;
  return [
    j.date,
    j.description,
    isDebit ? (j.account_code ?? "") : "",
    isDebit ? j.account_name : "",
    isDebit ? String(j.debit_amount) : "",
    isDebit ? "" : (j.account_code ?? ""),
    isDebit ? "" : j.account_name,
    isDebit ? "" : String(j.credit_amount),
    j.tax_code ?? "",
    String(j.tax_amount ?? 0),
    j.memo ?? "",
    j.journal_id,
    j.id,
    j.receipt_image_url ?? "",
    j.receipt_id ? "受信箱" : "手動",
  ].map(csvEscape);
}

/**
 * 全仕訳 (or 期間指定) を CSV 文字列で返す。
 *
 * @param fromDate "YYYY-MM-DD" 以上 (含む)、null で制限なし
 * @param toDate "YYYY-MM-DD" 以下 (含む)、null で制限なし
 */
export async function buildJournalsCsv(opts: {
  fromDate?: string | null;
  toDate?: string | null;
} = {}): Promise<string> {
  // journals + journal_lines + receipts の JOIN を 3 段で
  let q = db.from("journals").select("*, journal_lines(*)").order("date", { ascending: true });
  if (opts.fromDate) q = q.gte("date", opts.fromDate);
  if (opts.toDate) q = q.lte("date", opts.toDate);
  const { data: jdata } = await q;
  const journals = ((jdata as Array<{
    id: string;
    date: string;
    description: string;
    receipt_id: string | null;
    journal_lines: Array<{
      id: string;
      account_code: string | null;
      account_name: string;
      debit_amount: number;
      credit_amount: number;
      tax_code: string | null;
      tax_amount: number;
      memo: string | null;
    }>;
  }> | null) ?? []);

  // receipts の image_url を一気に引く (N+1 を避ける)
  const receiptIds = Array.from(
    new Set(journals.map((j) => j.receipt_id).filter((x): x is string => !!x)),
  );
  const receiptUrl = new Map<string, string>();
  if (receiptIds.length > 0) {
    const { data: rdata } = await db
      .from("receipts")
      .select("id, image_url")
      .in("id", receiptIds);
    for (const r of (rdata as { id: string; image_url: string | null }[] | null) ?? []) {
      if (r.image_url) receiptUrl.set(r.id, r.image_url);
    }
  }

  const rows: string[] = [HEADERS.map(csvEscape).join(",")];
  for (const j of journals) {
    for (const line of j.journal_lines) {
      rows.push(
        lineToCsvRow({
          id: line.id,
          journal_id: j.id,
          date: j.date,
          description: j.description,
          account_code: line.account_code,
          account_name: line.account_name,
          debit_amount: line.debit_amount,
          credit_amount: line.credit_amount,
          tax_code: line.tax_code,
          tax_amount: line.tax_amount,
          memo: line.memo,
          receipt_id: j.receipt_id,
          receipt_image_url: j.receipt_id ? receiptUrl.get(j.receipt_id) ?? null : null,
        }).join(","),
      );
    }
  }
  // UTF-8 BOM + CRLF
  return "﻿" + rows.join("\r\n") + "\r\n";
}

/**
 * Round 22 ⓐ: 月次集計 (1月〜12月) を CSV 文字列に。
 *
 * @param year 集計対象の会計年度 (1/1〜12/31)
 * @returns CSV (UTF-8 BOM + CRLF, ヘッダ: 月,売上,経費,差引)
 */
export interface MonthlySummaryRow {
  month: string; // "01"〜"12"
  income: number;
  expense: number;
  diff: number;
}

export async function summarizeByMonth(year: number): Promise<MonthlySummaryRow[]> {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const { data: journalRows } = await db
    .from("journals")
    .select("id, date")
    .gte("date", start)
    .lte("date", end);

  const dateMap = new Map<string, string>(); // journal_id -> "MM"
  for (const j of (journalRows as { id: string; date: string }[] | null) ?? []) {
    const m = j.date.slice(5, 7);
    if (m) dateMap.set(j.id, m);
  }

  const buckets: Record<string, MonthlySummaryRow> = {};
  for (let i = 1; i <= 12; i++) {
    const m = String(i).padStart(2, "0");
    buckets[m] = { month: m, income: 0, expense: 0, diff: 0 };
  }

  if (dateMap.size === 0) return Object.values(buckets);

  const ids = Array.from(dateMap.keys());
  const { data: lines } = await db
    .from("journal_lines")
    .select("journal_id, account_code, debit_amount, credit_amount")
    .in("journal_id", ids);

  for (const ln of (lines as Array<{
    journal_id: string;
    account_code: string;
    debit_amount: number;
    credit_amount: number;
  }> | null) ?? []) {
    const m = dateMap.get(ln.journal_id);
    if (!m) continue;
    if (ln.account_code.startsWith("4")) {
      buckets[m].income += ln.credit_amount - ln.debit_amount;
    } else if (ln.account_code.startsWith("5") || ln.account_code.startsWith("6")) {
      buckets[m].expense += ln.debit_amount - ln.credit_amount;
    }
  }

  for (const m of Object.keys(buckets)) {
    buckets[m].diff = buckets[m].income - buckets[m].expense;
  }

  return Object.values(buckets);
}

export function buildMonthlySummaryCsv(year: number, rows: MonthlySummaryRow[]): string {
  const header = ["月", "売上", "経費", "差引"];
  const lines: string[] = [header.map(csvEscape).join(",")];
  let totalInc = 0;
  let totalExp = 0;
  for (const r of rows) {
    lines.push(
      [
        `${year}-${r.month}`,
        String(r.income),
        String(r.expense),
        String(r.diff),
      ]
        .map(csvEscape)
        .join(","),
    );
    totalInc += r.income;
    totalExp += r.expense;
  }
  // 合計行
  lines.push(
    ["合計", String(totalInc), String(totalExp), String(totalInc - totalExp)]
      .map(csvEscape)
      .join(","),
  );
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/**
 * Round 22 ⓔ: 年度サマリ (PDF 生成用) を 1 リクエストで組み立てる.
 *
 * @returns FiscalYearSummary 互換の plain object
 */
export async function buildFiscalYearSummary(year: number): Promise<{
  year: number;
  receiptCount: number;
  journalCount: number;
  monthly: { month: string; income: number; expense: number }[];
  topExpenses: { account_code: string; account_name: string; amount: number }[];
}> {
  const monthly = (await summarizeByMonth(year)).map((b) => ({
    month: b.month,
    income: b.income,
    expense: b.expense,
  }));

  const start = `${year}-01-01`;
  const end = `${year}-12-31`;

  // 仕訳件数 (= 該当年度の journals 行数)
  const { data: journalRows } = await db
    .from("journals")
    .select("id")
    .gte("date", start)
    .lte("date", end);
  const journalCount = ((journalRows as { id: string }[] | null) ?? []).length;

  // 領収書件数 (年度内 = receipts.date)
  const { data: receiptRows } = await db
    .from("receipts")
    .select("id")
    .gte("date", start)
    .lte("date", end);
  const receiptCount = ((receiptRows as { id: string }[] | null) ?? []).length;

  // 勘定科目別支出 Top — 各 account_code 単位で borrow - credit を積算
  const journalIds = ((journalRows as { id: string }[] | null) ?? []).map(
    (j) => j.id,
  );
  let topExpenses: {
    account_code: string;
    account_name: string;
    amount: number;
  }[] = [];
  if (journalIds.length > 0) {
    const { data: lines } = await db
      .from("journal_lines")
      .select("account_code, account_name, debit_amount, credit_amount")
      .in("journal_id", journalIds);
    const tally = new Map<
      string,
      { account_code: string; account_name: string; amount: number }
    >();
    for (const ln of (lines as Array<{
      account_code: string;
      account_name: string;
      debit_amount: number;
      credit_amount: number;
    }> | null) ?? []) {
      // 経費 (5xx, 6xx) のみ集計
      if (
        !ln.account_code.startsWith("5") &&
        !ln.account_code.startsWith("6")
      ) {
        continue;
      }
      const amount = ln.debit_amount - ln.credit_amount;
      if (amount <= 0) continue;
      const key = ln.account_code;
      const cur = tally.get(key);
      if (cur) {
        cur.amount += amount;
      } else {
        tally.set(key, {
          account_code: ln.account_code,
          account_name: ln.account_name,
          amount,
        });
      }
    }
    topExpenses = Array.from(tally.values()).sort((a, b) => b.amount - a.amount);
  }

  return { year, receiptCount, journalCount, monthly, topExpenses };
}

/** ブラウザ側でダウンロードトリガー (Tauri の dialog plugin は使わず簡素に) */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}
