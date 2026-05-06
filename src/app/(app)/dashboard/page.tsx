"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { Receipt, BookOpen, TrendingUp, TrendingDown, Download } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { Journal, JournalLine } from "@/types";
import { ReceiptDropZone } from "@/components/receipt-drop-zone";
import { FadeIn, StaggerContainer, StaggerItem, CountUp } from "@/components/motion";
import {
  buildMonthlySummaryCsv,
  downloadCsv,
} from "@/lib/journal-export";
import { toast } from "@/lib/toast";

interface Stats {
  receiptCount: number;
  journalCount: number;
  totalIncome: number;
  totalExpense: number;
}

/** Round 21 ⓓ: 月次集計 (1月〜12月) */
interface MonthlyBucket {
  month: string; // "01" 〜 "12"
  income: number;
  expense: number;
}

export default function DashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats>({
    receiptCount: 0,
    journalCount: 0,
    totalIncome: 0,
    totalExpense: 0,
  });
  const [recentJournals, setRecentJournals] = useState<Journal[]>([]);
  // Round 21 ⓓ: 月次グラフ用バケット
  const [monthly, setMonthly] = useState<MonthlyBucket[]>([]);

  useEffect(() => {
    loadStats();
    loadRecentJournals();
    loadMonthly();
  }, []);

  async function loadMonthly() {
    const year = new Date().getFullYear();
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;
    const { data: journalRows } = await supabase
      .from("journals")
      .select("id, date")
      .gte("date", start)
      .lte("date", end);
    const dateMap = new Map<string, string>(); // journal_id -> "MM"
    for (const j of (journalRows as { id: string; date: string }[] | null) ?? []) {
      const m = j.date.slice(5, 7); // "MM"
      if (m) dateMap.set(j.id, m);
    }
    if (dateMap.size === 0) {
      setMonthly([]);
      return;
    }
    const ids = Array.from(dateMap.keys());
    const { data: lines } = await supabase
      .from("journal_lines")
      .select("journal_id, account_code, debit_amount, credit_amount")
      .in("journal_id", ids);
    const buckets: Record<string, MonthlyBucket> = {};
    for (let i = 1; i <= 12; i++) {
      const m = String(i).padStart(2, "0");
      buckets[m] = { month: m, income: 0, expense: 0 };
    }
    for (const ln of (lines as Array<{
      journal_id: string;
      account_code: string;
      debit_amount: number;
      credit_amount: number;
    }> | null) ?? []) {
      const m = dateMap.get(ln.journal_id);
      if (!m) continue;
      if (ln.account_code.startsWith("4")) {
        buckets[m].income += ln.credit_amount - ln.debit_amount;
      } else if (ln.account_code.startsWith("5") || ln.account_code.startsWith("6")) {
        buckets[m].expense += ln.debit_amount - ln.credit_amount;
      }
    }
    setMonthly(Object.values(buckets));
  }

  async function loadStats() {
    const year = new Date().getFullYear();
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const [receiptsRes, journalsRes] = await Promise.all([
      supabase.from("receipts").select("id", { count: "exact", head: true }),
      supabase.from("journals").select("id", { count: "exact", head: true })
        .gte("date", startDate).lte("date", endDate),
    ]);

    // 仕訳明細は journal_ids が必要なので別で取得
    const { data: journalRows } = await supabase
      .from("journals").select("id").gte("date", startDate).lte("date", endDate);
    const journalIds: string[] = journalRows?.map((j: { id: string }) => j.id) || [];

    let totalIncome = 0;
    let totalExpense = 0;

    if (journalIds.length > 0) {
      const { data: lines } = await supabase
        .from("journal_lines")
        .select("account_code, debit_amount, credit_amount")
        .in("journal_id", journalIds);

      if (lines) {
        for (const line of lines as JournalLine[]) {
          if (line.account_code.startsWith("4")) {
            totalIncome += line.credit_amount - line.debit_amount;
          } else if (line.account_code.startsWith("5") || line.account_code.startsWith("6")) {
            totalExpense += line.debit_amount - line.credit_amount;
          }
        }
      }
    }

    setStats({
      receiptCount: receiptsRes.count || 0,
      journalCount: journalsRes.count || 0,
      totalIncome,
      totalExpense,
    });
  }

  async function loadRecentJournals() {
    const { data } = await supabase
      .from("journals")
      .select("*")
      .order("date", { ascending: false })
      .limit(5);
    if (data) setRecentJournals(data);
  }

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(amount);

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">ダッシュボード</h1>
        </div>

        {/* クイックアクション */}
        <div className="flex flex-wrap gap-2 mt-4">
          <Link href="/receipts/new">
            <Button size="sm" className="gap-1.5">
              <Receipt className="h-3.5 w-3.5" />
              領収書を登録
            </Button>
          </Link>
          <Link href="/journals/new">
            <Button size="sm" variant="outline" className="gap-1.5">
              <BookOpen className="h-3.5 w-3.5" />
              仕訳を登録
            </Button>
          </Link>
          <Link href="/invoices/edit">
            <Button size="sm" variant="outline" className="gap-1.5">
              請求書を作成
            </Button>
          </Link>
          <Link href="/transactions">
            <Button size="sm" variant="outline" className="gap-1.5">
              CSV取込
            </Button>
          </Link>
        </div>
      </FadeIn>

      <ReceiptDropZone onImported={() => { loadStats(); loadRecentJournals(); }} />

      {/* 消費税課税判定 (売上 1000万円超えで翌々年から課税事業者) */}
      {stats.totalIncome >= 10_000_000 && (
        <div className="rounded-md border border-orange-300 bg-orange-50 px-4 py-3 text-sm text-orange-900">
          <p className="font-medium mb-1">
            ⚠️ 消費税の課税事業者になる可能性があります
          </p>
          <p className="text-xs leading-relaxed">
            今年度の売上が <b>¥{stats.totalIncome.toLocaleString()}</b> で、
            1,000 万円を超えています。基準期間の課税売上高が 1,000 万円超となる場合、
            翌々年から消費税の納税義務が発生します
            (インボイス登録済みなら翌年以降も課税事業者扱い)。
            詳細は税務署・税理士にご相談ください。
          </p>
        </div>
      )}

      <StaggerContainer className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StaggerItem>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">領収書</CardTitle>
              <Receipt className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                <CountUp target={stats.receiptCount} suffix="件" />
              </div>
            </CardContent>
          </Card>
        </StaggerItem>

        <StaggerItem>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">仕訳数</CardTitle>
              <BookOpen className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                <CountUp target={stats.journalCount} suffix="件" />
              </div>
              <p className="text-xs text-muted-foreground">今年度</p>
            </CardContent>
          </Card>
        </StaggerItem>

        <StaggerItem>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">売上</CardTitle>
              <TrendingUp className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">
                <CountUp target={stats.totalIncome} prefix="¥" />
              </div>
              <p className="text-xs text-muted-foreground">今年度</p>
            </CardContent>
          </Card>
        </StaggerItem>

        <StaggerItem>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">経費</CardTitle>
              <TrendingDown className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">
                <CountUp target={stats.totalExpense} prefix="¥" />
              </div>
              <p className="text-xs text-muted-foreground">今年度</p>
            </CardContent>
          </Card>
        </StaggerItem>
      </StaggerContainer>

      {/* Round 21 ⓓ: 月次グラフ (今年度の売上 / 経費)
          Round 22 ⓐ: CSV エクスポートボタン + ⓓ 棒クリックで該当月の仕訳一覧へ */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-lg">
            月次集計 ({new Date().getFullYear()} 年度)
          </CardTitle>
          {monthly.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const year = new Date().getFullYear();
                const csv = buildMonthlySummaryCsv(
                  year,
                  monthly.map((b) => ({
                    month: b.month,
                    income: b.income,
                    expense: b.expense,
                    diff: b.income - b.expense,
                  })),
                );
                downloadCsv(
                  csv,
                  `kaikei_monthly_summary_FY${year}_${new Date().toISOString().slice(0, 10)}.csv`,
                );
                toast.success("月次集計を CSV でダウンロードしました");
              }}
              title="月次集計を CSV でダウンロード"
            >
              <Download className="h-4 w-4 mr-1" />
              CSV
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <MonthlyBarChart
            data={monthly}
            onMonthClick={(month) => {
              // ⓓ ドリルダウン: /journals?month=YYYY-MM
              const year = new Date().getFullYear();
              router.push(`/journals?month=${year}-${month}`);
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">最近の仕訳</CardTitle>
        </CardHeader>
        <CardContent>
          {recentJournals.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4 text-center">
              仕訳がまだありません。
              <Link href="/journals/new" className="underline text-primary ml-1">
                最初の仕訳を登録
              </Link>
            </p>
          ) : (
            <div className="space-y-2">
              {recentJournals.map((journal) => (
                <div
                  key={journal.id}
                  className="flex items-center justify-between py-2 border-b last:border-0"
                >
                  <div>
                    <p className="text-sm font-medium">{journal.description}</p>
                    <p className="text-xs text-muted-foreground">{journal.date}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Round 21 ⓓ: 月次集計の簡易棒グラフ.
 * Recharts 等の依存を増やしたくないので、純粋な div + Tailwind で描画する。
 * - 各月: 売上 (緑) と 経費 (赤) を 2 本並べる
 * - 値は max を 100% にして相対表示
 * - hover で正確な金額をツールチップ表示
 *
 * Round 22 ⓓ: onMonthClick が渡されると、棒クリック時にその月の仕訳一覧へ遷移できる。
 *             各月の柱を <button> 化し、Tab + Enter でも navigate 可能。
 */
function MonthlyBarChart({
  data,
  onMonthClick,
}: {
  data: MonthlyBucket[];
  onMonthClick?: (month: string) => void;
}) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        今年度の仕訳データがまだありません
      </p>
    );
  }
  const maxVal = Math.max(
    1,
    ...data.flatMap((b) => [Math.abs(b.income), Math.abs(b.expense)]),
  );
  const fmt = (n: number) => new Intl.NumberFormat("ja-JP").format(Math.round(n));

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-12 gap-1 items-end h-40">
        {data.map((b) => {
          const incPct = (Math.abs(b.income) / maxVal) * 100;
          const expPct = (Math.abs(b.expense) / maxVal) * 100;
          const tooltip = `${b.month}月: 売上 ¥${fmt(b.income)} / 経費 ¥${fmt(b.expense)}${
            onMonthClick ? "\n(クリックで仕訳一覧へ)" : ""
          }`;
          const inner = (
            <div className="flex flex-col-reverse h-full">
              <div
                className="bg-green-500 rounded-t-sm"
                style={{ height: `${incPct}%`, minHeight: incPct > 0 ? "2px" : 0 }}
              />
              <div
                className="bg-red-400 rounded-t-sm mt-0.5"
                style={{ height: `${expPct}%`, minHeight: expPct > 0 ? "2px" : 0 }}
              />
            </div>
          );
          if (onMonthClick) {
            return (
              <button
                key={b.month}
                type="button"
                onClick={() => onMonthClick(b.month)}
                className="flex flex-col items-stretch h-full justify-end gap-0.5
                           rounded-sm hover:bg-muted/40 focus-visible:outline-none
                           focus-visible:ring-2 focus-visible:ring-primary
                           transition-colors"
                title={tooltip}
                aria-label={`${b.month}月の仕訳一覧を開く`}
              >
                {inner}
              </button>
            );
          }
          return (
            <div
              key={b.month}
              className="flex flex-col items-stretch h-full justify-end gap-0.5"
              title={tooltip}
            >
              {inner}
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-12 gap-1 text-[10px] text-center text-muted-foreground">
        {data.map((b) => (
          <div key={b.month}>{Number(b.month)}月</div>
        ))}
      </div>
      <div className="flex gap-4 text-xs text-muted-foreground pt-2">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 bg-green-500 rounded-sm" />
          売上
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 bg-red-400 rounded-sm" />
          経費
        </span>
      </div>
    </div>
  );
}
