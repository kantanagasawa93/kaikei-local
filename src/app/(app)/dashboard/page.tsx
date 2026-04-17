"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { Receipt, BookOpen, TrendingUp, TrendingDown } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { Journal, JournalLine } from "@/types";
import { ReceiptDropZone } from "@/components/receipt-drop-zone";
import { FadeIn, StaggerContainer, StaggerItem, CountUp } from "@/components/motion";

interface Stats {
  receiptCount: number;
  journalCount: number;
  totalIncome: number;
  totalExpense: number;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats>({
    receiptCount: 0,
    journalCount: 0,
    totalIncome: 0,
    totalExpense: 0,
  });
  const [recentJournals, setRecentJournals] = useState<Journal[]>([]);

  useEffect(() => {
    loadStats();
    loadRecentJournals();
  }, []);

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
