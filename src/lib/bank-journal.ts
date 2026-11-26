/**
 * 銀行・カード明細の取り込みと仕訳化 (明細取込ページの処理を切り出したもの)。
 *
 * 直した点:
 *   - 同じ期間の CSV をもう一度取り込むと、同じ明細が丸ごと二重に入っていた
 *     (銀行の CSV は期間が重なるのが普通) → 既に入っている明細は飛ばす
 *   - 「仕訳作成」を素早く 2 回押すと仕訳が 2 本できた → 処理中・仕訳済みは拒否
 *   - DB エラーを見ておらず、明細の無い仕訳が残ったまま「仕訳済み」になり得た
 *   - 消費税額を税区分に関係なく 10/110 で計算していた (対象外・軽減 8% でも 10%)
 */

import { db } from "@/lib/localDb";
import { findAccountCodeByName, getAccountByCode } from "@/lib/accounts";
import { findMatchingRule, recordRuleApplication } from "@/lib/auto-rules";
import { createJournal } from "@/lib/journal-save";
import { defaultTaxCodeForAccountCode, extractTaxFromIncluded } from "@/lib/tax-classes";
import type { ParsedTransaction } from "@/lib/csv-import";
import type { BankAccount, BankTransaction } from "@/types";

// ---------------------------------------------------------------------------
// 取り込み
// ---------------------------------------------------------------------------

/** 同じ明細かどうかを決めるキー (残高は銀行 CSV にしか無いので、あれば含める)。 */
function txKey(t: {
  date: string;
  description: string;
  amount: number;
  is_income: boolean | number;
  balance_after: number | null;
}): string {
  return [t.date, t.description, t.amount, t.is_income ? 1 : 0, t.balance_after ?? ""].join("\u0000");
}

/**
 * 取り込む明細のうち、まだ DB に無い分だけを返す (純関数)。
 * 同じ日・同じ摘要・同じ金額の明細が本当に 2 件あることもあるので、件数で比べる:
 * CSV に 3 件・DB に 1 件なら 2 件を新規として扱う。
 */
export function selectNewTransactions<T extends ParsedTransaction>(
  parsed: T[],
  existing: Pick<BankTransaction, "date" | "description" | "amount" | "is_income" | "balance_after">[],
): T[] {
  const remaining = new Map<string, number>();
  for (const e of existing) {
    const k = txKey(e);
    remaining.set(k, (remaining.get(k) ?? 0) + 1);
  }
  const out: T[] = [];
  for (const p of parsed) {
    const k = txKey(p);
    const left = remaining.get(k) ?? 0;
    if (left > 0) {
      remaining.set(k, left - 1);
      continue;
    }
    out.push(p);
  }
  return out;
}

/** CSV から読んだ明細を口座に取り込む。既に入っている明細は飛ばす。 */
export async function importBankTransactions(
  bankAccountId: string,
  parsed: ParsedTransaction[],
): Promise<{ added: number; skipped: number }> {
  if (parsed.length === 0) return { added: 0, skipped: 0 };
  const dates = parsed.map((p) => p.date).sort();
  const { data, error } = await db
    .from("bank_transactions")
    .select("date, description, amount, is_income, balance_after")
    .eq("bank_account_id", bankAccountId)
    .gte("date", dates[0])
    .lte("date", dates[dates.length - 1]);
  if (error) throw error;
  const fresh = selectNewTransactions(parsed, (data as BankTransaction[] | null) ?? []);

  let added = 0;
  for (let i = 0; i < fresh.length; i += 200) {
    const batch = fresh.slice(i, i + 200).map((t) => ({
      bank_account_id: bankAccountId,
      date: t.date,
      description: t.description,
      amount: t.amount,
      balance_after: t.balance_after,
      is_income: t.is_income,
      category: t.suggested_account_name,
      status: "unmatched",
    }));
    const { error: insertError } = await db.from("bank_transactions").insert(batch);
    if (insertError) {
      throw new Error(
        `${added} 件まで取り込んだところで失敗しました（もう一度取り込むと、残りだけが追加されます）: ${
          (insertError as Error).message ?? insertError
        }`,
      );
    }
    added += batch.length;
  }
  return { added, skipped: parsed.length - fresh.length };
}

