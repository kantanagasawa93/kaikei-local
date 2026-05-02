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
