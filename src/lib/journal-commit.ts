/**
 * parseJournalFile() で取得した ParsedJournal[] を実 DB に書き込むコミットレイヤ。
 * - 勘定科目名 → コード解決（既定の DEFAULT_ACCOUNTS + accounts テーブル）
 * - 不明勘定は未分類コード (999) で挿入し、警告と一覧で返す
 * - 貸借不一致を警告
 */

import { db } from "@/lib/localDb";
import { resolveAccountByName, UNCLASSIFIED_ACCOUNT_CODE } from "@/lib/accounts";
import type { ParsedJournal } from "@/lib/journal-import";

/**
 * 各会計ソフトの税区分名（日本語）を KAIKEI LOCAL の tax_classes.code に正規化する。
 * マッピングできないものは null を返して FK 違反を避ける。
 *
 * 判定は「売上か仕入か → 税率 → 軽減か」の順。以前は税率パターンを先に見ていたため
 * 「課税売上8%（軽）」が仕入の P08R になり、消費税集計で売上が仕入に化けていた。
 */
export function normalizeTaxCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // 全角英数・全角括弧・全角% を半角に寄せ、空白を除く
  const t = raw.normalize("NFKC").replace(/\s/g, "");
  if (!t) return null;
  // 既に正式コードの場合はそのまま（P10, OUT, S10 等）
  if (/^(OUT|NT|EXM|EXP|S(08|08R|10)|P(08|08R|10))$/.test(t)) return t;

  if (/対象外/.test(t)) return "OUT";
  if (/不課税/.test(t)) return "NT";
  if (/非課/.test(t)) return "EXM"; // 非課税 / 非課売上 / 非課仕入
  if (/輸出|免税売上/.test(t)) return "EXP";

  const isSales = /売上|課売/.test(t);
  const isPurchase = /仕入|課仕/.test(t);
  if (isSales === isPurchase) return null; // どちらとも言えない (両方 or どちらでもない)

  // 「10%控80」のように他の数字が混ざるので、% 付きを優先して税率を読む
  let rate: 10 | 8 | null = null;
  if (/10%/.test(t)) rate = 10;
  else if (/8%/.test(t)) rate = 8;
  else if (/10/.test(t)) rate = 10;
  else if (/8/.test(t)) rate = 8;
  if (rate === null) return null;

  const reduced = /軽/.test(t);
  if (isSales) return rate === 10 ? "S10" : reduced ? "S08R" : "S08";
  return rate === 10 ? "P10" : reduced ? "P08R" : "P08";
}

export interface CommitResult {
  inserted: number;
  skipped: number;
  warnings: string[];
  /** 科目表で解決できず「未分類 (999)」で登録した科目名 */
  unknownAccounts: string[];
}

export interface CommitOptions {
  /** 取込前から DB にある「同じ日付 + 摘要 + 借方合計」の仕訳はスキップする */
  dedupe?: boolean;
}

type AccountRef = { code: string; name: string };

async function buildAccountLookup(): Promise<(name: string) => AccountRef | null> {
  // DB 側 (マスタ取込・ユーザ追加分)。既定の科目表に無い名前だけここで引く。
  const dbByName = new Map<string, AccountRef>();
  const { data } = await db.from("accounts").select("code,name");
  for (const row of (data as { code: string; name: string }[] | null) || []) {
    if (!row.name) continue;
    dbByName.set(row.name.replace(/\s/g, ""), { code: row.code, name: row.name });
  }

  return (name: string) => {
    // 既定の科目表 (DEFAULT_ACCOUNTS) + 別名が正。DB の accounts テーブルに入るのは
    // 「マスタ CSV 取込をした時のシード + ユーザ追加分」だけで、新規インストール
    // 直後は空。DB だけを引くと、他ソフトから取り込んだ仕訳の科目がすべて
    // 「未分類 (999)」に落ちてしまうので、必ず既定セットを先に引く。
    return (
      resolveAccountByName(name) ?? dbByName.get(name.replace(/\s/g, "")) ?? null
    );
  };
}

/** 重複判定のキー。DB に保存される形 (空の摘要は取込元の仮摘要) で比べる。 */
function storedDescription(j: ParsedJournal): string {
  return j.description || `(${j.raw_source}から取込)`;
}

function dedupeKey(date: string, description: string, debitTotal: number): string {
  return `${date}\u0000${description}\u0000${debitTotal}`;
}

const IN_CHUNK = 400;

/**
 * 取込前から DB にある仕訳を「日付 + 摘要 + 借方合計」のキーごとに数える。
 *
 * 以前は 1 件ごとに「同じ日付・摘要の仕訳があるか」を DB に問い合わせていたため、
 *   - 同じ日に同じ摘要で金額だけ違う仕訳 (同じ店で 2 回買う等) の 2 件目以降が
 *     「重複」として捨てられ、
 *   - 同じファイル内の 1 件目が 2 件目の重複相手になり、
 *   - 摘要が空の仕訳は保存形と比較形が食い違って毎回二重に入っていた。
 * ここでは取込開始前のスナップショットだけを相手に、件数つきで突き合わせる。
 */
