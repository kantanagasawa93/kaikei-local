/**
 * 銀行・クレジットカード別の CSV アダプタ。
 *
 * `csv-import.ts` の parseBankCSV / parseCreditCardCSV は汎用ヘッダ fuzzy マッチだが、
 * 銀行ごとに独自のヘッダ名・列順・符号扱いがあるため、銀行別パーサで
 * ヒットしたものを優先する。判別不能なら汎用パーサにフォールバックする。
 *
 * 対応銀行 (2026-04 時点):
 *   - 住信 SBI ネット銀行
 *   - 楽天銀行
 *   - 三井住友銀行 (SMBC)
 *   - PayPay 銀行
 *   - 楽天カード
 *   - 三井住友カード
 *
 * エンコーディング:
 *   CSV は string として受け取る前提。Shift_JIS の場合は呼び出し側で
 *   TextDecoder("shift_jis") 経由で UTF-8 に変換してから渡す。
 */

import { suggestAccount } from "./accounts";
import {
  parseBankCSV as genericParseBankCSV,
  parseCreditCardCSV as genericParseCreditCardCSV,
  parseCSV,
  type ParsedTransaction,
} from "./csv-import";

export type BankId =
  | "sumishin-sbi"
  | "rakuten-bank"
  | "smbc-bank"
  | "paypay-bank"
  | "rakuten-card"
  | "smcc-card"
  | "unknown";

export interface BankAdapter {
  id: BankId;
  /** 表示名 */
  name: string;
  /** ヘッダ行（小文字化済み）を見て判別する */
  match: (headers: string[]) => boolean;
  /** 本体パース。ヘッダ抜きの body 部を受け取る想定 */
  parse: (rows: string[][]) => ParsedTransaction[];
}

// ──────────────────────────────────────────────────────────
// ヘルパ
// ──────────────────────────────────────────────────────────

function parseAmount(v: string | undefined): number {
  if (!v) return 0;
  // カンマ・通貨記号・全角マイナス・プラスを除去
  const cleaned = v.replace(/[,¥￥円\s＋+]/g, "").replace(/[−－ー]/g, "-");
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? 0 : n;
}

function normalizeDate(s: string): string {
  const m = s.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return s;
}

function includesAll(headers: string[], keywords: string[]): boolean {
  return keywords.every((k) => headers.some((h) => h.includes(k.toLowerCase())));
}

function buildTx(
  date: string,
  description: string,
  amountRaw: number,
  balance: number | null
): ParsedTransaction {
  const suggestion = suggestAccount(description);
  return {
    date: normalizeDate(date),
    description,
    amount: Math.abs(amountRaw),
    is_income: amountRaw > 0,
    balance_after: balance,
    suggested_account_code: suggestion?.code ?? null,
    suggested_account_name: suggestion?.name ?? null,
  };
}

// ──────────────────────────────────────────────────────────
// 銀行別アダプタ
// ──────────────────────────────────────────────────────────

/**
 * 住信 SBI ネット銀行
 * 典型ヘッダ:
 *   日付,内容,出金金額（円）,入金金額（円）,残高（円）,メモ
 */
const sumishinSbi: BankAdapter = {
  id: "sumishin-sbi",
  name: "住信 SBI ネット銀行",
  match: (h) =>
    includesAll(h, ["日付", "内容", "出金金額", "入金金額", "残高"]),
  parse: (rows) => {
    const results: ParsedTransaction[] = [];
    for (const row of rows) {
      if (row.length < 5) continue;
      const [date, desc, out, inAmt, bal] = row;
      const amount = parseAmount(inAmt) - parseAmount(out);
      if (!date || !desc || amount === 0) continue;
      results.push(buildTx(date, desc, amount, parseAmount(bal) || null));
    }
    return results;
  },
};

/**
 * 楽天銀行
 * 典型ヘッダ:
 *   取引日,入出金(円),取引後残高(円),取引内容
 * ※ 入出金は符号付き (出金が負)
 */
const rakutenBank: BankAdapter = {
  id: "rakuten-bank",
  name: "楽天銀行",
  match: (h) => includesAll(h, ["取引日", "入出金", "取引後残高", "取引内容"]),
  parse: (rows) => {
    const results: ParsedTransaction[] = [];
    for (const row of rows) {
      if (row.length < 4) continue;
      const [date, nyushukkin, bal, desc] = row;
      const amount = parseAmount(nyushukkin);
      if (!date || !desc || amount === 0) continue;
      results.push(buildTx(date, desc, amount, parseAmount(bal) || null));
    }
    return results;
  },
};

/**
 * 三井住友銀行 (SMBC)
 * 典型ヘッダ:
 *   年月日,お引出し,お預入れ,お取り扱い内容,残高
 */
