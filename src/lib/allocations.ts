/**
 * 家事按分。
 *
 * 通信費・水道光熱費のように事業と私用で共用している経費について、
 * 科目ごとの年間合計に事業利用比率を掛け、家事分を 12/31 付で事業主貸へ振り替える。
 *
 * 以前はページ内に直接書かれていて、次の不具合があった:
 *   - 年間合計に「前回生成した按分仕訳」自身が含まれていたため、再計算するたびに
 *     按分後の金額をもう一度按分してしまい、押すたびに金額が変わっていた
 *   - 画面に表示中の (古い) 合計で仕訳を作っていた
 *   - 按分ルールを消しても生成済みの仕訳が帳簿に残った
 *   - 同じ科目を 2 回登録でき、二重に按分された
 *   - DB エラーを見ておらず、明細の無い仕訳が残り得た
 */

import { db } from "@/lib/localDb";
import { getAccountByCode } from "@/lib/accounts";
import type { BizAllocation } from "@/types";

/** 家事分の振替先 (事業主貸)。 */
const OWNER_DRAW = { code: "190", name: "事業主貸" } as const;

/**
 * ここでは按分しない科目。
 * 611 減価償却費: 固定資産台帳の「仕訳化」が事業専用割合を掛けた金額で計上し、
 * 家事分は最初から事業主貸に入れている。ここでも按分すると二重になる。
 */
export const NON_ALLOCATABLE_ACCOUNT_CODES: ReadonlySet<string> = new Set(["611"]);

export type AllocationRow = BizAllocation & {
  /** 按分前の年間合計 (生成済みの按分仕訳は除く) */
  total_amount: number;
  business_amount: number;
  private_amount: number;
  /** 生成済みの按分仕訳で事業主貸に振り替えている金額 (無ければ 0) */
  posted_private_amount: number;
  /** 帳簿に反映済みの金額と、いま計算した家事分が一致しているか */
  in_sync: boolean;
};

/** 年間合計を事業分と家事分に分ける (事業分は切り捨て)。 */
export function splitAllocation(
  total: number,
  businessRatio: number,
): { business: number; private: number } {
  const business = Math.floor((total * businessRatio) / 100);
  return { business, private: total - business };
}

function chunk<T>(items: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type LineRow = {
  journal_id: string;
  account_code: string;
  debit_amount: number;
  credit_amount: number;
};

async function loadLines(journalIds: string[]): Promise<LineRow[]> {
  const out: LineRow[] = [];
  for (const ids of chunk(journalIds)) {
    const { data, error } = await db
      .from("journal_lines")
      .select("journal_id, account_code, debit_amount, credit_amount")
      .in("journal_id", ids);
    if (error) throw error;
    out.push(...((data as LineRow[] | null) ?? []));
  }
  return out;
}

/** 指定年度の按分ルールと、按分前の年間合計・家事分を返す。 */
export async function loadAllocationRows(year: number): Promise<AllocationRow[]> {
  const { data: allocData, error: allocError } = await db
    .from("biz_allocations")
    .select("*")
    .eq("fiscal_year", year)
    .order("account_code");
  if (allocError) throw allocError;
  const allocs = (allocData as BizAllocation[] | null) ?? [];
  if (allocs.length === 0) return [];

  const generatedIds = new Set(
    allocs.map((a) => a.generated_journal_id).filter((id): id is string => !!id),
  );

  const { data: journalData, error: journalError } = await db
    .from("journals")
    .select("id")
    .gte("date", `${year}-01-01`)
    .lte("date", `${year}-12-31`);
  if (journalError) throw journalError;
  // 按分前の合計が欲しいので、前回生成した按分仕訳は集計に入れない
  const journalIds = ((journalData as { id: string }[] | null) ?? [])
    .map((j) => j.id)
    .filter((id) => !generatedIds.has(id));

  const totals = new Map<string, number>();
  for (const l of await loadLines(journalIds)) {
    totals.set(
      l.account_code,
      (totals.get(l.account_code) ?? 0) + ((l.debit_amount || 0) - (l.credit_amount || 0)),
    );
  }

  // 生成済みの按分仕訳が、いま事業主貸にいくら振り替えているか
  const posted = new Map<string, number>();
  for (const l of await loadLines([...generatedIds])) {
    if (l.account_code !== OWNER_DRAW.code) continue;
    posted.set(l.journal_id, (posted.get(l.journal_id) ?? 0) + (l.debit_amount || 0));
  }

  return allocs.map((a) => {
    const total = totals.get(a.account_code) ?? 0;
    const split = splitAllocation(total, a.business_ratio);
    const postedAmount = a.generated_journal_id ? (posted.get(a.generated_journal_id) ?? 0) : 0;
    const expected = allocatable(a.account_code) && split.private > 0 ? split.private : 0;
    return {
      ...a,
      total_amount: total,
      business_amount: split.business,
      private_amount: split.private,
      posted_private_amount: postedAmount,
      in_sync: postedAmount === expected,
    };
  });
}

function allocatable(accountCode: string): boolean {
  return !NON_ALLOCATABLE_ACCOUNT_CODES.has(accountCode);
}

/** 按分ルールを追加する。同じ年度・同じ科目の二重登録は拒否する。 */
export async function addAllocation(input: {
  account_code: string;
  business_ratio: number;
  fiscal_year: number;
}): Promise<void> {
  const account = getAccountByCode(input.account_code);
  if (!account) throw new Error("勘定科目を選んでください");
  if (!allocatable(input.account_code)) {
    throw new Error(
      `${account.name}は固定資産台帳の事業専用割合で按分されるため、ここでは登録できません`,
    );
  }
  const ratio = Math.round(input.business_ratio);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 100) {
    throw new Error("事業利用比率は 0〜100 で入力してください");
  }

  const { data: existing, error: existingError } = await db
    .from("biz_allocations")
    .select("id")
    .eq("fiscal_year", input.fiscal_year)
    .eq("account_code", input.account_code);
  if (existingError) throw existingError;
  if (((existing as { id: string }[] | null) ?? []).length > 0) {
    throw new Error(
      `${input.fiscal_year}年の${account.name}は登録済みです。比率を変える時は、いったん削除してから登録し直してください`,
    );
  }

  const { error } = await db.from("biz_allocations").insert({
    account_code: input.account_code,
    account_name: account.name,
    business_ratio: ratio,
    fiscal_year: input.fiscal_year,
  });
  if (error) throw error;
}

