"use client";

import { useEffect, useRef, useState } from "react";
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
import { DEFAULT_ACCOUNTS, getAccountByCode } from "@/lib/accounts";
import {
  NON_ALLOCATABLE_ACCOUNT_CODES,
  addAllocation,
  deleteAllocation,
  loadAllocationRows,
  recalculateAllocations,
  type AllocationRow,
} from "@/lib/allocations";
import { confirmDialog } from "@/lib/confirm";
import { toast } from "@/lib/toast";

type Row = AllocationRow;

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  return (e as Error)?.message || String(e);
}

export default function AllocationsPage() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ account_code: "", business_ratio: 50 });
  const [loading, setLoading] = useState(false);
  const [recalculating, setRecalculating] = useState(false);

  // 年度を素早く切り替えた時に、古い年度の結果で上書きしないための通し番号
  const loadSeq = useRef(0);
  const busyRef = useRef(false);

  async function load() {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const next = await loadAllocationRows(year);
      if (seq === loadSeq.current) setRows(next);
    } catch (e) {
      if (seq === loadSeq.current) {
        setRows([]);
        toast.error(`按分設定を読み込めませんでした: ${errText(e)}`);
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [year]);

  async function handleAdd() {
    if (!form.account_code || busyRef.current) return;
    busyRef.current = true;
    try {
      await addAllocation({
        account_code: form.account_code,
        business_ratio: form.business_ratio,
        fiscal_year: year,
      });
      setForm({ account_code: "", business_ratio: 50 });
      setOpen(false);
      toast.info("按分を追加しました。「再計算」を押すと帳簿に反映されます");
      await load();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      busyRef.current = false;
    }
  }

  async function handleDelete(row: Row) {
    const posted = !!row.generated_journal_id;
    if (
      !(await confirmDialog(
        posted
          ? `${row.account_name}の按分を削除します。生成済みの按分仕訳（12/31 付）も取り消されます。よろしいですか？`
          : `${row.account_name}の按分を削除します。よろしいですか？`,
        "削除",
      ))
    ) {
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await deleteAllocation(row.id);
    } catch (e) {
      toast.error(`削除に失敗しました: ${errText(e)}`);
    } finally {
      busyRef.current = false;
      await load();
    }
  }

  async function handleRecalculate() {
    if (!(await confirmDialog(`${year}年の按分仕訳を作り直しますか？`))) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setRecalculating(true);
    try {
      const res = await recalculateAllocations(year);
      const parts = [`按分仕訳を ${res.generated} 件作成しました`];
      if (res.cleared > 0) parts.push(`家事分なし ${res.cleared} 件`);
      if (res.skipped.length > 0) {
        parts.push(`${res.skipped.join("・")}は固定資産台帳で按分済みのため対象外`);
      }
      toast.success(parts.join(" / "));
    } catch (e) {
      toast.error(`再計算に失敗しました: ${errText(e)}`);
    } finally {
      busyRef.current = false;
      setRecalculating(false);
      await load();
    }
  }

  // 減価償却費は固定資産台帳側 (事業専用割合) で按分するので選ばせない
  const expenseAccounts = DEFAULT_ACCOUNTS.filter(
    (a) => a.category === "expense" && !NON_ALLOCATABLE_ACCOUNT_CODES.has(a.code),
  );
  const registered = new Set(rows.map((r) => r.account_code));
  const outOfSync = rows.some((r) => !r.in_sync);

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
            <span className="block text-xs mt-1">
              減価償却費は固定資産台帳の「事業専用割合」で按分されるため、ここでは登録しません。
            </span>
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
                    <TableHead className="text-right">家事分（事業主貸へ）</TableHead>
                    <TableHead>帳簿への反映</TableHead>
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
                      <TableCell className="text-xs">
                        {NON_ALLOCATABLE_ACCOUNT_CODES.has(r.account_code) ? (
                          <span className="text-amber-600">
                            対象外（固定資産台帳で按分済み。この行は削除してください）
                          </span>
                        ) : r.in_sync ? (
                          <span className="text-emerald-600">
                            {r.posted_private_amount > 0 ? "反映済み" : "家事分なし"}
                          </span>
                        ) : (
                          <span className="text-amber-600">
                            未反映（帳簿上 {r.posted_private_amount.toLocaleString()}円）
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDelete(r)}
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

          <div className="flex flex-col items-center gap-2">
            {outOfSync && (
              <p className="text-sm text-amber-600">
                帳簿に反映されていない按分があります。再計算を実行してください。
              </p>
            )}
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
                    <SelectItem key={a.code} value={a.code} disabled={registered.has(a.code)}>
                      {a.name}
                      {registered.has(a.code) ? "（登録済み）" : ""}
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