const smbcBank: BankAdapter = {
  id: "smbc-bank",
  name: "三井住友銀行",
  match: (h) =>
    includesAll(h, ["年月日", "お引出し", "お預入れ", "お取り扱い内容"]),
  parse: (rows) => {
    const results: ParsedTransaction[] = [];
    for (const row of rows) {
      if (row.length < 5) continue;
      const [date, debit, credit, desc, bal] = row;
      const amount = parseAmount(credit) - parseAmount(debit);
      if (!date || !desc || amount === 0) continue;
      results.push(buildTx(date, desc, amount, parseAmount(bal) || null));
    }
    return results;
  },
};

/**
 * PayPay 銀行 (旧ジャパンネット銀行)
 * 典型ヘッダ:
 *   取引日,取引区分,摘要,入金額,出金額,取引後残高
 */
const paypayBank: BankAdapter = {
  id: "paypay-bank",
  name: "PayPay 銀行",
  match: (h) => includesAll(h, ["取引日", "取引区分", "入金額", "出金額"]),
  parse: (rows) => {
    const results: ParsedTransaction[] = [];
    for (const row of rows) {
      if (row.length < 6) continue;
      const [date, _kbn, desc, inAmt, outAmt, bal] = row;
      const amount = parseAmount(inAmt) - parseAmount(outAmt);
      if (!date || !desc || amount === 0) continue;
      results.push(buildTx(date, desc, amount, parseAmount(bal) || null));
    }
    return results;
  },
};

/**
 * 楽天カード
 * 典型ヘッダ:
 *   利用日,利用店名・商品名,利用者,支払方法,利用金額,...
 */
const rakutenCard: BankAdapter = {
  id: "rakuten-card",
  name: "楽天カード",
  match: (h) =>
    includesAll(h, ["利用日", "利用店名"]) &&
    h.some((x) => x.includes("利用金額")),
  parse: (rows) => {
    const results: ParsedTransaction[] = [];
    for (const row of rows) {
      if (row.length < 5) continue;
      const [date, shop, , , amount] = row;
      const amt = parseAmount(amount);
      if (!date || !shop || amt === 0) continue;
      // カードは常に出金 (マイナス方向)
      results.push(buildTx(date, shop, -amt, null));
    }
    return results;
  },
};

/**
 * 三井住友カード (SMCC / Vpass CSV)
 * 典型ヘッダ:
 *   ご利用日,ご利用店名,ご利用者,支払区分,ご利用金額,...
 */
const smccCard: BankAdapter = {
  id: "smcc-card",
  name: "三井住友カード",
  match: (h) =>
    includesAll(h, ["ご利用日", "ご利用店名"]) &&
    h.some((x) => x.includes("ご利用金額")),
  parse: (rows) => {
    const results: ParsedTransaction[] = [];
    for (const row of rows) {
      if (row.length < 5) continue;
      const [date, shop, , , amount] = row;
      const amt = parseAmount(amount);
      if (!date || !shop || amt === 0) continue;
      results.push(buildTx(date, shop, -amt, null));
    }
    return results;
  },
};

const ADAPTERS: BankAdapter[] = [
  sumishinSbi,
  rakutenBank,
  smbcBank,
  paypayBank,
  rakutenCard,
  smccCard,
];

// ──────────────────────────────────────────────────────────
// 判別・パース入口
// ──────────────────────────────────────────────────────────

export interface CsvDetectionResult {
  bankId: BankId;
  bankName: string;
  transactions: ParsedTransaction[];
  /** フォールバックで汎用パーサを使った場合 true */
  fallback: boolean;
}

/**
 * CSV 文字列を自動判別して銀行別パース。
 * 該当銀行無しなら汎用 parseBankCSV / parseCreditCardCSV にフォールバック。
 *
 * @param csvText CSV 全体 (string)
 * @param assumeKind "bank" | "card" | "auto". auto なら銀行側優先で試す
 */
export function parseBankOrCardCsv(
  csvText: string,
  assumeKind: "bank" | "card" | "auto" = "auto"
): CsvDetectionResult {
  const allRows = parseCSV(csvText);
  if (allRows.length < 2) {
    return {
      bankId: "unknown",
      bankName: "不明",
      transactions: [],
      fallback: true,
    };
  }
  const headers = allRows[0].map((h) => h.toLowerCase());
  const body = allRows.slice(1);

  // 銀行別アダプタで match 試行
  for (const a of ADAPTERS) {
    if (a.match(headers)) {
      const txs = a.parse(body).filter((t) => t.description && t.date);
      return {
        bankId: a.id,
        bankName: a.name,
        transactions: txs,
        fallback: false,
      };
    }
  }

  // フォールバック: 汎用パーサ
  const txs =
    assumeKind === "card"
      ? genericParseCreditCardCSV(csvText)
      : genericParseBankCSV(csvText);
  return {
    bankId: "unknown",
    bankName: "汎用 (自動判別)",
    transactions: txs,
    fallback: true,
  };
}

/**
 * 対応銀行のリストを公開 (UI で「対応銀行一覧」を出す用)
 */
export function supportedBanks(): { id: BankId; name: string }[] {
  return ADAPTERS.map((a) => ({ id: a.id, name: a.name }));
}
