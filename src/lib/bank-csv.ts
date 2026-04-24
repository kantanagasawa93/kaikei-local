/**
 * 銀行・クレジットカード別の CSV アダプタ。
 *
 * `csv-import.ts` の parseBankCSV / parseCreditCardCSV は汎用ヘッダ fuzzy マッチだが、
 * 銀行ごとに独自のヘッダ名・列順・符号扱いがあるため、銀行別パーサで
 * ヒットしたものを優先する。判別不能なら汎用パーサにフォールバックする。
 *
 * ## 対応銀行 (2026-04 時点)
 * 実 CSV サンプルで動作検証済み: 住信SBI / 楽天銀行 / 楽天カード / SMBC / SMCC
 * 仕様書・公開情報ベースのベストエフォート対応:
 *   - メガバンク: みずほ / 三菱UFJ / りそな / ゆうちょ
 *   - ネット銀行: PayPay / ソニー / au じぶん / SBI新生 / セブン / イオン
 *   - 地銀: 横浜 / 千葉 / 福岡 / 西日本シティ / 常陽 / 静岡 / 京都 / 広島 /
 *     スルガ / 北洋 / 北海道 / 東邦
 *   - カード: JCB / NICOS / MUFG / VIEW / dカード / Amex / セゾン /
 *     エポス / PayPayカード / au PAY カード / イオンカード
 *
 * ## エンコーディング
 * 日本の銀行 CSV は約半数が Shift_JIS。呼び出し側で raw ArrayBuffer を
 * `parseBankOrCardCsvBytes()` に渡せば UTF-8/SJIS を自動判定してくれる。
 * UTF-8 で読める文字列が手元にある場合は従来通り `parseBankOrCardCsv()`。
 */

import { suggestAccount } from "./accounts";
import {
  parseBankCSV as genericParseBankCSV,
  parseCreditCardCSV as genericParseCreditCardCSV,
  parseCSV,
  type ParsedTransaction,
} from "./csv-import";

export type BankCategory = "bank" | "card";

export interface BankAdapter {
  id: string;
  /** 表示名 */
  name: string;
  /** 種別 */
  category: BankCategory;
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
  const cleaned = v
    .replace(/[,¥￥円\s＋+]/g, "")
    .replace(/[−－ー]/g, "-");
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? 0 : n;
}

