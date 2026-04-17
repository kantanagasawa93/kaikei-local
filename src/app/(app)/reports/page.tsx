"use client";

import { useEffect, useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import {
  buildMonthlyMatrix,
  subtotalByCategory,
  CATEGORY_LABEL,
  type MonthlyRow,
  type ReportLine,
} from "@/lib/reports";
import type { Account } from "@/types";

const MONTHS = ["期首", "1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

export default function ReportsPage() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(false);
  const [lines, setLines] = useState<ReportLine[]>([]);
  const [mode, setMode] = useState<"pl" | "bs">("pl");

  useEffect(() => {
    loadLines();
  }, [year]);

  async function loadLines() {
    setLoading(true);
    const end = `${year}-12-31`;
    const { data: journals } = await supabase
      .from("journals")
      .select("id, date")
      .lte("date", end);

    if (!journals || journals.length === 0) {
      setLines([]);
      setLoading(false);
      return;
    }
    type JRow = { id: string; date: string };
    type LRow = {
      journal_id: string;
      account_code: string;
      account_name: string;
      debit_amount: number;
      credit_amount: number;
    };
    const journalIds: string[] = (journals as JRow[]).map((j) => j.id);
    const dateMap = new Map((journals as JRow[]).map((j) => [j.id, j.date]));

    const { data: journalLines } = await supabase
      .from("journal_lines")
      .select("journal_id, account_code, account_name, debit_amount, credit_amount")
      .in("journal_id", journalIds);

    if (journalLines) {
      setLines(
        (journalLines as LRow[]).map((l) => ({
          account_code: l.account_code,
          account_name: l.account_name,
          debit_amount: l.debit_amount,
          credit_amount: l.credit_amount,
          date: dateMap.get(l.journal_id) || "",
        }))
      );
    }
    setLoading(false);
  }

  const rows = useMemo(() => buildMonthlyMatrix(lines, year, mode), [lines, year, mode]);
  const subtotals = useMemo(() => subtotalByCategory(rows), [rows]);

  const categoriesForMode: Account["category"][] =
    mode === "pl" ? ["revenue", "expense"] : ["asset", "liability", "equity"];

  const formatAmount = (v: number) =>
    v === 0 ? "-" : new Intl.NumberFormat("ja-JP").format(v);

  const yearOptions = Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - 2 + i);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">月次推移レポート</h1>
        <div className="flex gap-2 items-center">
          <Select value={String(year)} onValueChange={(v) => v && setYear(parseInt(v, 10))}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {yearOptions.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}年
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={loadLines} disabled={loading}>
            {loading ? "読込中..." : "再読込"}
          </Button>
        </div>
      </div>

      <Tabs value={mode} onValueChange={(v) => v && setMode(v as "pl" | "bs")}>
        <TabsList>
          <TabsTrigger value="pl">損益計算書</TabsTrigger>
          <TabsTrigger value="bs">貸借対照表</TabsTrigger>
        </TabsList>

        <TabsContent value={mode}>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                {mode === "pl" ? "損益計算書（月次推移）" : "貸借対照表（月次推移）"}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-2 sticky left-0 bg-muted/50 z-10 min-w-48">勘定科目</th>
                    {MONTHS.map((m, i) => {
                      if (mode === "pl" && i === 0) return null;
                      return (
                        <th key={m} className="text-right p-2 whitespace-nowrap min-w-24">
                          {m}
                        </th>
                      );
                    })}
                    <th className="text-right p-2 font-bold">合計</th>
                  </tr>
                </thead>
                <tbody>
                  {categoriesForMode.map((cat) => (
                    <CategorySection
                      key={cat}
                      category={cat}
                      rows={rows.filter((r) => r.category === cat)}
                      subtotal={subtotals[cat]}
                      mode={mode}
                      formatAmount={formatAmount}
                    />
                  ))}
                  {mode === "pl" && (
                    <tr className="font-bold border-t-2">
                      <td className="p-2 sticky left-0 bg-background">営業利益</td>
                      {MONTHS.slice(1).map((_, i) => {
                        const m = i + 1;
                        const profit = subtotals.revenue[m] - subtotals.expense[m];
                        return (
                          <td key={m} className="text-right p-2">
                            {formatAmount(profit)}
                          </td>
                        );
                      })}
                      <td className="text-right p-2">
                        {formatAmount(
                          subtotals.revenue.reduce((a, b) => a + b, 0) -
                            subtotals.expense.reduce((a, b) => a + b, 0)
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CategorySection({
  category,
  rows,
  subtotal,
  mode,
  formatAmount,
}: {
  category: Account["category"];
  rows: MonthlyRow[];
  subtotal: number[];
  mode: "pl" | "bs";
  formatAmount: (v: number) => string;
}) {
  return (
    <>
      <tr className="bg-muted/30">
        <td className="p-2 font-semibold sticky left-0 bg-muted/30">
          ▼ {CATEGORY_LABEL[category]}
        </td>
        {MONTHS.map((m, i) => {
          if (mode === "pl" && i === 0) return null;
          return (
            <td key={m} className="text-right p-2 font-semibold">
              {formatAmount(subtotal[i])}
            </td>
          );
        })}
        <td className="text-right p-2 font-semibold">
          {formatAmount(
            mode === "pl"
              ? subtotal.slice(1).reduce((a, b) => a + b, 0)
              : subtotal[12]
          )}
        </td>
      </tr>
      {rows.map((row) => (
        <tr key={row.code} className="border-b hover:bg-muted/10">
          <td className="p-2 pl-6 sticky left-0 bg-background">{row.name}</td>
          {MONTHS.map((m, i) => {
            if (mode === "pl" && i === 0) return null;
            return (
              <td key={m} className="text-right p-2 text-muted-foreground">
                {formatAmount(row.months[i])}
              </td>
            );
          })}
          <td className="text-right p-2">{formatAmount(row.total)}</td>
        </tr>
      ))}
    </>
  );
}
