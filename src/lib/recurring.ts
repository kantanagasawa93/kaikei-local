/**
 * Round 27 ㊤: 定期取引候補の自動検出.
 *
 * 過去 6 ヶ月の仕訳から「同 partner / 同金額が毎月発生」しているパターンを検出。
 * ダッシュボードに「定期取引候補 N 件」を表示し、ワンクリックで auto_rules に
 * ルール登録できるようにする (取引登録時の労力を激減)。
 *
 * 検出ロジック:
 *   - 過去 180 日の journals + journal_lines を取得
 *   - グルーピング: partner_id (or vendor 推定) + 借方金額の最大値
 *   - 同一グループに 3 件以上 + 月次間隔 (28-35 日刻み) なら "monthly" 候補
 *   - description は最頻値を採用
 */

import { db } from "@/lib/localDb";

export interface RecurringCandidate {
  /** グループ識別キー (partner_id + amount) */
  key: string;
  partnerId: string | null;
  partnerName: string | null;
  description: string;
  amount: number;
  /** 過去 180 日内の出現回数 */
  occurrences: number;
  /** 平均間隔 (日) — 28-35 なら月次, 6-9 なら週次 */
  avgIntervalDays: number;
  /** "monthly" | "weekly" | "irregular" */
  rhythm: "monthly" | "weekly" | "irregular";
  /** 直近の出現日 (YYYY-MM-DD) */
  lastSeen: string;
  /** account_code (借方の最頻) */
  accountCode: string | null;
  accountName: string | null;
}

interface JournalRow {
  id: string;
  date: string;
  description: string | null;
  journal_lines: {
    partner_id: string | null;
    account_code: string;
    account_name: string;
    debit_amount: number;
    credit_amount: number;
  }[] | null;
}

export async function detectRecurringCandidates(): Promise<
  RecurringCandidate[]
> {
  const cutoff = new Date(Date.now() - 180 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);

  const { data: journals } = await db
    .from("journals")
    .select("id, date, description, journal_lines(partner_id, account_code, account_name, debit_amount, credit_amount)")
    .gte("date", cutoff)
    .order("date", { ascending: false });
  const rows = (journals as JournalRow[] | null) ?? [];
  if (rows.length === 0) return [];

  // partner 名のキャッシュ
  const partnerNames = new Map<string, string>();
  try {
    const { data: ps } = await db.from("partners").select("id, name");
    for (const p of (ps as { id: string; name: string }[] | null) ?? []) {
      partnerNames.set(p.id, p.name);
    }
  } catch {
    /* 無くても動く */
  }

  // グループ化: partner_id + amount でキー
  interface Group {
    partnerId: string | null;
    amount: number;
    accountCode: string;
    accountName: string;
    descriptions: string[];
    dates: string[];
  }
  const groups = new Map<string, Group>();
  for (const j of rows) {
    const lines = j.journal_lines ?? [];
    if (lines.length === 0) continue;
    // 代表行 = 最大借方の line
    let primary = lines[0];
    for (const ln of lines) {
      if (ln.debit_amount > primary.debit_amount) primary = ln;
    }
    if (primary.debit_amount === 0) continue;
    const key = `${primary.partner_id ?? "_no_partner"}:${primary.debit_amount}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        partnerId: primary.partner_id,
        amount: primary.debit_amount,
        accountCode: primary.account_code,
        accountName: primary.account_name,
        descriptions: [],
        dates: [],
      };
      groups.set(key, g);
    }
    if (j.description) g.descriptions.push(j.description);
    g.dates.push(j.date);
  }

  // 候補化: 3 件以上 + 一定の周期性
  const out: RecurringCandidate[] = [];
  for (const [key, g] of groups) {
    if (g.dates.length < 3) continue;
    // 日付差を計算 (新しい順 → 古い順にソート)
    const sorted = [...g.dates].sort();
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const a = new Date(sorted[i - 1]).getTime();
      const b = new Date(sorted[i]).getTime();
      gaps.push((b - a) / (24 * 3600 * 1000));
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    let rhythm: RecurringCandidate["rhythm"];
    if (avgGap >= 25 && avgGap <= 35) rhythm = "monthly";
    else if (avgGap >= 5 && avgGap <= 9) rhythm = "weekly";
    else rhythm = "irregular";
    if (rhythm === "irregular") continue; // 不規則は除外

    // description は最頻値 (なければ最初の物)
    const dCount = new Map<string, number>();
    for (const d of g.descriptions) {
      dCount.set(d, (dCount.get(d) ?? 0) + 1);
    }
    let topDesc = g.descriptions[0] ?? "(摘要なし)";
    let topN = 0;
    for (const [d, n] of dCount) {
      if (n > topN) {
        topN = n;
        topDesc = d;
      }
    }

    out.push({
      key,
      partnerId: g.partnerId,
      partnerName: g.partnerId ? partnerNames.get(g.partnerId) ?? null : null,
      description: topDesc,
      amount: g.amount,
      occurrences: g.dates.length,
      avgIntervalDays: Math.round(avgGap),
      rhythm,
      lastSeen: sorted[sorted.length - 1],
      accountCode: g.accountCode,
      accountName: g.accountName,
    });
  }

  // 出現回数順
  out.sort((a, b) => b.occurrences - a.occurrences);
  return out;
}

/**
 * Round 28 ㊦: 定期取引候補をワンクリックで auto_rules に登録する.
 *
 * 銀行明細取込時に「同 partner / 近い金額」の取引へ勘定科目を自動提案させる。
 * match_text は取引先名 (なければ摘要) を contains マッチ。金額は ±3% の窓。
 * 戻り値は INSERT した行の id。
 */
export async function createAutoRuleFromCandidate(
  c: RecurringCandidate,
): Promise<string> {
  const matchText = (c.partnerName ?? c.description ?? "").trim();
  if (!matchText) throw new Error("ルール化できる取引先名/摘要がありません");
  const lo = Math.round(c.amount * 0.97);
  const hi = Math.round(c.amount * 1.03);
  const { data, error } = await db
    .from("auto_rules")
    .insert({
      bank_account_id: null,
      is_income: null,
      match_text: matchText,
      match_type: "contains",
      amount_min: lo,
      amount_max: hi,
      priority: 50,
      action_type: "suggest_journal",
      account_code: c.accountCode,
      account_name: c.accountName,
      tax_code: null,
      partner_id: c.partnerId,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/**
 * 既に同等の auto_rule が登録済みかどうかを判定する (match_text + account_code の一致)。
 * ダッシュボードで「ルール済」表示を出すために使う。
 */
export async function listRuledMatchTexts(): Promise<Set<string>> {
  const { data } = await db.from("auto_rules").select("match_text, account_code");
  const set = new Set<string>();
  for (const r of (data as { match_text: string; account_code: string | null }[] | null) ?? []) {
    set.add(`${(r.match_text ?? "").trim().toLowerCase()}:${r.account_code ?? ""}`);
  }
  return set;
}
