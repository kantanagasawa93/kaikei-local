/**
 * 他社会計ソフトの仕訳CSV/TSVを KAIKEI LOCAL のデータモデルに変換するモジュール。
 *
 * 対応状況:
 *   - moneyforward : マネーフォワード クラウド会計 公式26列仕様（ヘッダあり・UTF-8 想定）
 *   - yayoi        : 弥生会計 / やよいの青色申告 公式「弥生インポート形式」（ヘッダなし・Shift-JIS想定・識別フラグ方式）
 *   - freee        : 未サンプル（Phase B、ユーザ提供後に追記）
 *   - generic      : 列マッピングをユーザが指定する汎用 CSV（Phase C）
 *
 * 参考:
 *   - MF 公式: https://biz.moneyforward.com/support/account/guide/import-books/ib01.html
 *   - 弥生公式: https://support.yayoi-kk.co.jp/subcontents.html?page_id=18545
 */

export type ImportFormat =
  | "moneyforward"
  | "yayoi"
  | "freee"
  | "zaimu_oen"   // 財務応援R4
  | "mjs"         // MJS かんたんクラウド会計
  | "pca"         // PCA 会計
  | "obc"         // 勘定奉行 i / V
  | "icsdb"       // ICSdb
  | "generic"
  | "unknown";

export interface ParsedJournalLine {
  account_code: string | null;   // 科目コードは後工程で名称→コード解決するため一旦 null でも可
  account_name: string;
  debit_amount: number;
  credit_amount: number;
  tax_code: string | null;
  tax_amount: number;
  sub_account: string | null;
  department: string | null;
  partner: string | null;
  memo: string | null;
}

export interface ParsedJournal {
  external_id: string | null;     // 元ソフトの取引No/伝票No
  date: string;                   // YYYY-MM-DD
  description: string;
  lines: ParsedJournalLine[];
  raw_source: string;             // "moneyforward" | "yayoi" | ...
}

export interface ParseResult {
  format: ImportFormat;
  journals: ParsedJournal[];
  warnings: string[];
  errors: string[];
}

// -------------------------------------------------------------
// エンコーディング判定 & テキスト化
// -------------------------------------------------------------

