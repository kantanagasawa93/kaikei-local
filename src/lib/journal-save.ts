/**
 * 仕訳 (ヘッダ + 明細) の保存。新規登録ページと編集ページの共通処理。
 *
 * localDb にはトランザクションが無いので、「途中で失敗しても壊れた仕訳を残さない」
 * ことを書き込みの順序と後始末で保証する:
 *   - 新規: ヘッダ → 明細。明細に失敗したらヘッダを消す
 *   - 編集: ヘッダ更新 → 新しい明細を追加 → 古い明細を削除。
 *           以前は「古い明細を全部消してから新しい明細を入れる」順だったため、
 *           挿入に失敗すると明細が 1 行も無い仕訳が残り、一覧に出せず
 *           編集も削除もできなくなっていた。
 */

import { db } from "@/lib/localDb";

export interface JournalLineDraft {
  account_code: string;
  account_name: string;
  debit_amount: number;
  credit_amount: number;
  tax_code: string | null;
  tax_amount: number;
  partner_id: string | null;
  memo: string | null;
}

/** 科目も金額も入っていない、ただの空行か。 */
function isBlankLine(l: JournalLineDraft): boolean {
  return !l.account_code && !l.debit_amount && !l.credit_amount;
}

/** 保存対象の明細 (完全な空行は除く)。 */
export function meaningfulLines<T extends JournalLineDraft>(lines: T[]): T[] {
  return lines.filter((l) => !isBlankLine(l));
}

/**
 * 明細を保存できない理由を返す (問題なければ null)。
 *
 * 貸借の一致だけを見ていると、科目の無い行 (どの集計にも出てこない)・
 * 金額の無い行・借方と貸方の両方に金額がある行がそのまま保存されてしまう。
 */
export function validateJournalLines(lines: JournalLineDraft[]): string | null {
  const rows = meaningfulLines(lines);
  const totalDebit = rows.reduce((s, l) => s + (l.debit_amount || 0), 0);
  const totalCredit = rows.reduce((s, l) => s + (l.credit_amount || 0), 0);

  if (rows.length === 0 || (totalDebit === 0 && totalCredit === 0)) {
    return "金額が未入力です。借方・貸方に同額を入力してください。";
  }
  for (const [i, l] of rows.entries()) {
    const no = `${i + 1} 行目`;
    if (l.debit_amount < 0 || l.credit_amount < 0) {
      return `${no}: 金額にマイナスは入力できません（逆の側に入力してください）。`;
    }
    if (!Number.isInteger(l.debit_amount) || !Number.isInteger(l.credit_amount)) {
      return `${no}: 金額は 1 円単位の整数で入力してください。`;
    }
    if (l.debit_amount > 0 && l.credit_amount > 0) {
      return `${no}: 借方と貸方の両方に金額があります。1 行にはどちらか片方だけ入力してください。`;
    }
    if (!l.account_code) {
      return `${no}: 勘定科目が選ばれていません。`;
    }
    if (!l.debit_amount && !l.credit_amount) {
      return `${no}（${l.account_name || l.account_code}）: 金額が未入力です。`;
    }
  }
  if (totalDebit !== totalCredit) {
    return `借方と貸方の合計が一致していません（差額 ${Math.abs(
      totalDebit - totalCredit,
    ).toLocaleString()}円）。`;
  }
  return null;
}

function toRows(journalId: string, lines: JournalLineDraft[]): Record<string, unknown>[] {
  return meaningfulLines(lines).map((line) => ({
    id: crypto.randomUUID(),
    journal_id: journalId,
    account_code: line.account_code,
    account_name: line.account_name,
    debit_amount: line.debit_amount,
    credit_amount: line.credit_amount,
    tax_code: line.tax_code,
    tax_amount: line.tax_amount,
    partner_id: line.partner_id,
    memo: line.memo,
  }));
}

async function deleteLinesByIds(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 400) {
    const { error } = await db.from("journal_lines").delete().in("id", ids.slice(i, i + 400));
    if (error) throw error;
  }
}

export interface JournalDraft {
  date: string;
  description: string;
  lines: JournalLineDraft[];
  receipt_id?: string | null;
}

/** 仕訳を新規登録する。失敗したら何も残さずに例外を投げる。 */
export async function createJournal(draft: JournalDraft): Promise<string> {
  const problem = validateJournalLines(draft.lines);
  if (problem) throw new Error(problem);

  const journalId = crypto.randomUUID();
  const { error: headerError } = await db.from("journals").insert({
    id: journalId,
    date: draft.date,
    description: draft.description,
    receipt_id: draft.receipt_id ?? null,
  });
  if (headerError) throw headerError;

  const { error: linesError } = await db
    .from("journal_lines")
    .insert(toRows(journalId, draft.lines));
  if (linesError) {
    // 明細の無い仕訳を残さない (journal_lines は ON DELETE CASCADE)
    await db.from("journals").delete().eq("id", journalId);
    throw linesError;
  }
  return journalId;
}

/** 既存の仕訳を、与えた内容で置き換える。失敗したら元の明細を残して例外を投げる。 */
export async function replaceJournal(
  journalId: string,
  draft: Omit<JournalDraft, "receipt_id">,
): Promise<void> {
  const problem = validateJournalLines(draft.lines);
  if (problem) throw new Error(problem);

  const { data: existing, error: existingError } = await db
    .from("journals")
    .select("id, date, description")
    .eq("id", journalId)
    .single();
  if (existingError) throw existingError;
  const before = existing as { id: string; date: string; description: string } | null;
  if (!before) throw new Error("この仕訳は既に削除されています");

  const { data: oldLines, error: oldError } = await db
    .from("journal_lines")
    .select("id")
    .eq("journal_id", journalId);
  if (oldError) throw oldError;
  const oldIds = ((oldLines as { id: string }[] | null) ?? []).map((l) => l.id);

  const { error: headerError } = await db
    .from("journals")
    .update({ date: draft.date, description: draft.description })
    .eq("id", journalId);
  if (headerError) throw headerError;

  const newRows = toRows(journalId, draft.lines);
  const newIds = newRows.map((r) => r.id as string);
  const restoreHeader = () =>
    db
      .from("journals")
      .update({ date: before.date, description: before.description })
      .eq("id", journalId);

  const { error: insertError } = await db.from("journal_lines").insert(newRows);
  if (insertError) {
    // 途中まで入った新しい明細を消し、ヘッダも戻す (古い明細は手つかずで残っている)
    await deleteLinesByIds(newIds).catch(() => {});
    await restoreHeader();
    throw insertError;
  }
  try {
    await deleteLinesByIds(oldIds);
  } catch (e) {
    // 古い明細を消せなかった → 新旧が二重に並ぶので、新しい方を取り除いて元の状態へ
    await deleteLinesByIds(newIds).catch(() => {});
    await restoreHeader();
    throw e;
  }
}