async function deleteJournal(id: string): Promise<void> {
  // journal_lines は ON DELETE CASCADE、biz_allocations.generated_journal_id は SET NULL
  const { error } = await db.from("journals").delete().eq("id", id);
  if (error) throw error;
}

/** 按分ルールを削除する。生成済みの按分仕訳も一緒に取り消す。 */
export async function deleteAllocation(id: string): Promise<void> {
  const { data, error } = await db
    .from("biz_allocations")
    .select("id, generated_journal_id")
    .eq("id", id)
    .single();
  if (error) throw error;
  const row = data as { id: string; generated_journal_id: string | null } | null;
  if (!row) return; // 既に無い
  if (row.generated_journal_id) await deleteJournal(row.generated_journal_id);
  const { error: deleteError } = await db.from("biz_allocations").delete().eq("id", id);
  if (deleteError) throw deleteError;
}

export interface RecalculateResult {
  /** 按分仕訳を作った (作り直した) 件数 */
  generated: number;
  /** 家事分が無く、仕訳を作らなかった (既存があれば取り消した) 件数 */
  cleared: number;
  /** ここでは按分しない科目のため飛ばしたルール (科目名) */
  skipped: string[];
}

/**
 * 指定年度の按分仕訳を作り直す。
 *
 * ルールごとに「新しい仕訳を作る → ルールの参照を付け替える → 古い仕訳を消す」の順で進める。
 * 先に古い仕訳を消すと、途中で失敗した時に按分が帳簿から消えたままになる
 * (= 家事分まで経費に入った状態になる) ため。
 */
export async function recalculateAllocations(year: number): Promise<RecalculateResult> {
  // 画面の表示ではなく、必ず DB から取り直した合計で計算する
  const rows = await loadAllocationRows(year);
  const result: RecalculateResult = { generated: 0, cleared: 0, skipped: [] };
  const now = new Date().toISOString();

  for (const row of rows) {
    const oldJournalId = row.generated_journal_id;

    if (!allocatable(row.account_code) || row.private_amount <= 0) {
      if (oldJournalId) await deleteJournal(oldJournalId);
      const { error } = await db
        .from("biz_allocations")
        .update({ last_calculated_at: now, generated_journal_id: null })
        .eq("id", row.id);
      if (error) throw error;
      if (allocatable(row.account_code)) result.cleared++;
      else result.skipped.push(row.account_name);
      continue;
    }

    const journalId = crypto.randomUUID();
    const { error: headerError } = await db.from("journals").insert({
      id: journalId,
      date: `${year}-12-31`,
      description: `家事按分: ${row.account_name} (事業利用${row.business_ratio}%)`,
      is_adjustment: true,
    });
    if (headerError) throw headerError;

    const { error: linesError } = await db.from("journal_lines").insert([
      {
        journal_id: journalId,
        account_code: OWNER_DRAW.code,
        account_name: OWNER_DRAW.name,
        debit_amount: row.private_amount,
        credit_amount: 0,
        tax_code: "OUT",
        tax_amount: 0,
      },
      {
        journal_id: journalId,
        account_code: row.account_code,
        account_name: row.account_name,
        debit_amount: 0,
        credit_amount: row.private_amount,
        tax_code: "OUT",
        tax_amount: 0,
      },
    ]);
    if (linesError) {
      await db.from("journals").delete().eq("id", journalId); // 明細の無い仕訳を残さない
      throw linesError;
    }

    const { error: linkError } = await db
      .from("biz_allocations")
      .update({ last_calculated_at: now, generated_journal_id: journalId })
      .eq("id", row.id);
    if (linkError) {
      await db.from("journals").delete().eq("id", journalId);
      throw linkError;
    }

    if (oldJournalId) {
      try {
        await deleteJournal(oldJournalId);
      } catch (e) {
        // 古い仕訳を消せなかった → 新旧が二重に効くので、新しい方を取り消して元へ戻す
        await db
          .from("biz_allocations")
          .update({
            last_calculated_at: row.last_calculated_at,
            generated_journal_id: oldJournalId,
          })
          .eq("id", row.id);
        await db.from("journals").delete().eq("id", journalId);
        throw e;
      }
    }
    result.generated++;
  }
  return result;
}
