"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { Receipt, BookOpen, TrendingUp, TrendingDown, Download, AlertTriangle, FileSpreadsheet } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { Journal, JournalLine } from "@/types";
import { ReceiptDropZone } from "@/components/receipt-drop-zone";
import { FadeIn, StaggerContainer, StaggerItem, CountUp } from "@/components/motion";
import {
  buildMonthlySummaryCsv,
  downloadCsv,
} from "@/lib/journal-export";
import { checkReadiness, type ReadinessReport } from "@/lib/etax/readiness";
import { toast } from "@/lib/toast";
import { CheckCircle2, AlertCircle } from "lucide-react";

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
  // Round 24 ⓔ: 月次グラフ用の年度切替
  const [chartYear, setChartYear] = useState(new Date().getFullYear());
  const [availableYears, setAvailableYears] = useState<number[]>([]);
  // Round 24 ㊟: 要確認の仕訳件数 (今年度)
  const [incompleteCount, setIncompleteCount] = useState(0);
  // Round 25 ㊠: 確定申告期の準備状況
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);

  useEffect(() => {
    loadStats();
    loadRecentJournals();
    loadIncompleteCount();
    loadAvailableYears();
    // Round 25 ㊠: 確定申告期の準備状況 (1/1〜3/15 のみ自動表示)
    void checkReadiness().then((r) => {
      if (r.inWindow) setReadiness(r);
    });
  }, []);

  // chartYear が変わったら月次グラフ再ロード
  useEffect(() => {
    loadMonthly(chartYear);
  }, [chartYear]);

  async function loadAvailableYears() {
    const { data } = await supabase
      .from("journals")
      .select("date")
      .order("date", { ascending: false });
    const years = new Set<number>();
    for (const j of (data as { date: string }[] | null) ?? []) {
      const y = parseInt(j.date.slice(0, 4), 10);
      if (Number.isFinite(y)) years.add(y);
    }
    // 今年も常に選択肢に入れる
    years.add(new Date().getFullYear());
    setAvailableYears(Array.from(years).sort((a, b) => b - a));
  }

  async function loadIncompleteCount() {
    const year = new Date().getFullYear();
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;
    const { data: journalRows } = await supabase
      .from("journals")
      .select("id, description, journal_lines(debit_amount, credit_amount)")
      .gte("date", start)
      .lte("date", end);
    let count = 0;
    for (const j of (journalRows as Array<{
      id: string;
      description: string | null;
      journal_lines: { debit_amount: number; credit_amount: number }[] | null;
    }> | null) ?? []) {
      const lines = j.journal_lines ?? [];
      if (lines.length === 0) {
        count++;
        continue;
      }
      const total = lines.reduce(
        (acc, ln) => acc + (ln.debit_amount || 0) + (ln.credit_amount || 0),
        0,
      );
      if (total === 0) {
        count++;
        continue;
      }
      if (
        j.description &&
        (j.description.startsWith("不明 - ") || j.description === "不明")
      ) {
        count++;
      }
    }
    setIncompleteCount(count);
  }

  async function loadMonthly(year: number = new Date().getFullYear()) {
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

      {/* Round 25 ㊠: 確定申告期 (1/1〜3/15) の準備状況カード */}
      {readiness && (
        <Card className="border-blue-300 bg-blue-50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4" />
              確定申告 ({readiness.year} 年分) の準備状況
              <span className="ml-auto text-sm font-normal text-blue-900">
                {readiness.completionPct}% 完了
                {readiness.blockers > 0 && (
                  <span className="ml-2 text-red-700">
                    ({readiness.blockers} 件 要対応)
                  </span>
                )}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {readiness.checks.map((c) => {
              const icon =
                c.status === "ok" ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
                ) : c.status === "warning" ? (
                  <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0" />
                );
              const inner = (
                <div className="flex items-start gap-2 text-sm py-1">
                  {icon}
                  <div className="flex-1">
                    <p className="font-medium">{c.label}</p>
                    <p className="text-xs text-muted-foreground">{c.detail}</p>
                  </div>
                  {c.href && <span className="text-blue-700 text-xs">→</span>}
                </div>
              );
              return c.href ? (
                <Link
                  key={c.id}
                  href={c.href}
                  className="block hover:bg-blue-100/60 rounded px-1 -mx-1"
                >
                  {inner}
                </Link>
              ) : (
                <div key={c.id} className="px-1 -mx-1">
                  {inner}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Round 24 ㊟: 要確認の仕訳ウィジェット (1 件以上ある時だけ表示) */}
      {incompleteCount > 0 && (
        <Link href="/journals?incomplete=1" className="block">
          <Card className="border-amber-300 bg-amber-50 hover:bg-amber-100 transition-colors cursor-pointer">
            <CardContent className="flex items-center gap-3 py-4">
              <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-amber-900">
                  要確認の仕訳が <b>{incompleteCount} 件</b> あります
                </p>
                <p className="text-xs text-amber-800 mt-0.5">
                  金額が 0 / 摘要が「不明」など、確定申告前に確認すべき仕訳。
                  クリックで一覧へ。
                </p>
              </div>
              <span className="text-amber-700 text-sm">→</span>
            </CardContent>
          </Card>
        </Link>
      )}

      {/* Round 21 ⓓ: 月次グラフ (年度の売上 / 経費)
          Round 22 ⓐ: CSV エクスポートボタン + ⓓ 棒クリックで該当月の仕訳一覧へ
          Round 24 ⓔ: 年度切替セレクタ */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2 gap-2">
          <CardTitle className="text-lg flex items-center gap-2">
            月次集計
            {availableYears.length > 1 ? (
              <select
                value={chartYear}
                onChange={(e) => setChartYear(parseInt(e.target.value, 10))}
                className="border rounded px-2 py-0.5 text-sm font-normal"
              >
                {availableYears.map((y) => (
                  <option key={y} value={y}>
                    FY {y}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-sm font-normal text-muted-foreground">
                ({chartYear} 年度)
              </span>
            )}
          </CardTitle>
          {monthly.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const csv = buildMonthlySummaryCsv(
                  chartYear,
                  monthly.map((b) => ({
                    month: b.month,
                    income: b.income,
                    expense: b.expense,
                    diff: b.income - b.expense,
                  })),
                );
                downloadCsv(
                  csv,
                  `kaikei_monthly_summary_FY${chartYear}_${new Date().toISOString().slice(0, 10)}.csv`,
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
              // Round 22 ⓓ ドリルダウン → Round 25 ⓒ で from/to レンジ化
              const m = parseInt(month, 10);
              const start = `${chartYear}-${month}-01`;
              const lastDay = new Date(chartYear, m, 0).getDate();
              const end = `${chartYear}-${month}-${String(lastDay).padStart(2, "0")}`;
              router.push(`/journals?from=${start}&to=${end}`);
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

  // Round 26 ⓒ: 年間平均 + 中央値 (0 月を含むかどうかは "実績がある月のみ"
  // で判断 — 12 月分すべてを平均すると 0 月が混ざって低めに出るため、
  // 売上/経費どちらかが 0 でない月だけを母集団にする)
  const incomeMonths = data.filter((b) => b.income !== 0);
  const expenseMonths = data.filter((b) => b.expense !== 0);
  const avg = (xs: number[]) =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  const median = (xs: number[]) => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
  };
  const incomeAvg = avg(incomeMonths.map((b) => b.income));
  const incomeMedian = median(incomeMonths.map((b) => b.income));
  const expenseAvg = avg(expenseMonths.map((b) => b.expense));
  const expenseMedian = median(expenseMonths.map((b) => b.expense));

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-12 gap-1 items-end h-40">
        {data.map((b) => {
          const incPct = (Math.abs(b.income) / maxVal) * 100;
          const expPct = (Math.abs(b.expense) / maxVal) * 100;
          // Round 26 ⓒ: 年間統計を tooltip に併記して比較しやすく
          const incomeDelta = b.income - incomeAvg;
          const expenseDelta = b.expense - expenseAvg;
          const sign = (n: number) => (n > 0 ? "+" : "");
          const tooltip =
            `${b.month}月: 売上 ¥${fmt(b.income)} / 経費 ¥${fmt(b.expense)}\n` +
            `年間平均比: 売上 ${sign(incomeDelta)}¥${fmt(incomeDelta)} / ` +
            `経費 ${sign(expenseDelta)}¥${fmt(expenseDelta)}` +
            (onMonthClick ? "\n(クリックで仕訳一覧へ)" : "");
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
      <div className="flex gap-4 text-xs text-muted-foreground pt-2 flex-wrap">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 bg-green-500 rounded-sm" />
          売上
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 bg-red-400 rounded-sm" />
          経費
        </span>
        {/* Round 26 ⓒ: 年間平均と中央値 (実績がある月のみが母集団) */}
        {incomeMonths.length > 0 && (
          <span className="ml-4">
            売上 平均/中央値: <b>¥{fmt(incomeAvg)}</b> / ¥{fmt(incomeMedian)}
          </span>
        )}
        {expenseMonths.length > 0 && (
          <span>
            経費 平均/中央値: <b>¥{fmt(expenseAvg)}</b> / ¥{fmt(expenseMedian)}
          </span>
        )}
      </div>
    </div>
  );
}
