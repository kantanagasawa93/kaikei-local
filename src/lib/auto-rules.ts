/**
 * 自動登録ルールのマッチング・学習ロジック
 */

import { db } from "@/lib/localDb";
import type { AutoRule, BankTransaction } from "@/types";

// 危険な regex パターン（catastrophic backtracking を誘発しやすい形）を検出する。
// 厳密な検証は不可能だが、代表的な「ネストした量指定子」を弾く。
function looksDangerousRegex(pattern: string): boolean {
  if (pattern.length > 200) return true;
  // (a+)+ / (a*)* / (.+)+ のようなパターンを大雑把に検出
  const suspicious = /\([^)]*[+*]\)[+*]/;
  return suspicious.test(pattern);
}

function safeRegexTest(pattern: string, input: string): boolean {
  if (looksDangerousRegex(pattern)) return false;
  try {
    const re = new RegExp(pattern);
    // 入力文字列が極端に長い場合は切り詰める
    const safeInput = input.length > 2000 ? input.slice(0, 2000) : input;
    return re.test(safeInput);
  } catch {
    return false;
  }
}

/**
 * 1件の銀行明細に対して、最も優先度の高いマッチルールを返す
 */
export async function findMatchingRule(
  tx: Pick<BankTransaction, "bank_account_id" | "description" | "amount" | "is_income">
): Promise<AutoRule | null> {
  const { data: rules } = await db
    .from("auto_rules")
    .select("*")
    .eq("is_enabled", 1);

  if (!rules) return null;

  const matches = (rules as AutoRule[])
    .filter((r) => {
      // 口座スコープ
      if (r.bank_account_id && r.bank_account_id !== tx.bank_account_id) return false;
      // 収支フィルタ
      if (r.is_income !== null && r.is_income !== undefined) {
        const ruleIncome = Boolean(r.is_income);
        if (ruleIncome !== tx.is_income) return false;
      }
      // 金額範囲
      const absAmount = Math.abs(tx.amount);
      if (r.amount_min != null && absAmount < r.amount_min) return false;
      if (r.amount_max != null && absAmount > r.amount_max) return false;
      // マッチ文字列
      const desc = tx.description || "";
      const needle = r.match_text || "";
      if (!needle) return false;
      switch (r.match_type) {
        case "contains":
          return desc.toLowerCase().includes(needle.toLowerCase());
        case "starts":
          return desc.toLowerCase().startsWith(needle.toLowerCase());
        case "equals":
          return desc === needle;
        case "regex":
          return safeRegexTest(needle, desc);
      }
      return false;
    })
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  return matches[0] || null;
}

/**
 * ルール適用履歴を1件追加。accepted が true なら「採用」、false なら「却下」。
 * ルール自体の applied_count / accepted_count も同時に更新する。
 */
export async function recordRuleApplication(
  ruleId: string,
  bankTransactionId: string | null,
  accepted: boolean
) {
  // 履歴行
  await db.from("auto_rule_applications").insert({
    rule_id: ruleId,
    bank_transaction_id: bankTransactionId,
    accepted: accepted ? 1 : 0,
  });

  // ルールのカウンタ更新
  const { data: r } = await db.from("auto_rules").select("*").eq("id", ruleId).single();
  if (!r) return;
  const rule = r as AutoRule;
  await db
    .from("auto_rules")
    .update({
      applied_count: (rule.applied_count ?? 0) + 1,
      accepted_count: (rule.accepted_count ?? 0) + (accepted ? 1 : 0),
    })
    .eq("id", ruleId);
}
