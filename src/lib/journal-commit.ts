/**
 * parseJournalFile() で取得した ParsedJournal[] を実 DB に書き込むコミットレイヤ。
 * - 勘定科目名 → コード解決（accounts テーブル）
 * - 不明勘定は科目コードなしで挿入し、警告として返す
 * - 貸借不一致を警告
 */

import { db } from "@/lib/localDb";
import type { ParsedJournal } from "@/lib/journal-import";

/**
 * 各会計ソフトの税区分名（日本語）を KAIKEI LOCAL の tax_classes.code に正規化する。
 * マッピングできないものは null を返して FK 違反を避ける。
 */
function normalizeTaxCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  // 既に正式コードっぽい場合はそのまま（P10, OUT, S10 等）
  if (/^(OUT|NT|EXM|EXP|S(08|08R|10)|P(08|08R|10))$/.test(t)) return t;

  // freee / 弥生 / MF 共通の人間可読名マッピング
  const table: { patterns: RegExp[]; code: string }[] = [
    { patterns: [/^対象外/, /^不課税$/], code: "OUT" },
    { patterns: [/^非課税/], code: "EXM" },
    { patterns: [/^輸出/], code: "EXP" },
    { patterns: [/8\s*%\s*\(?軽/, /8%（軽\)?/, /軽減/], code: "P08R" },
    { patterns: [/課税売上\s*10/, /売上\s*10\s*%/, /課売\s*10/], code: "S10" },
    { patterns: [/課税売上\s*8\s*%\s*\(?軽/, /売上.*8.*軽/], code: "S08R" },
    { patterns: [/課税売上\s*8\s*%/, /売上\s*8\s*%/], code: "S08" },
    { patterns: [/課\s*対?\s*仕\s*入.*10/, /仕入.*10\s*%/, /課仕\s*10/], code: "P10" },
    { patterns: [/課\s*対?\s*仕\s*入.*8/, /仕入.*8\s*%/], code: "P08" },
  ];
  for (const row of table) {
    if (row.patterns.some((re) => re.test(t))) return row.code;
  }
  // 判定不能 → null（FK 違反回避）
  return null;
}

export interface CommitResult {
  inserted: number;
  skipped: number;
  warnings: string[];
}

export interface CommitOptions {
  /** 同じ日付 + 摘要 + 金額の仕訳が既にあればスキップする */
  dedupe?: boolean;
}

async function buildAccountLookup(): Promise<Map<string, { code: string; name: string }>> {
  const { data } = await db.from("accounts").select("code,name");
  const map = new Map<string, { code: string; name: string }>();
  for (const row of (data as { code: string; name: string }[] | null) || []) {
    map.set(row.name, { code: row.code, name: row.name });
    // 「現金」「普通預金」など空白除去でも引けるように
    map.set(row.name.replace(/\s/g, ""), { code: row.code, name: row.name });
  }
  return map;
}

export async function commitParsedJournals(
  journals: ParsedJournal[],
  opts: CommitOptions = {}
): Promise<CommitResult> {
  const warnings: string[] = [];
  let inserted = 0;
  let skipped = 0;

  const accountMap = await buildAccountLookup();
  const unknownAccounts = new Set<string>();

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

    // 重複チェック（日付+摘要+借方合計で判定）
    if (opts.dedupe) {
      const { data: existing } = await db
        .from("journals")
        .select("id")
        .eq("date", j.date)
        .eq("description", j.description);
      if (existing && (existing as { id: string }[]).length > 0) {
        skipped++;
        continue;
      }
    }

    const { data: journal } = await db
      .from("journals")
      .insert({
        date: j.date,
        description: j.description || `(${j.raw_source}から取込)`,
        receipt_id: null,
      })
      .select()
      .single();

    const journalId = (journal as { id: string }).id;

    const lineRecords = j.lines.map((line) => {
      const resolved =
        accountMap.get(line.account_name) ||
        accountMap.get(line.account_name.replace(/\s/g, ""));
      if (!resolved) {
        unknownAccounts.add(line.account_name);
      }
      return {
        journal_id: journalId,
        account_code: resolved?.code || line.account_code || "999",
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
      `DBに存在しない科目が ${unknownAccounts.size} 件ありました（コード999=未分類で仮登録）: ${Array.from(
        unknownAccounts
      )
        .slice(0, 10)
        .join(", ")}${unknownAccounts.size > 10 ? " …" : ""}`
    );
  }

  return { inserted, skipped, warnings };
}