async function loadExistingKeyCounts(
  journals: ParsedJournal[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const dates = journals.map((j) => j.date).filter(Boolean).sort();
  if (dates.length === 0) return counts;

  const { data: rows, error } = await db
    .from("journals")
    .select("id, date, description")
    .gte("date", dates[0])
    .lte("date", dates[dates.length - 1]);
  if (error) throw error;
  const existing = (rows as { id: string; date: string; description: string }[] | null) || [];
  if (existing.length === 0) return counts;

  const debitById = new Map<string, number>();
  for (let i = 0; i < existing.length; i += IN_CHUNK) {
    const ids = existing.slice(i, i + IN_CHUNK).map((r) => r.id);
    const { data: lines, error: lineErr } = await db
      .from("journal_lines")
      .select("journal_id, debit_amount")
      .in("journal_id", ids);
    if (lineErr) throw lineErr;
    for (const l of (lines as { journal_id: string; debit_amount: number }[] | null) || []) {
      debitById.set(l.journal_id, (debitById.get(l.journal_id) || 0) + (l.debit_amount || 0));
    }
  }
  for (const r of existing) {
    const key = dedupeKey(r.date, r.description, debitById.get(r.id) || 0);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

export async function commitParsedJournals(
  journals: ParsedJournal[],
  opts: CommitOptions = {}
): Promise<CommitResult> {
  const warnings: string[] = [];
  let inserted = 0;
  let skipped = 0;

  const resolveAccount = await buildAccountLookup();
  const unknownAccounts = new Set<string>();
  const existingCounts = opts.dedupe
    ? await loadExistingKeyCounts(journals)
    : new Map<string, number>();

  for (const j of journals) {
    if (j.lines.length === 0) {
      warnings.push(`${j.date}: 明細なしのためスキップ`);
      skipped++;
      continue;
    }

    const totalDebit = j.lines.reduce((s, l) => s + l.debit_amount, 0);
    const totalCredit = j.lines.reduce((s, l) => s + l.credit_amount, 0);
    if (totalDebit !== totalCredit) {
      warnings.push(
        `${j.date} "${j.description}": 貸借不一致 (借${totalDebit} / 貸${totalCredit})`
      );
    }

    const description = storedDescription(j);

    // 重複チェック（取込前から DB にあった 日付 + 摘要 + 借方合計 と件数で突き合わせ）
    if (opts.dedupe) {
      const key = dedupeKey(j.date, description, totalDebit);
      const remaining = existingCounts.get(key) || 0;
      if (remaining > 0) {
        existingCounts.set(key, remaining - 1);
        skipped++;
        continue;
      }
    }

    const { data: journal, error: journalErr } = await db
      .from("journals")
      .insert({
        date: j.date,
        description,
        receipt_id: null,
      })
      .select()
      .single();
    if (journalErr || !journal) {
      // ここで止めないと、次行の journal.id で例外になり取込全体が中断していた
      warnings.push(
        `仕訳 "${j.description}" (${j.date}) の登録失敗: ${journalErr?.message ?? "不明なエラー"}`
      );
      skipped++;
      continue;
    }

    const journalId = (journal as { id: string }).id;

    const lineRecords = j.lines.map((line) => {
      const resolved = resolveAccount(line.account_name);
      if (!resolved && !line.account_code) {
        unknownAccounts.add(line.account_name || "(科目名なし)");
      }
      return {
        journal_id: journalId,
        account_code: resolved?.code || line.account_code || UNCLASSIFIED_ACCOUNT_CODE,
        account_name: resolved?.name || line.account_name || "未分類",
        debit_amount: line.debit_amount,
        credit_amount: line.credit_amount,
        tax_code: normalizeTaxCode(line.tax_code),
        tax_amount: line.tax_amount,
        partner_id: null,
        memo: line.memo,
      };
    });

    const { error: lineErr } = await db.from("journal_lines").insert(lineRecords);
    if (lineErr) {
      warnings.push(
        `仕訳 "${j.description}" の明細挿入失敗: ${lineErr.message}`
      );
      // 壊れた journal も削除して整合性を保つ
      await db.from("journals").delete().eq("id", journalId);
      skipped++;
      continue;
    }
    inserted++;
  }

  if (unknownAccounts.size > 0) {
    warnings.push(
      `科目表に無い科目が ${unknownAccounts.size} 件ありました（コード${UNCLASSIFIED_ACCOUNT_CODE}=未分類で仮登録。売上・経費の集計には入りません）: ${Array.from(
        unknownAccounts
      )
        .slice(0, 10)
        .join(", ")}${unknownAccounts.size > 10 ? " …" : ""}`
    );
  }

  return { inserted, skipped, warnings, unknownAccounts: Array.from(unknownAccounts) };
}
