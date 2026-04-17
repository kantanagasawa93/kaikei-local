"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Calculator, Home } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { DEFAULT_ACCOUNTS, getAccountByCode } from "@/lib/accounts";
import type { BizAllocation, JournalLine } from "@/types";

type Row = BizAllocation & {
  total_amount: number;
  business_amount: number;
  private_amount: number;
};

export default function AllocationsPage() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ account_code: "", business_ratio: 50 });
  const [loading, setLoading] = useState(false);
  const [recalculating, setRecalculating] = useState(false);

  useEffect(() => {
    load();
  }, [year]);

  async function load() {
    setLoading(true);
    const { data: allocs } = await supabase
      .from("biz_allocations")
      .select("*")
      .eq("fiscal_year", year)
      .order("account_code");

    if (!allocs) {
      setRows([]);
      setLoading(false);
      return;
    }

    // 各勘定科目の年間合計を取得
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;
    const { data: journals } = await supabase
      .from("journals")
      .select("id")
      .gte("date", start)
      .lte("date", end);
    const journalIds: string[] = journals?.map((j: { id: string }) => j.id) || [];

    const totals: Record<string, number> = {};
    if (journalIds.length > 0) {
      const { data: lines } = await supabase
        .from("journal_lines")
        .select("account_code, debit_amount, credit_amount")
        .in("journal_id", journalIds);

      if (lines) {
        for (const l of lines as Pick<JournalLine, "account_code" | "debit_amount" | "credit_amount">[]) {
          totals[l.account_code] =
            (totals[l.account_code] || 0) + (l.debit_amount - l.credit_amount);
        }
      }
    }

    setRows(
      allocs.map((a) => {
        const total = totals[a.account_code] || 0;
        const bizAmount = Math.floor((total * a.business_ratio) / 100);
        return {
          ...a,
          total_amount: total,
          business_amount: bizAmount,
          private_amount: total - bizAmount,
        };
      })
    );
    setLoading(false);
  }

  async function handleAdd() {
    if (!form.account_code) return;
    const account = getAccountByCode(form.account_code);
    if (!account) return;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from("biz_allocations").insert({
      user_id: user.id,
      account_code: form.account_code,
      account_name: account.name,
      business_ratio: form.business_ratio,
      fiscal_year: year,
    });
    setForm({ account_code: "", business_ratio: 50 });
    setOpen(false);
    load();
  }

  async function handleDelete(id: string) {
    await supabase.from("biz_allocations").delete().eq("id", id);
    load();
  }

  async function handleRecalculate() {
    if (!confirm("選択年度の按分仕訳を再生成しますか？")) return;
    setRecalculating(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setRecalculating(false);
      return;
    }

    // 既存の生成済み按分仕訳を削除
    const oldJournals = rows
      .map((r) => r.generated_journal_id)
      .filter((id): id is string => !!id);
    if (oldJournals.length > 0) {
      await supabase.from("journals").delete().in("id", oldJournals);
    }

    // 新しく按分仕訳を作る（12/31付で事業主貸に振替）
    const endDate = `${year}-12-31`;
    for (const row of rows) {
      if (row.private_amount <= 0) continue;
      const { data: journal } = await supabase
        .from("journals")
        .insert({
          user_id: user.id,
          date: endDate,
          description: `家事按分: ${row.account_name} (事業利用${row.business_ratio}%)`,
          is_adjustment: true,
        })
        .select()
        .single();

      if (journal) {
        await supabase.from("journal_lines").insert([
          {
            journal_id: journal.id,
            account_code: "190",
            account_name: "事業主貸",
            debit_amount: row.private_amount,
            credit_amount: 0,
            tax_code: "OUT",
            tax_amount: 0,
          },
          {
            journal_id: journal.id,
            account_code: row.account_code,
            account_name: row.account_name,
            debit_amount: 0,
            credit_amount: row.private_amount,
            tax_code: "OUT",
            tax_amount: 0,
          },
        ]);

        await supabase
          .from("biz_allocations")
          .update({
            last_calculated_at: new Date().toISOString(),
            generated_journal_id: journal.id,
          })
          .eq("id", row.id);
      }
    }
    setRecalculating(false);
    load();
  }

  const expenseAccounts = DEFAULT_ACCOUNTS.filter((a) => a.category === "expense");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">家事按分</h1>
        <div className="flex gap-2">
          <Select value={String(year)} onValueChange={(v) => v && setYear(parseInt(v, 10))}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 2 + i).map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}年
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            按分を追加
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base text-muted-foreground">
            通信費や水道光熱費など「プライベート」と「事業」で共用している経費を按分します。
            取引を追加/編集した場合は <b>再計算</b> を実行してください。
          </CardTitle>
        </CardHeader>
      </Card>

      {loading ? (
        <p className="text-muted-foreground text-sm">読込中...</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Home className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">按分設定がありません。</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>勘定科目</TableHead>
                    <TableHead className="text-right">合計金額</TableHead>
                    <TableHead className="text-right">事業利用比率</TableHead>
                    <TableHead className="text-right">事業利用分</TableHead>
                    <TableHead className="text-right">按分（差額）</TableHead>
                    <TableHead className="w-16"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.account_name}</TableCell>
                      <TableCell className="text-right">
                        {r.total_amount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">{r.business_ratio}%</TableCell>
                      <TableCell className="text-right">
                        {r.business_amount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {r.private_amount.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDelete(r.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <div className="flex justify-center">
            <Button onClick={handleRecalculate} disabled={recalculating}>
              <Calculator className="h-4 w-4 mr-1" />
              {recalculating ? "再計算中..." : "再計算（按分仕訳を生成）"}
            </Button>
          </div>
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>按分ルールを追加</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>勘定科目</Label>
              <Select
                value={form.account_code}
                onValueChange={(v) => v && setForm({ ...form, account_code: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="科目を選択">
                    {getAccountByCode(form.account_code)?.name ?? "科目を選択"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {expenseAccounts.map((a) => (
                    <SelectItem key={a.code} value={a.code}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>事業利用比率（%）</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={form.business_ratio}
                onChange={(e) =>
                  setForm({
                    ...form,
                    business_ratio: Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)),
                  })
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              キャンセル
            </Button>
            <Button onClick={handleAdd} disabled={!form.account_code}>
              追加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