function normalizeDate(s: string): string {
  const m = s.match(/(\d{4})[\/\-年\.](\d{1,2})[\/\-月\.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  // 年を省略した MM/DD の場合は現在の年を付与
  const m2 = s.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (m2) {
    const y = new Date().getFullYear();
    return `${y}-${m2[1].padStart(2, "0")}-${m2[2].padStart(2, "0")}`;
  }
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

/**
 * 入金/出金が分離している一般的な銀行 CSV 用の汎用パーサ。
 * 指定した列インデックスから読み取る。
 */
function parseBankRows(
  rows: string[][],
  idx: {
    date: number;
    desc: number;
    deposit?: number;
    withdrawal?: number;
    signedAmount?: number;
    balance?: number;
  }
): ParsedTransaction[] {
  const res: ParsedTransaction[] = [];
  const maxCol = Math.max(
    idx.date,
    idx.desc,
    idx.deposit ?? -1,
    idx.withdrawal ?? -1,
    idx.signedAmount ?? -1,
    idx.balance ?? -1
  );
  for (const row of rows) {
    if (row.length <= maxCol) continue;
    const date = row[idx.date];
    const desc = row[idx.desc];
    if (!date || !desc) continue;
    let amount = 0;
    if (idx.signedAmount !== undefined) {
      amount = parseAmount(row[idx.signedAmount]);
    } else {
      const dep = idx.deposit !== undefined ? parseAmount(row[idx.deposit]) : 0;
      const wdr =
        idx.withdrawal !== undefined ? parseAmount(row[idx.withdrawal]) : 0;
      amount = dep - wdr;
    }
    if (amount === 0) continue;
    const bal =
      idx.balance !== undefined ? parseAmount(row[idx.balance]) || null : null;
    res.push(buildTx(date, desc, amount, bal));
  }
  return res;
}

/**
 * カード CSV 用の汎用パーサ。常に出金 (amount < 0) 扱い。
 */
function parseCardRows(
  rows: string[][],
  idx: { date: number; desc: number; amount: number }
): ParsedTransaction[] {
  const res: ParsedTransaction[] = [];
  for (const row of rows) {
    if (row.length <= Math.max(idx.date, idx.desc, idx.amount)) continue;
    const date = row[idx.date];
    const desc = row[idx.desc];
    const amt = parseAmount(row[idx.amount]);
    if (!date || !desc || amt === 0) continue;
    res.push(buildTx(date, desc, -amt, null));
  }
  return res;
}

/**
 * 指定ヘッダの index を探す (部分一致)。見つからなければ -1。
 */
function findIdx(headers: string[], ...keywords: string[]): number {
  for (const k of keywords) {
    const i = headers.findIndex((h) => h.includes(k.toLowerCase()));
    if (i >= 0) return i;
  }
  return -1;
}

// ──────────────────────────────────────────────────────────
// 銀行別アダプタ
// ──────────────────────────────────────────────────────────

const ADAPTERS: BankAdapter[] = [
  // ── メガバンク ──
  {
    id: "mizuho-bank",
    name: "みずほ銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["お取扱日"]) &&
      (h.some((x) => x.includes("お支払金額")) ||
        h.some((x) => x.includes("お預り金額"))),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0, // お取扱日
        desc: 2, // お取引内容
        withdrawal: 3, // お支払金額
        deposit: 4, // お預り金額
        balance: 5, // 差引残高
      }),
  },
  {
    id: "mufg-bank",
    name: "三菱UFJ銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["日付", "摘要内容"]) &&
      h.some((x) => x.includes("預入金額")),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0, // 日付
        desc: 2, // 摘要内容
        withdrawal: 3, // 支払金額
        deposit: 4, // 預入金額
        balance: 5, // 差引残高
      }),
  },
  {
    id: "smbc-bank",
    name: "三井住友銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["年月日", "お引出し", "お預入れ", "お取り扱い内容"]),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0, // 年月日
        withdrawal: 1, // お引出し
        deposit: 2, // お預入れ
        desc: 3, // お取り扱い内容
        balance: 4, // 残高
      }),
  },
  {
    id: "resona-bank",
    name: "りそな銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["日付", "お引出し", "お預入れ"]) ||
      includesAll(h, ["お取扱日", "お引出し", "お預入れ"]),
    parse: (rows) => {
      // ヘッダに依存しないため動的判定
      return rows
        .filter((r) => r.length >= 5)
        .map((row) => {
          const [date, , out, inAmt, desc, bal] = row;
          const amount = parseAmount(inAmt) - parseAmount(out);
          if (!date || !desc || amount === 0) return null;
          return buildTx(date, desc, amount, parseAmount(bal ?? "") || null);
        })
        .filter((t): t is ParsedTransaction => t !== null);
    },
  },
  {
    id: "jp-post-bank",
    name: "ゆうちょ銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["年月日", "受払区分"]) ||
      includesAll(h, ["年月日", "取扱内容", "残高"]),
    parse: (rows) =>
      rows
        .filter((r) => r.length >= 5)
        .map((row) => {
          const [date, kbn, amount, desc, , , bal] = row;
          const amt = parseAmount(amount);
          if (!date || !desc || amt === 0) return null;
          // 受払区分: 1=受け取り(入金), 2=払い出し(出金)
          const isIncome = kbn?.trim() === "1" || kbn?.includes("受") || false;
          return buildTx(
            date,
            desc,
            isIncome ? amt : -amt,
            parseAmount(bal ?? "") || null
          );
        })
        .filter((t): t is ParsedTransaction => t !== null),
  },

  // ── ネット銀行 ──
  {
    id: "sumishin-sbi",
    name: "住信SBIネット銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["日付", "内容", "出金金額", "入金金額", "残高"]),
    parse: (rows) =>
      rows
        .filter((r) => r.length >= 5)
        .map((row) => {
          const [date, desc, out, inAmt, bal] = row;
          const amount = parseAmount(inAmt) - parseAmount(out);
          if (!date || !desc || amount === 0) return null;
          return buildTx(date, desc, amount, parseAmount(bal) || null);
        })
        .filter((t): t is ParsedTransaction => t !== null),
  },
  {
    id: "rakuten-bank",
    name: "楽天銀行",
    category: "bank",
    match: (h) => includesAll(h, ["取引日", "入出金", "取引後残高", "取引内容"]),
    parse: (rows) =>
      rows
        .filter((r) => r.length >= 4)
        .map((row) => {
          const [date, signed, bal, desc] = row;
          const amount = parseAmount(signed);
          if (!date || !desc || amount === 0) return null;
          return buildTx(date, desc, amount, parseAmount(bal) || null);
        })
        .filter((t): t is ParsedTransaction => t !== null),
  },
  {
    id: "paypay-bank",
    name: "PayPay銀行",
    category: "bank",
    match: (h) => includesAll(h, ["取引日", "取引区分", "入金額", "出金額"]),
    parse: (rows) =>
      rows
        .filter((r) => r.length >= 6)
        .map((row) => {
          const [date, , desc, inAmt, outAmt, bal] = row;
          const amount = parseAmount(inAmt) - parseAmount(outAmt);
          if (!date || !desc || amount === 0) return null;
          return buildTx(date, desc, amount, parseAmount(bal) || null);
        })
        .filter((t): t is ParsedTransaction => t !== null),
  },
  {
    id: "sony-bank",
    name: "ソニー銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["日付"]) &&
      h.some((x) => x.includes("お取り扱い内容")) &&
      (h.some((x) => x.includes("お支払い金額")) ||
        h.some((x) => x.includes("お預り金額"))),
    parse: (rows) => {
      return rows
        .filter((r) => r.length >= 5)
        .map((row) => {
          const [date, desc, out, inAmt, bal] = row;
          const amount = parseAmount(inAmt) - parseAmount(out);
          if (!date || !desc || amount === 0) return null;
          return buildTx(date, desc, amount, parseAmount(bal) || null);
        })
        .filter((t): t is ParsedTransaction => t !== null);
    },
  },
  {
    id: "jibun-bank",
    name: "auじぶん銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["取扱日"]) &&
      h.some((x) => x.includes("摘要")) &&
      (h.some((x) => x.includes("お支払金額")) ||
        h.some((x) => x.includes("お預入金額"))),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        desc: 1,
        withdrawal: 2,
        deposit: 3,
        balance: 4,
      }),
  },
  {
    id: "shinsei-bank",
    name: "SBI新生銀行",
    category: "bank",
    match: (h) =>
      (includesAll(h, ["日付", "摘要"]) &&
        h.some((x) => x.includes("引出し")) &&
        h.some((x) => x.includes("預入れ"))) ||
      includesAll(h, ["日付", "摘要", "金額", "残高"]),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        desc: 1,
        withdrawal: 2,
        deposit: 3,
        balance: 4,
      }),
  },
  {
    id: "seven-bank",
    name: "セブン銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["取引日"]) &&
      (h.some((x) => x.includes("摘要")) || h.some((x) => x.includes("内容"))) &&
      h.some((x) => x.includes("残高")),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        desc: 1,
        withdrawal: 2,
        deposit: 3,
        balance: 4,
      }),
  },
  {
    id: "aeon-bank",
    name: "イオン銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["取引日"]) &&
      h.some((x) => x.includes("摘要")) &&
      (h.some((x) => x.includes("お支払金額")) ||
        h.some((x) => x.includes("お預り金額"))),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        desc: 1,
        withdrawal: 2,
        deposit: 3,
        balance: 4,
      }),
  },

  // ── 地銀 (主要) ──
  {
    id: "yokohama-bank",
    name: "横浜銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["日付"]) &&
      h.some((x) => x.includes("お支払金額")) &&
      h.some((x) => x.includes("お預入金額")),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        withdrawal: 1,
        deposit: 2,
        desc: 3,
        balance: 4,
      }),
  },
  {
    id: "chiba-bank",
    name: "千葉銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["お取引日"]) &&
      h.some((x) => x.includes("お支払金額")) &&
      h.some((x) => x.includes("お預入金額")),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        desc: 1,
        withdrawal: 2,
        deposit: 3,
        balance: 4,
      }),
  },
  {
    id: "fukuoka-bank",
    name: "福岡銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["日付"]) &&
      h.some((x) => x.includes("お引き出し")) &&
      h.some((x) => x.includes("お預け入れ")),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        desc: 1,
        withdrawal: 2,
        deposit: 3,
        balance: 4,
      }),
  },
  {
    id: "nishi-nippon-city-bank",
    name: "西日本シティ銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["取引日"]) &&
      h.some((x) => x.includes("摘要")) &&
      h.some((x) => x.includes("支払") || x.includes("預入")),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        desc: 1,
        withdrawal: 2,
        deposit: 3,
        balance: 4,
      }),
  },
  {
    id: "joyo-bank",
    name: "常陽銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["お取扱日"]) &&
      h.some((x) => x.includes("お取扱内容")) &&
      h.some((x) => x.includes("残高")),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        desc: 1,
        withdrawal: 2,
        deposit: 3,
        balance: 4,
      }),
  },
  {
    id: "shizuoka-bank",
    name: "静岡銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["取扱日"]) &&
      h.some((x) => x.includes("お引出し")) &&
      h.some((x) => x.includes("お預入れ")),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        withdrawal: 1,
        deposit: 2,
        desc: 3,
        balance: 4,
      }),
  },
  {
    id: "kyoto-bank",
    name: "京都銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["日付"]) &&
      h.some((x) => x.includes("お引出")) &&
      h.some((x) => x.includes("お預入")),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        desc: 1,
        withdrawal: 2,
        deposit: 3,
        balance: 4,
      }),
  },
  {
    id: "hiroshima-bank",
    name: "広島銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["取扱日"]) &&
      h.some((x) => x.includes("お取扱内容")),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        desc: 1,
        withdrawal: 2,
        deposit: 3,
        balance: 4,
      }),
  },
  {
    id: "suruga-bank",
    name: "スルガ銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["年月日", "摘要"]) &&
      h.some((x) => x.includes("お払い出し") || x.includes("お払出し")),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        desc: 2,
        withdrawal: 4,
        deposit: 5,
        balance: 7,
      }),
  },
  {
    id: "hokuyo-bank",
    name: "北洋銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["お取引日"]) &&
      h.some((x) => x.includes("お取引内容") || x.includes("摘要")),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        desc: 1,
        withdrawal: 2,
        deposit: 3,
        balance: 4,
      }),
  },
  {
    id: "hokkaido-bank",
    name: "北海道銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["取扱日", "お取引内容"]) ||
      includesAll(h, ["取引日", "お取引内容"]),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        desc: 1,
        withdrawal: 2,
        deposit: 3,
        balance: 4,
      }),
  },
  {
    id: "toho-bank",
    name: "東邦銀行",
    category: "bank",
    match: (h) =>
      includesAll(h, ["お取扱日", "お取扱内容"]) &&
      h.some((x) => x.includes("お支払金額") || x.includes("お預り金額")),
    parse: (rows) =>
      parseBankRows(rows, {
        date: 0,
        desc: 1,
        withdrawal: 2,
        deposit: 3,
        balance: 4,
      }),
  },

  // ── クレジットカード ──
  {
    id: "rakuten-card",
    name: "楽天カード",
    category: "card",
    match: (h) =>
      includesAll(h, ["利用日", "利用店名"]) &&
      h.some((x) => x.includes("利用金額")),
    parse: (rows) =>
      rows
        .filter((r) => r.length >= 5)
        .map((row) => {
          const [date, shop, , , amt] = row;
          const a = parseAmount(amt);
          if (!date || !shop || a === 0) return null;
          return buildTx(date, shop, -a, null);
        })
        .filter((t): t is ParsedTransaction => t !== null),
  },
  {
    id: "smcc-card",
    name: "三井住友カード",
    category: "card",
    match: (h) =>
      includesAll(h, ["ご利用日", "ご利用店名"]) &&
      h.some((x) => x.includes("ご利用金額")),
    parse: (rows) =>
      rows
        .filter((r) => r.length >= 5)
        .map((row) => {
          const [date, shop, , , amt] = row;
          const a = parseAmount(amt);
          if (!date || !shop || a === 0) return null;
          return buildTx(date, shop, -a, null);
        })
        .filter((t): t is ParsedTransaction => t !== null),
  },
  {
    id: "jcb-card",
    name: "JCB カード",
    category: "card",
    match: (h) =>
      includesAll(h, ["ご利用日", "ご利用店名"]) &&
      h.some((x) => x.includes("ご利用金額") || x.includes("支払合計")),
    parse: (rows) => {
      // ヘッダ位置依存せず、日付・店名・金額を自動検出
      return rows
        .filter((r) => r.length >= 3)
        .map((row) => {
          const date = row[0];
          const shop = row[1];
          // 金額を数値列の最初から取る
          const amt = row
            .slice(2)
            .map(parseAmount)
            .find((n) => n > 0);
          if (!date || !shop || !amt) return null;
          return buildTx(date, shop, -amt, null);
        })
        .filter((t): t is ParsedTransaction => t !== null);
    },
  },
  {
    id: "nicos-card",
    name: "三菱UFJニコス",
    category: "card",
    match: (h) =>
      includesAll(h, ["ご利用日", "ご利用先"]) &&
      h.some((x) => x.includes("ご利用金額")),
    parse: (rows) =>
      rows
        .filter((r) => r.length >= 3)
        .map((row) => {
          const [date, shop, amt] = row;
          const a = parseAmount(amt);
          if (!date || !shop || a === 0) return null;
          return buildTx(date, shop, -a, null);
        })
        .filter((t): t is ParsedTransaction => t !== null),
  },
  {
    id: "view-card",
    name: "VIEW カード (JR東)",
    category: "card",
    match: (h) =>
      includesAll(h, ["ご利用年月日"]) &&
      (h.some((x) => x.includes("ご利用箇所")) ||
        h.some((x) => x.includes("ご利用店舗"))) &&
      h.some((x) => x.includes("ご利用額") || x.includes("ご請求額")),
    parse: (rows) =>
      rows
        .filter((r) => r.length >= 3)
        .map((row) => {
          const [date, shop, amt] = row;
          const a = parseAmount(amt);
          if (!date || !shop || a === 0) return null;
          return buildTx(date, shop, -a, null);
        })
        .filter((t): t is ParsedTransaction => t !== null),
  },
  {
    id: "dcard",
    name: "dカード",
    category: "card",
    match: (h) =>
      includesAll(h, ["ご利用年月日", "ご利用店名"]) &&
      h.some((x) => x.includes("ご利用金額")),
    parse: (rows) =>
      rows
        .filter((r) => r.length >= 4)
        .map((row) => {
          const [date, shop, , amt] = row;
          const a = parseAmount(amt);
          if (!date || !shop || a === 0) return null;
          return buildTx(date, shop, -a, null);
        })
        .filter((t): t is ParsedTransaction => t !== null),
  },
  {
    id: "amex-jp",
    name: "American Express (JP)",
    category: "card",
    match: (h) =>
      includesAll(h, ["日付"]) &&
      h.some((x) => x.includes("ご利用場所") || x.includes("description")) &&
      h.some((x) => x.includes("金額") || x.includes("amount")),
    parse: (rows) => {
      // 柔軟に処理
      return rows
        .filter((r) => r.length >= 3)
        .map((row) => {
          const date = row[0];
          const shop = row[1];
          const amt = parseAmount(row[2]);
          if (!date || !shop || amt === 0) return null;
          return buildTx(date, shop, -Math.abs(amt), null);
        })
        .filter((t): t is ParsedTransaction => t !== null);
    },
  },
  {
    id: "saison-card",
    name: "セゾンカード",
    category: "card",
    match: (h) =>
      includesAll(h, ["ご利用日"]) &&
      h.some((x) => x.includes("ご利用店") || x.includes("ご利用先")),
    parse: (rows) =>
      rows
        .filter((r) => r.length >= 3)
        .map((row) => {
          const [date, shop, amt] = row;
          const a = parseAmount(amt);
          if (!date || !shop || a === 0) return null;
          return buildTx(date, shop, -a, null);
        })
        .filter((t): t is ParsedTransaction => t !== null),
  },
  {
    id: "epos-card",
    name: "エポスカード",
    category: "card",
    match: (h) =>
      includesAll(h, ["ご利用年月"]) &&
      h.some((x) => x.includes("利用店名") || x.includes("ご利用先")),
    parse: (rows) =>
      rows
        .filter((r) => r.length >= 3)
        .map((row) => {
          const [date, shop, amt] = row;
          const a = parseAmount(amt);
          if (!date || !shop || a === 0) return null;
          return buildTx(date, shop, -a, null);
        })
        .filter((t): t is ParsedTransaction => t !== null),
  },
  {
    id: "paypay-card",
    name: "PayPayカード",
    category: "card",
    match: (h) =>
      includesAll(h, ["ご利用日", "ご利用店名"]) &&
      h.some((x) => x.includes("ご請求金額") || x.includes("ご利用金額")),
    parse: (rows) =>
      rows
        .filter((r) => r.length >= 3)
        .map((row) => {
          const [date, shop, amt] = row;
          const a = parseAmount(amt);
          if (!date || !shop || a === 0) return null;
          return buildTx(date, shop, -a, null);
        })
        .filter((t): t is ParsedTransaction => t !== null),
  },
  {
    id: "aupay-card",
    name: "au PAY カード",
    category: "card",
    match: (h) =>
      includesAll(h, ["ご利用日"]) &&
      h.some((x) => x.includes("ご利用内容") || x.includes("ご利用店名")),
    parse: (rows) =>
      rows
        .filter((r) => r.length >= 3)
        .map((row) => {
          const [date, shop, amt] = row;
          const a = parseAmount(amt);
          if (!date || !shop || a === 0) return null;
          return buildTx(date, shop, -a, null);
        })
        .filter((t): t is ParsedTransaction => t !== null),
  },
  {
    id: "aeon-card",
    name: "イオンカード",
    category: "card",
    match: (h) =>
      includesAll(h, ["ご利用日"]) &&
      h.some((x) => x.includes("利用店名") || x.includes("ご利用場所")),
    parse: (rows) =>
      rows
        .filter((r) => r.length >= 3)
        .map((row) => {
          const [date, shop, amt] = row;
          const a = parseAmount(amt);
          if (!date || !shop || a === 0) return null;
          return buildTx(date, shop, -a, null);
        })
        .filter((t): t is ParsedTransaction => t !== null),
  },
];

