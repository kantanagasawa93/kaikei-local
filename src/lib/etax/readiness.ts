/**
 * Round 25 ㊠: 確定申告の「準備状況」を自動診断する.
 *
 * 1/1〜3/15 の確定申告期にダッシュボードに自動表示する用。
 * ユーザに何も操作させずに「あと何が足りないか」を表示する。
 *
 * 各チェックは独立: 1 つだけ ✗ でも進められる項目もある (= warning 程度)。
 * - critical: ✗ なら e-Tax 不可
 * - warning: あった方が良いが必須ではない
 * - ok: 完了
 */

import { db } from "@/lib/localDb";

export type CheckStatus = "ok" | "warning" | "error";

export interface ReadinessCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** クリック時にどこへ誘導するか (相対 path)。null なら遷移しない */
  href: string | null;
}

export interface ReadinessReport {
  year: number;
  /** 全体的な完了度 (0-100%) */
  completionPct: number;
  /** 「e-Tax 提出可能」になるための critical な未完了がいくつあるか */
  blockers: number;
  /** 1/1〜3/15 期間内かどうか — 期間外なら表示しない方針 */
  inWindow: boolean;
  checks: ReadinessCheck[];
}

/**
 * 確定申告の対象年度は「前年」が基本。
 * 例: 2026/2/15 の時点では「2025 年分」を申告する。
 * 1/1〜3/15 を確定申告期、それ以外は inWindow=false。
 */
export function getTargetFiscalYear(now: Date = new Date()): {
  year: number;
  inWindow: boolean;
} {
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const inWindow = month <= 3 && (month < 3 || day <= 15);
  // 確定申告期は前年分を扱う
  const year = inWindow ? now.getFullYear() - 1 : now.getFullYear();
  return { year, inWindow };
}

export async function checkReadiness(
  now: Date = new Date(),
): Promise<ReadinessReport> {
  const { year, inWindow } = getTargetFiscalYear(now);
  const checks: ReadinessCheck[] = [];
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;

  // 1) 発行者情報 (issuer_settings)
  try {
    const { data } = await db
      .from("issuer_settings")
      .select("business_name, owner_name, address, registered_number")
      .eq("id", "singleton")
      .single();
    const iss = data as
      | {
          business_name?: string | null;
          owner_name?: string | null;
          address?: string | null;
          registered_number?: string | null;
        }
      | null;
    const filled = [
      iss?.business_name,
      iss?.owner_name,
      iss?.address,
    ].filter((v): v is string => Boolean(v && v.trim().length > 0));
    if (filled.length === 3) {
      checks.push({
        id: "issuer_basic",
        label: "発行者情報 (屋号 / 氏名 / 住所)",
        status: "ok",
        detail: "登録済み",
        href: "/invoices/issuer",
      });
    } else {
      checks.push({
        id: "issuer_basic",
        label: "発行者情報 (屋号 / 氏名 / 住所)",
        status: "error",
        detail: `${filled.length}/3 項目だけ登録済み — e-Tax 提出に必要`,
        href: "/invoices/issuer",
      });
    }
    if (iss?.registered_number) {
      checks.push({
        id: "issuer_invoice",
        label: "インボイス登録番号",
        status: "ok",
        detail: iss.registered_number,
        href: "/invoices/issuer",
      });
    } else {
      checks.push({
        id: "issuer_invoice",
        label: "インボイス登録番号",
        status: "warning",
        detail: "未登録 — 登録事業者なら必ず入力 (免税事業者は不要)",
        href: "/invoices/issuer",
      });
    }
  } catch {
    checks.push({
      id: "issuer_basic",
      label: "発行者情報",
      status: "error",
      detail: "未登録",
      href: "/invoices/issuer",
    });
  }

  // 2) 仕訳件数 (年度内)
  let journalCount = 0;
  let incompleteCount = 0;
  let lastJournalDate: string | null = null;
  try {
    const { data: js } = await db
      .from("journals")
      .select("id, date, description, journal_lines(debit_amount, credit_amount)")
      .gte("date", start)
      .lte("date", end);
    const rows = (js as Array<{
      id: string;
      date: string;
      description: string | null;
      journal_lines: { debit_amount: number; credit_amount: number }[] | null;
    }> | null) ?? [];
    journalCount = rows.length;
    for (const j of rows) {
      const lines = j.journal_lines ?? [];
      const total = lines.reduce(
        (a, ln) => a + (ln.debit_amount || 0) + (ln.credit_amount || 0),
        0,
      );
      const isIncomplete =
        lines.length === 0 ||
        total === 0 ||
        (j.description &&
          (j.description.startsWith("不明 - ") || j.description === "不明"));
      if (isIncomplete) incompleteCount++;
      if (!lastJournalDate || j.date > lastJournalDate) {
        lastJournalDate = j.date;
      }
    }
  } catch {
    /* DB 失敗 → 0 件として扱う */
  }
  if (journalCount === 0) {
    checks.push({
      id: "journals",
      label: "仕訳",
      status: "error",
      detail: `${year} 年分の仕訳が 1 件も登録されていません`,
      href: "/journals",
    });
  } else {
    checks.push({
      id: "journals",
      label: "仕訳",
      status: "ok",
      detail: `${journalCount} 件登録済み (最終: ${lastJournalDate})`,
      href: "/journals",
    });
  }

  // 3) 不完全な仕訳
  if (incompleteCount > 0) {
    checks.push({
      id: "incomplete_journals",
      label: "不完全な仕訳",
      status: "warning",
      detail: `${incompleteCount} 件 — 金額 0 or 摘要が「不明」`,
      href: "/journals?incomplete=1",
    });
  } else if (journalCount > 0) {
    checks.push({
      id: "incomplete_journals",
      label: "不完全な仕訳",
      status: "ok",
      detail: "なし",
      href: null,
    });
  }

  // 4) 未仕訳の領収書 (受信箱で領収書判定済みだが仕訳化されてないもの)
  try {
    const { data: rec } = await db
      .from("photo_inbox")
      .select("id")
      .eq("state", "receipt");
    const pendingReceiptCount = ((rec as { id: string }[] | null) ?? []).length;
    if (pendingReceiptCount > 0) {
      checks.push({
        id: "pending_receipts",
        label: "未仕訳の領収書",
        status: "warning",
        detail: `${pendingReceiptCount} 件 — 受信箱から「すべて自動仕訳」で処理`,
        href: "/inbox",
      });
    } else {
      checks.push({
        id: "pending_receipts",
        label: "未仕訳の領収書",
        status: "ok",
        detail: "なし",
        href: null,
      });
    }
  } catch {
    /* silent */
  }

  // 5) 最終仕訳日が前年 12 月以前 (= 当年に何も入力されていない) なら警告
  if (lastJournalDate && lastJournalDate < `${year}-12-01` && inWindow) {
    checks.push({
      id: "stale_journals",
      label: "12 月の仕訳",
      status: "warning",
      detail: `最終仕訳が ${lastJournalDate} — 12 月分の入力漏れがないか確認`,
      href: `/journals?month=${year}-12`,
    });
  }

  // 集計
  const errors = checks.filter((c) => c.status === "error").length;
  const warnings = checks.filter((c) => c.status === "warning").length;
  const oks = checks.filter((c) => c.status === "ok").length;
  const total = checks.length;
  const completionPct = total > 0 ? Math.round((oks / total) * 100) : 0;

  return {
    year,
    completionPct,
    blockers: errors,
    inWindow,
    checks,
  };
}

// テスト用
export const __test__ = { getTargetFiscalYear };