// ---------------------------------------------------------------------------
// 仕訳化
// ---------------------------------------------------------------------------

const inFlight = new Set<string>();

export class BankTxAlreadyHandledError extends Error {
  constructor() {
    super("この明細は既に仕訳済み（または処理中）です");
    this.name = "BankTxAlreadyHandledError";
  }
}

/** 明細 1 件を仕訳にする。作った仕訳の id を返す。 */
export async function journalizeBankTransaction(
  tx: BankTransaction,
  account: Pick<BankAccount, "account_type"> | undefined,
): Promise<string> {
  if (inFlight.has(tx.id)) throw new BankTxAlreadyHandledError();
  inFlight.add(tx.id);
  try {
    // 画面の表示は古いかもしれないので、DB の現在の状態で判定する
    const { data: freshData, error: freshError } = await db
      .from("bank_transactions")
      .select("id, status, journal_id")
      .eq("id", tx.id)
      .single();
    if (freshError) throw freshError;
    const fresh = freshData as { status: string; journal_id: string | null } | null;
    if (!fresh) throw new Error("この明細は既に削除されています");
    if (fresh.status === "matched" || fresh.journal_id) throw new BankTxAlreadyHandledError();

    const amount = Math.abs(Math.round(tx.amount));
    if (amount === 0) throw new Error("金額が 0 円の明細は仕訳にできません");
    const matched = await findMatchingRule(tx);
    const isIncome = Boolean(tx.is_income);
    // カード明細の相手科目は未払金、それ以外 (銀行) は普通預金
    const counter =
      account?.account_type === "bank" || !account
        ? { code: "110", name: "普通預金" }
        : { code: "210", name: "未払金" };

    let code: string;
    let name: string;
    if (matched && matched.action_type !== "ignore" && matched.account_code) {
      code = matched.account_code;
      name = matched.account_name || getAccountByCode(code)?.name || code;
    } else if (isIncome) {
      code = "400";
      name = getAccountByCode("400")?.name ?? "売上高";
    } else {
      const byCategory = tx.category ? findAccountCodeByName(tx.category) : null;
      code = byCategory ?? "699";
      name = getAccountByCode(code)?.name ?? "雑費";
    }
    // 税区分: ルールの指定 > 科目の既定 (租税公課は対象外、保険料は非課税 など)
    const taxCode = matched?.tax_code || defaultTaxCodeForAccountCode(code);
    const taxAmount = extractTaxFromIncluded(amount, taxCode);

    const main = {
      account_code: code,
      account_name: name,
      debit_amount: isIncome ? 0 : amount,
      credit_amount: isIncome ? amount : 0,
      tax_code: taxCode,
      tax_amount: taxAmount,
      partner_id: matched?.partner_id ?? null,
      memo: null,
    };
    const other = {
      account_code: counter.code,
      account_name: counter.name,
      debit_amount: isIncome ? amount : 0,
      credit_amount: isIncome ? 0 : amount,
      tax_code: "OUT",
      tax_amount: 0,
      partner_id: null,
      memo: null,
    };
    const journalId = await createJournal({
      date: tx.date,
      description: tx.description,
      lines: isIncome ? [other, main] : [main, other],
    });

    const { error: linkError } = await db
      .from("bank_transactions")
      .update({ status: "matched", journal_id: journalId })
      .eq("id", tx.id);
    if (linkError) {
      // 明細と結び付けられなかった仕訳を残すと、もう一度押した時に二重になる
      await db.from("journals").delete().eq("id", journalId);
      throw linkError;
    }

    // ルール採用履歴 (失敗しても仕訳は出来ているので握る)
    if (matched) {
      try {
        await recordRuleApplication(matched.id, tx.id, true);
      } catch {
        /* 統計だけの記録 */
      }
    }
    return journalId;
  } finally {
    inFlight.delete(tx.id);
  }
}