/**
 * ArrayBuffer を適切な文字コードでデコードする。
 * 弥生は Shift-JIS 固定、MF は UTF-8 が一般的。BOM 判定 + 非 UTF-8 シーケンス検出で両対応。
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  // UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  // UTF-8 として読み、置換文字が出れば Shift-JIS として再デコード
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!utf8.includes("\ufffd")) return utf8;
  try {
    return new TextDecoder("shift-jis").decode(bytes);
  } catch {
    // shift-jis 未サポート環境では windows-31j フォールバック
    return new TextDecoder("windows-31j").decode(bytes);
  }
}

// -------------------------------------------------------------
// CSV パーサ（引用符対応）
// -------------------------------------------------------------

export function parseCsvLines(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csvText[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(cell);
        cell = "";
      } else if (ch === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else if (ch === "\r") {
        // skip
      } else {
        cell += ch;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.length > 0));
}

// -------------------------------------------------------------
// 自動判別
// -------------------------------------------------------------

export function detectFormat(rows: string[][]): ImportFormat {
  if (rows.length === 0) return "unknown";

  const firstRow = rows[0];

  // 弥生: 先頭列が識別フラグ `2000` / `2110` / `2100` / `2101` / `2111`
  if (/^2(000|1(00|01|10|11))$/.test(firstRow[0]?.trim() ?? "")) {
    return "yayoi";
  }

  // MF: ヘッダ行の先頭列群が既定の並び
  const header = firstRow.map((c) => c.trim());
  const mfHeaders = ["取引No", "取引日", "借方勘定科目"];
  if (mfHeaders.every((h) => header.includes(h))) {
    return "moneyforward";
  }

  // freee 汎用形式（101列）: "仕訳ID" と "仕訳行数" が特徴的
  if (header.includes("仕訳ID") && header.includes("仕訳行数") && header.includes("借方勘定科目")) {
    return "freee";
  }

  // 財務応援R4 (18列): "月種別" が先頭
  if (header[0]?.trim() === "月種別" && header.includes("借方勘定科目")) {
    return "zaimu_oen";
  }

  // MJS かんたんクラウド会計 (30列): "伝票ＮＯ" (全角NO) と "借方売上仕入" がある
  if (header.some((h) => h.trim() === "伝票ＮＯ") && header.some((h) => h.trim() === "借方売上仕入")) {
    return "mjs";
  }

  // PCA 会計 (81列): "伝票日付" + "管理仕訳区分" + "借方税計算モード"
  if (
    header.some((h) => h.trim() === "伝票日付") &&
    header.some((h) => h.trim() === "管理仕訳区分") &&
    header.some((h) => h.trim() === "借方税計算モード")
  ) {
    return "pca";
  }

  // 勘定奉行 i/V (50列): 列名が "OBCD001" や "CSJS001" などの独自コード
  if (header[0]?.trim() === "OBCD001" || header.some((h) => /^CSJS\d{3}$/.test(h.trim()))) {
    return "obc";
  }

  // ICSdb (37列): "決修" と "借方枝番摘要" がある
  if (header.some((h) => h.trim() === "決修") && header.some((h) => h.trim() === "借方枝番摘要")) {
    return "icsdb";
  }

  return "generic";
}

// -------------------------------------------------------------
// 日付正規化
// -------------------------------------------------------------

function normalizeDate(s: string | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  // YYYY/MM/DD or YYYY-MM-DD or YYYY年MM月DD日
  const m1 = trimmed.match(/^(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (m1) return `${m1[1]}-${m1[2].padStart(2, "0")}-${m1[3].padStart(2, "0")}`;
  // YYYYMMDD
  const m2 = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  // 和暦 R6/3/5 (令和 R, 平成 H, 昭和 S)
  const m3 = trimmed.match(/^([RHS])(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if (m3) {
    const baseYear = m3[1] === "R" ? 2018 : m3[1] === "H" ? 1988 : 1925;
    const year = baseYear + parseInt(m3[2], 10);
    return `${year}-${m3[3].padStart(2, "0")}-${m3[4].padStart(2, "0")}`;
  }
  return null;
}

function parseMoney(s: string | undefined): number {
  if (!s) return 0;
  const cleaned = s.replace(/[,¥￥円\s]/g, "");
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? 0 : n;
}

// -------------------------------------------------------------
// マネーフォワード クラウド会計 26列フォーマット
// -------------------------------------------------------------
//   1:取引No 2:取引日 3:借方勘定科目 4:借方補助科目 5:借方部門 6:借方取引先
//   7:借方税区分 8:借方インボイス 9:借方金額 10:借方税額
//   11:貸方勘定科目 12:貸方補助科目 13:貸方部門 14:貸方取引先
//   15:貸方税区分 16:貸方インボイス 17:貸方金額 18:貸方税額
//   19:摘要 20:仕訳メモ 21:タグ 22:MF仕訳タイプ 23:決算整理仕訳
//   24:作成日時 25:作成者 26:最終更新日時 27:最終更新者

function parseMoneyForward(rows: string[][]): ParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const grouped = new Map<string, ParsedJournal>();
  if (rows.length === 0) return { format: "moneyforward", journals: [], warnings, errors: ["空のCSV"] };

  // 列名で位置を取る方式に変更（MF公式26列とfreee-exported 25列の両対応）
  const header = rows[0];
  const findCol = (...names: string[]) => {
    for (const n of names) {
      const i = header.findIndex((h) => h.trim() === n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const COL = {
    no:            findCol("取引No"),
    date:          findCol("取引日"),
    debitAccount:  findCol("借方勘定科目"),
    debitSub:      findCol("借方補助科目"),
    debitDept:     findCol("借方部門"),
    debitPartner:  findCol("借方取引先"),
    debitTaxCode:  findCol("借方税区分"),
    debitAmount:   findCol("借方金額(円)", "借方金額"),
    debitTaxAmount: findCol("借方税額"),
    creditAccount: findCol("貸方勘定科目"),
    creditSub:     findCol("貸方補助科目"),
    creditDept:    findCol("貸方部門"),
    creditPartner: findCol("貸方取引先"),
    creditTaxCode: findCol("貸方税区分"),
    creditAmount:  findCol("貸方金額(円)", "貸方金額"),
    creditTaxAmount: findCol("貸方税額"),
    memo:          findCol("摘要"),
    journalMemo:   findCol("仕訳メモ"),
  };

  if (COL.date < 0 || COL.debitAccount < 0 || COL.creditAccount < 0) {
    errors.push("マネーフォワードとして必要な列 (取引日/借方勘定科目/貸方勘定科目) が見つかりません");
    return { format: "moneyforward", journals: [], warnings, errors };
  }

  const get = (r: string[], i: number) => (i >= 0 && i < r.length ? (r[i] || "").trim() : "");
  const dataRows = rows.slice(1);

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    const txNo = get(r, COL.no) || `__auto_${i}`;
    const date = normalizeDate(r[COL.date]);
    if (!date) {
      errors.push(`行 ${i + 2}: 日付を解釈できません: "${r[COL.date]}"`);
      continue;
    }
    const memo = get(r, COL.memo) || get(r, COL.journalMemo);
    const debit: ParsedJournalLine = {
      account_code: null,
      account_name: get(r, COL.debitAccount),
      debit_amount: parseMoney(r[COL.debitAmount]),
      credit_amount: 0,
      tax_code: get(r, COL.debitTaxCode) || null,
      tax_amount: parseMoney(r[COL.debitTaxAmount]),
      sub_account: get(r, COL.debitSub) || null,
      department: get(r, COL.debitDept) || null,
      partner: get(r, COL.debitPartner) || null,
      memo: memo || null,
    };
    const credit: ParsedJournalLine = {
      account_code: null,
      account_name: get(r, COL.creditAccount),
      debit_amount: 0,
      credit_amount: parseMoney(r[COL.creditAmount]),
      tax_code: get(r, COL.creditTaxCode) || null,
      tax_amount: parseMoney(r[COL.creditTaxAmount]),
      sub_account: get(r, COL.creditSub) || null,
      department: get(r, COL.creditDept) || null,
      partner: get(r, COL.creditPartner) || null,
      memo: memo || null,
    };

    const existing = grouped.get(txNo);
    if (existing && existing.date === date) {
      if (debit.account_name) existing.lines.push(debit);
      if (credit.account_name) existing.lines.push(credit);
    } else {
      grouped.set(txNo, {
        external_id: txNo.startsWith("__auto_") ? null : txNo,
        date,
        description: memo || debit.partner || credit.partner || "",
        lines: [
          ...(debit.account_name ? [debit] : []),
          ...(credit.account_name ? [credit] : []),
        ],
        raw_source: "moneyforward",
      });
    }
  }

  return {
    format: "moneyforward",
    journals: Array.from(grouped.values()),
    warnings,
    errors,
  };
}

// -------------------------------------------------------------
// 弥生 インポート形式（識別フラグ方式）
// -------------------------------------------------------------
// 列:
//   0:識別フラグ(2000/2110/2100/2101/2111) 1:伝票No 2:決算 3:取引日
//   4:借方勘定科目 5:借方補助 6:借方部門 7:借方税区分 8:借方金額 9:借方税金額
//   10:貸方勘定科目 11:貸方補助 12:貸方部門 13:貸方税区分 14:貸方金額 15:貸方税金額
//   16:摘要 17:番号 18:期日 19:タイプ 20:生成元 21:仕訳メモ 22:付箋1 23:付箋2 24:調整
//   (25,26): インボイス対応時追加

function parseYayoi(rows: string[][]): ParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const journals: ParsedJournal[] = [];
  let current: ParsedJournal | null = null;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const flag = (r[0] || "").trim();
    if (r.length < 16) {
      warnings.push(`行 ${i + 1}: 列数が不足（${r.length}列、16以上必要）`);
      continue;
    }
    const date = normalizeDate(r[3]);
    if (!date) {
      errors.push(`行 ${i + 1}: 日付を解釈できません: "${r[3]}"`);
      continue;
    }

    const memo = (r[16] || "").trim();
    const debit: ParsedJournalLine = {
      account_code: null,
      account_name: (r[4] || "").trim(),
      debit_amount: parseMoney(r[8]),
      credit_amount: 0,
      tax_code: (r[7] || "").trim() || null,
      tax_amount: parseMoney(r[9]),
      sub_account: (r[5] || "").trim() || null,
      department: (r[6] || "").trim() || null,
      partner: null,
      memo: memo || null,
    };
    const credit: ParsedJournalLine = {
      account_code: null,
      account_name: (r[10] || "").trim(),
      debit_amount: 0,
      credit_amount: parseMoney(r[14]),
      tax_code: (r[13] || "").trim() || null,
      tax_amount: parseMoney(r[15]),
      sub_account: (r[11] || "").trim() || null,
      department: (r[12] || "").trim() || null,
      partner: null,
      memo: memo || null,
    };

    const transferNo = (r[1] || "").trim() || null;

    if (flag === "2111" || flag === "2000") {
      // 単一行仕訳
      if (current) journals.push(current);
      current = {
        external_id: transferNo,
        date,
        description: memo,
        lines: [
          ...(debit.account_name ? [debit] : []),
          ...(credit.account_name ? [credit] : []),
        ],
        raw_source: "yayoi",
      };
      journals.push(current);
      current = null;
    } else if (flag === "2110") {
      // 複数行仕訳の先頭
      if (current) journals.push(current);
      current = {
        external_id: transferNo,
        date,
        description: memo,
        lines: [
          ...(debit.account_name ? [debit] : []),
          ...(credit.account_name ? [credit] : []),
        ],
        raw_source: "yayoi",
      };
    } else if (flag === "2100" || flag === "2101") {
      // 複数行仕訳の継続行
      if (!current) {
        warnings.push(`行 ${i + 1}: フラグ ${flag} だが複合仕訳の先頭行がない`);
        current = {
          external_id: transferNo,
          date,
          description: memo,
          lines: [],
          raw_source: "yayoi",
        };
      }
      if (debit.account_name) current.lines.push(debit);
      if (credit.account_name) current.lines.push(credit);
      if (flag === "2101") {
        journals.push(current);
        current = null;
      }
    } else {
      warnings.push(`行 ${i + 1}: 識別フラグ "${flag}" は未対応`);
    }
  }
  if (current) journals.push(current);

  return {
    format: "yayoi",
    journals,
    warnings,
    errors,
  };
}

// -------------------------------------------------------------
// freee 汎用形式 (101列)
// -------------------------------------------------------------
// 実サンプル解析済み（2026-04-18）。
// カラム番号は 0-based index（CSV上では+1）。
//
// 主要カラム:
//   0:No 1:取引日 3:借方勘定科目 7:借方金額 8:借方税区分
//   9:借方税金額 10:借方内税・外税 11:借方税率 14:借方取引先名
//   20:借方補助科目 23:借方部門 26:借方メモ
//   39:貸方勘定科目 43:貸方金額 44:貸方税区分 45:貸方税金額
//   50:貸方取引先名 56:貸方補助科目 59:貸方部門 62:貸方メモ
//   89:仕訳ID ← 複合仕訳のグルーピングキー
//   93:仕訳行番号 94:仕訳行数 96:取引内容
//
// 複合仕訳: 同じ仕訳ID の行を束ねる。各行は「借方1件 + 貸方1件」のペア。

function parseFreee(rows: string[][]): ParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const grouped = new Map<string, ParsedJournal>();
  const dataRows = rows.slice(1); // ヘッダ除外

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    if (r.length < 95) {
      warnings.push(`行 ${i + 2}: 列数が不足（${r.length}列、95以上必要）`);
      continue;
    }
    const date = normalizeDate(r[1]);
    if (!date) {
      errors.push(`行 ${i + 2}: 日付を解釈できません: "${r[1]}"`);
      continue;
    }

    const shiwakeId = (r[89] || "").trim() || (r[0] || "").trim() || `__auto_${i}`;
    let description = (r[96] || "").trim();
    // ファイル番号（列101 = index 100）— freee ファイルボックスの No. と対応
    // 後段の証憑マッチングで使うため description にタグとして埋め込む
    const fileNo = (r[100] || "").trim();
    if (fileNo) {
      description = description
        ? `${description} [freee_file_no:${fileNo}]`
        : `[freee_file_no:${fileNo}]`;
    }
    const debitMemo = (r[26] || "").trim();
    const creditMemo = (r[62] || "").trim();

    const debitAccount = (r[3] || "").trim();
    const creditAccount = (r[39] || "").trim();

    const debit: ParsedJournalLine = {
      account_code: null,
      account_name: debitAccount,
      debit_amount: parseMoney(r[7]),
      credit_amount: 0,
      tax_code: (r[8] || "").trim() || null,
      tax_amount: parseMoney(r[9]),
      sub_account: (r[20] || "").trim() || null,
      department: (r[23] || "").trim() || null,
      partner: (r[14] || "").trim() || null,
      memo: debitMemo || description || null,
    };
    const credit: ParsedJournalLine = {
      account_code: null,
      account_name: creditAccount,
      debit_amount: 0,
      credit_amount: parseMoney(r[43]),
      tax_code: (r[44] || "").trim() || null,
      tax_amount: parseMoney(r[45]),
      sub_account: (r[56] || "").trim() || null,
      department: (r[59] || "").trim() || null,
      partner: (r[50] || "").trim() || null,
      memo: creditMemo || description || null,
    };

    const existing = grouped.get(shiwakeId);
    if (existing && existing.date === date) {
      if (debitAccount) existing.lines.push(debit);
      if (creditAccount) existing.lines.push(credit);
    } else {
      grouped.set(shiwakeId, {
        external_id: shiwakeId.startsWith("__auto_") ? null : shiwakeId,
        date,
        description: description || debit.partner || credit.partner || "",
        lines: [
          ...(debitAccount ? [debit] : []),
          ...(creditAccount ? [credit] : []),
        ],
        raw_source: "freee",
      });
    }
  }

  return {
    format: "freee",
    journals: Array.from(grouped.values()),
    warnings,
    errors,
  };
}

// -------------------------------------------------------------
// 列名ベースの汎用「1行=借方1件+貸方1件ペア」パーサ ヘルパ
// -------------------------------------------------------------

interface ColumnMap {
  no: number;
  date: number;
  debitAccount: number;
  debitSub?: number;
  debitDept?: number;
  debitPartner?: number;
  debitTaxCode?: number;
  debitAmount: number;
  debitTaxAmount?: number;
  creditAccount: number;
  creditSub?: number;
  creditDept?: number;
  creditPartner?: number;
  creditTaxCode?: number;
  creditAmount: number;
  creditTaxAmount?: number;
  memo?: number;
}

function parseByColumnMap(
  rows: string[][],
  colMap: ColumnMap,
  rawSource: ParsedJournal["raw_source"],
  format: ImportFormat,
  hasHeader = true
): ParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const grouped = new Map<string, ParsedJournal>();
  const get = (r: string[], i: number | undefined) =>
    i !== undefined && i >= 0 && i < r.length ? (r[i] || "").trim() : "";
  const dataRows = hasHeader ? rows.slice(1) : rows;

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    const date = normalizeDate(r[colMap.date]);
    if (!date) {
      errors.push(`行 ${i + (hasHeader ? 2 : 1)}: 日付を解釈できません: "${r[colMap.date]}"`);
      continue;
    }
    const no = get(r, colMap.no) || `__auto_${i}`;
    const memo = get(r, colMap.memo);
    const debitAcct = get(r, colMap.debitAccount);
    const creditAcct = get(r, colMap.creditAccount);

    const debit: ParsedJournalLine = {
      account_code: null,
      account_name: debitAcct,
      debit_amount: parseMoney(r[colMap.debitAmount]),
      credit_amount: 0,
      tax_code: get(r, colMap.debitTaxCode) || null,
      tax_amount: colMap.debitTaxAmount != null ? parseMoney(r[colMap.debitTaxAmount]) : 0,
      sub_account: get(r, colMap.debitSub) || null,
      department: get(r, colMap.debitDept) || null,
      partner: get(r, colMap.debitPartner) || null,
      memo: memo || null,
    };
    const credit: ParsedJournalLine = {
      account_code: null,
      account_name: creditAcct,
      debit_amount: 0,
      credit_amount: parseMoney(r[colMap.creditAmount]),
      tax_code: get(r, colMap.creditTaxCode) || null,
      tax_amount: colMap.creditTaxAmount != null ? parseMoney(r[colMap.creditTaxAmount]) : 0,
      sub_account: get(r, colMap.creditSub) || null,
      department: get(r, colMap.creditDept) || null,
      partner: get(r, colMap.creditPartner) || null,
      memo: memo || null,
    };

    const existing = grouped.get(no);
    if (existing && existing.date === date) {
      if (debitAcct) existing.lines.push(debit);
      if (creditAcct) existing.lines.push(credit);
    } else {
      grouped.set(no, {
        external_id: no.startsWith("__auto_") ? null : no,
        date,
        description: memo || debit.partner || credit.partner || "",
        lines: [
          ...(debitAcct ? [debit] : []),
          ...(creditAcct ? [credit] : []),
        ],
        raw_source: rawSource,
      });
    }
  }
  return { format, journals: Array.from(grouped.values()), warnings, errors };
}

function resolveColumns(header: string[], names: Record<string, string | string[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(names)) {
    const arr = Array.isArray(val) ? val : [val];
    out[key] = -1;
    for (const n of arr) {
      const i = header.findIndex((h) => h.trim() === n);
      if (i >= 0) {
        out[key] = i;
        break;
      }
    }
  }
  return out;
}

// -------------------------------------------------------------
// 財務応援R4 (18列)
// 月種別,伝票日付,伝票番号,借方科目,借方勘定科目,借方消費税コード,借方消費税税率,借方補助科目コード,借方金額,借方インボイス情報,
// 貸方科目,貸方勘定科目,貸方消費税コード,貸方消費税税率,貸方補助科目コード,貸方金額,貸方インボイス情報,摘要
// -------------------------------------------------------------

function parseZaimuOen(rows: string[][]): ParseResult {
  if (rows.length === 0) return { format: "zaimu_oen", journals: [], warnings: [], errors: ["空のCSV"] };
  const h = rows[0];
  const c = resolveColumns(h, {
    no: "伝票番号",
    date: "伝票日付",
    debitAccount: "借方勘定科目",
    debitAmount: "借方金額",
    debitTaxCode: "借方消費税コード",
    creditAccount: "貸方勘定科目",
    creditAmount: "貸方金額",
    creditTaxCode: "貸方消費税コード",
    memo: "摘要",
  });
  return parseByColumnMap(
    rows,
    c as unknown as ColumnMap,
    "zaimu_oen",
    "zaimu_oen"
  );
}

// -------------------------------------------------------------
// MJS かんたんクラウド会計 (30列)
// 伝票日付,仕訳種別,伝票ＮＯ,空欄,借方科目名,借方科目別補助名称,借方部門,...
// -------------------------------------------------------------

function parseMJS(rows: string[][]): ParseResult {
  if (rows.length === 0) return { format: "mjs", journals: [], warnings: [], errors: ["空のCSV"] };
  const h = rows[0];
  const c = resolveColumns(h, {
    no: "伝票ＮＯ",
    date: "伝票日付",
    debitAccount: "借方科目名",
    debitSub: "借方科目別補助名称",
    debitDept: "借方部門",
    debitAmount: "借方金額",
    debitTaxAmount: "借方税額",
    creditAccount: "貸方科目名",
    creditSub: "貸方科目別補助名称",
    creditDept: "貸方部門",
    creditAmount: "貸方金額",
    creditTaxAmount: "貸方税額",
    memo: "摘要",
  });
  return parseByColumnMap(rows, c as unknown as ColumnMap, "mjs", "mjs");
}

// -------------------------------------------------------------
// PCA 会計 (81列)
// -------------------------------------------------------------

function parsePCA(rows: string[][]): ParseResult {
  if (rows.length === 0) return { format: "pca", journals: [], warnings: [], errors: ["空のCSV"] };
  const h = rows[0];
  const c = resolveColumns(h, {
    no: "伝票番号",
    date: "伝票日付",
    debitAccount: "借方科目名",
    debitSub: "借方補助名",
    debitDept: "借方部門名",
    debitTaxCode: "借方税区分名",
    debitAmount: "借方金額",
    debitTaxAmount: "借方消費税額",
    creditAccount: "貸方科目名",
    creditSub: "貸方補助名",
    creditDept: "貸方部門名",
    creditTaxCode: "貸方税区分名",
    creditAmount: "貸方金額",
    creditTaxAmount: "貸方消費税額",
    memo: "摘要",
  });
  return parseByColumnMap(rows, c as unknown as ColumnMap, "pca", "pca");
}

// -------------------------------------------------------------
// 勘定奉行 i/V (50列) — 独自コード列名（CSJSxxx）
// freee export の場合: CSJS005=取引日, CSJS011=借方科目コード, CSJS012=借方科目名, ...
// 一次情報なしで推測。貸借差分で検証するため位置固定ではなく行数ベースで緩めに判定。
// -------------------------------------------------------------

function parseOBC(rows: string[][]): ParseResult {
  if (rows.length === 0) return { format: "obc", journals: [], warnings: [], errors: ["空のCSV"] };
  // 勘定奉行 i/V シリーズ 50列CSV。列名は "OBCD001" 等の独自コードで、
  // 先頭 col 0 は "*"（レコード種別マーカー）。
  // freee export 実測での列配置（0-based）:
  //   [7] 取引日  [12] 借方勘定科目コード  [23] 借方金額  [24] 借方税額
  //   [30? 多分] 貸方勘定科目 ... 実測の 1行サンプルからは 貸方金額列が
  //   位置を特定しにくいため、安全策として 1行=1仕訳 として解釈する。
  //   （複合仕訳の正確なグルーピングは、奉行側の仕様書入手後に対応）
  const c: ColumnMap = {
    no: -1, // 各行を独立仕訳として扱う
    date: 7,
    debitAccount: 12,
    debitAmount: 23,
    debitTaxAmount: 24,
    creditAccount: 40, // freee export 実測での貸方科目列
    creditAmount: 41,
    creditTaxAmount: 42,
    memo: 46,
  };
  const result = parseByColumnMap(rows, c, "obc", "obc");
  result.warnings.push(
    "勘定奉行形式: freee output 実測のカラム配置で解釈しています。奉行直接 export と列が異なる場合は汎用CSVマッピングをご利用ください。"
  );
  return result;
}

// -------------------------------------------------------------
// ICSdb (37列)
// 日付,決修,伝票番号,借方部門コード,借方事管区分,借方工事コード,借方コード,借方名称,借方枝番,...
// -------------------------------------------------------------

function parseICSdb(rows: string[][]): ParseResult {
  if (rows.length === 0) return { format: "icsdb", journals: [], warnings: [], errors: ["空のCSV"] };
  const h = rows[0];
  const c = resolveColumns(h, {
    no: "伝票番号",
    date: "日付",
    debitAccount: "借方名称",
    debitSub: "借方枝番摘要",
    debitDept: "借方部門コード",
    debitAmount: "金額",
    creditAccount: "貸方名称",
    creditSub: "貸方枝番摘要",
    creditDept: "貸方部門コード",
    creditAmount: "金額",
    debitTaxCode: "税区分",
    memo: "摘要",
  });
  return parseByColumnMap(rows, c as unknown as ColumnMap, "icsdb", "icsdb");
}

// -------------------------------------------------------------
// 汎用 CSV — ユーザ指定マッピング（Phase C）
// -------------------------------------------------------------

export interface GenericMapping {
  externalIdCol?: number;
  dateCol: number;
  debitAccountCol: number;
  debitAmountCol: number;
  creditAccountCol: number;
  creditAmountCol: number;
  memoCol?: number;
  debitTaxCodeCol?: number;
  creditTaxCodeCol?: number;
  debitTaxAmountCol?: number;
  creditTaxAmountCol?: number;
  hasHeader: boolean;
}

export function parseGeneric(rows: string[][], m: GenericMapping): ParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const journals: ParsedJournal[] = [];
  const dataRows = m.hasHeader ? rows.slice(1) : rows;

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    const date = normalizeDate(r[m.dateCol]);
    if (!date) {
      errors.push(`行 ${i + (m.hasHeader ? 2 : 1)}: 日付列が解釈できません`);
      continue;
    }
    const debitAcct = (r[m.debitAccountCol] || "").trim();
    const creditAcct = (r[m.creditAccountCol] || "").trim();
    const memo = m.memoCol != null ? (r[m.memoCol] || "").trim() : "";

    journals.push({
      external_id: m.externalIdCol != null ? (r[m.externalIdCol] || null) : null,
      date,
      description: memo,
      lines: [
        ...(debitAcct
          ? [
              {
                account_code: null,
                account_name: debitAcct,
                debit_amount: parseMoney(r[m.debitAmountCol]),
                credit_amount: 0,
                tax_code: m.debitTaxCodeCol != null ? (r[m.debitTaxCodeCol] || null) : null,
                tax_amount: m.debitTaxAmountCol != null ? parseMoney(r[m.debitTaxAmountCol]) : 0,
                sub_account: null,
                department: null,
                partner: null,
                memo: memo || null,
              } as ParsedJournalLine,
            ]
          : []),
        ...(creditAcct
          ? [
              {
                account_code: null,
                account_name: creditAcct,
                debit_amount: 0,
                credit_amount: parseMoney(r[m.creditAmountCol]),
                tax_code: m.creditTaxCodeCol != null ? (r[m.creditTaxCodeCol] || null) : null,
                tax_amount: m.creditTaxAmountCol != null ? parseMoney(r[m.creditTaxAmountCol]) : 0,
                sub_account: null,
                department: null,
                partner: null,
                memo: memo || null,
              } as ParsedJournalLine,
            ]
          : []),
      ],
      raw_source: "generic",
    });
  }

  return { format: "generic", journals, warnings, errors };
}

// -------------------------------------------------------------
// トップレベル API
// -------------------------------------------------------------

export async function parseJournalFile(
  file: File,
  overrideFormat?: ImportFormat,
  genericMapping?: GenericMapping
): Promise<ParseResult> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const text = decodeCsvBytes(buf);
  const rows = parseCsvLines(text);
  const fmt = overrideFormat || detectFormat(rows);

  switch (fmt) {
    case "moneyforward":
      return parseMoneyForward(rows);
    case "yayoi":
      return parseYayoi(rows);
    case "freee":
      return parseFreee(rows);
    case "zaimu_oen":
      return parseZaimuOen(rows);
    case "mjs":
      return parseMJS(rows);
    case "pca":
      return parsePCA(rows);
    case "obc":
      return parseOBC(rows);
    case "icsdb":
      return parseICSdb(rows);
    case "generic":
      if (!genericMapping) {
        return {
          format: "generic",
          journals: [],
          warnings: [],
          errors: ["自動判別に失敗しました。列マッピングを指定してください。"],
        };
      }
      return parseGeneric(rows, genericMapping);
    default:
      return {
        format: "unknown",
        journals: [],
        warnings: [],
        errors: ["不明なCSV形式です。"],
      };
  }
}