// ──────────────────────────────────────────────────────────
// 判別・パース入口
// ──────────────────────────────────────────────────────────

export interface CsvDetectionResult {
  bankId: string;
  bankName: string;
  transactions: ParsedTransaction[];
  fallback: boolean;
  encoding: "utf-8" | "shift_jis" | "unknown";
}

/**
 * CSV 文字列 (UTF-8 前提) を銀行別アダプタで試し、ダメなら汎用にフォールバック。
 */
export function parseBankOrCardCsv(
  csvText: string,
  assumeKind: BankCategory | "auto" = "auto"
): CsvDetectionResult {
  const allRows = parseCSV(csvText);
  if (allRows.length < 2) {
    return {
      bankId: "unknown",
      bankName: "不明",
      transactions: [],
      fallback: true,
      encoding: "utf-8",
    };
  }
  const headers = allRows[0].map((h) => h.toLowerCase());
  const body = allRows.slice(1);

  // 銀行別アダプタで match 試行 (card カテゴリは assumeKind=bank の時は除外)
  const candidates = ADAPTERS.filter((a) =>
    assumeKind === "auto" ? true : a.category === assumeKind
  );
  for (const a of candidates) {
    if (a.match(headers)) {
      const txs = a.parse(body).filter((t) => t.description && t.date);
      if (txs.length > 0) {
        return {
          bankId: a.id,
          bankName: a.name,
          transactions: txs,
          fallback: false,
          encoding: "utf-8",
        };
      }
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
    encoding: "utf-8",
  };
}

/**
 * ArrayBuffer から CSV をパース。UTF-8 で読めなければ Shift_JIS を試す。
 * File オブジェクト (japanese bank CSV は SJIS 多数) に対応するため。
 */
export function parseBankOrCardCsvBytes(
  bytes: ArrayBuffer,
  assumeKind: BankCategory | "auto" = "auto"
): CsvDetectionResult {
  const utf8 = decodeBytes(bytes, "utf-8");
  // UTF-8 で読み取って文字化け (U+FFFD) があれば SJIS 試行
  if (!utf8 || utf8.includes("\uFFFD")) {
    const sjis = decodeBytes(bytes, "shift_jis");
    if (sjis) {
      const r = parseBankOrCardCsv(sjis, assumeKind);
      return { ...r, encoding: "shift_jis" };
    }
  }
  return parseBankOrCardCsv(utf8, assumeKind);
}

function decodeBytes(
  bytes: ArrayBuffer,
  encoding: "utf-8" | "shift_jis"
): string {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

/**
 * 対応銀行・カードのリストを公開 (UI で「対応銀行一覧」を出す用)
 */
export function supportedBanks(): {
  id: string;
  name: string;
  category: BankCategory;
}[] {
  return ADAPTERS.map((a) => ({
    id: a.id,
    name: a.name,
    category: a.category,
  }));
}

/**
 * findIdx は外部に公開しないが、動作確認用にテスト時だけ使える。
 */
export const __test__ = { findIdx, parseAmount, normalizeDate };
