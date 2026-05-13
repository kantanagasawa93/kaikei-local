"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { db } from "@/lib/localDb";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Search, FileText, Settings, Sparkles, Trash2, RotateCcw, CheckSquare, Square } from "lucide-react";
import type { Invoice } from "@/types";
import { toast } from "@/lib/toast";
import {
  bulkDeleteInvoices,
  undoBulkDeleteInvoices,
  getInvoiceBulkUndoCount,
} from "@/lib/invoice-bulk";

const statusLabels: Record<Invoice["status"], { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  draft: { label: "下書き", variant: "outline" },
  sent: { label: "送付済", variant: "secondary" },
  paid: { label: "入金済", variant: "default" },
  cancelled: { label: "キャンセル", variant: "destructive" },
};

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [undoCount, setUndoCount] = useState(0);

  useEffect(() => {
    load();
    void getInvoiceBulkUndoCount().then(setUndoCount);
  }, []);

  async function load() {
    const { data } = await db
      .from("invoices")
      .select("*")
      .order("issue_date", { ascending: false });
    if (data) setInvoices(data);
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    if (
      !confirm(
        `${ids.length} 件の請求書を削除します。\n\n` +
          `紐付く品目 (invoice_items) もまとめて削除されます。\n` +
          `(直後なら「直近の一括削除を取り消す」で復元できます)`,
      )
    )
      return;
    try {
      const deleted = await bulkDeleteInvoices(ids);
      setInvoices((prev) => prev.filter((i) => !selectedIds.has(i.id)));
      clearSelection();
      setUndoCount(await getInvoiceBulkUndoCount());
      toast.success(`${deleted} 件の請求書を削除しました (取消可能)`);
    } catch (e) {
      toast.error(`削除に失敗: ${(e as Error).message}`);
    }
  }

  async function handleUndoBulkDelete() {
    try {
      const r = await undoBulkDeleteInvoices();
      if (r.restored === 0) {
        toast.info("取り消せる削除がありません");
      } else {
        toast.success(`${r.restored} 件の請求書を復元しました`);
        await load();
      }
      setUndoCount(await getInvoiceBulkUndoCount());
    } catch (e) {
      toast.error(`取り消しに失敗: ${(e as Error).message}`);
    }
  }

  const filtered = invoices.filter(
    (i) =>
      !search ||
      i.invoice_number.toLowerCase().includes(search.toLowerCase()) ||
      i.partner_name.toLowerCase().includes(search.toLowerCase()) ||
      (i.subject || "").toLowerCase().includes(search.toLowerCase())
  );

  const totals = invoices.reduce(
    (acc, i) => {
      if (i.status === "cancelled") return acc;
      acc.count++;
      acc.total += i.total_amount;
      if (i.status === "paid") acc.paid += i.total_amount;
      else acc.outstanding += i.total_amount;
      return acc;
    },
    { count: 0, total: 0, paid: 0, outstanding: 0 }
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">請求書</h1>
        <div className="flex gap-2">
          <Link href="/invoices/settings/">
            <Button variant="outline">
              <Settings className="h-4 w-4 mr-1" />
              発行者情報
            </Button>
          </Link>
          {/* Round 28: 発注書 (PO) を AI OCR で読んで請求書を自動生成 */}
          <Link href="/invoices/from-po">
            <Button variant="outline" title="受け取った発注書 (画像 / PDF) を AI で読み取って請求書のたたき台を作成">
              <Sparkles className="h-4 w-4 mr-1" />
              発注書から作成
            </Button>
          </Link>
          <Link href="/invoices/edit/">
            <Button>
              <Plus className="h-4 w-4 mr-1" />
              新規作成
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">請求書数</p>
            <p className="text-2xl font-bold">{totals.count}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">合計金額</p>
            <p className="text-2xl font-bold">¥{totals.total.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">入金済</p>
            <p className="text-2xl font-bold text-green-600">
              ¥{totals.paid.toLocaleString()}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">未入金</p>
            <p className="text-2xl font-bold text-orange-600">
              ¥{totals.outstanding.toLocaleString()}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative max-w-sm flex-1 min-w-[16rem]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="番号・取引先・件名で検索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {selectedIds.size > 0 && (
          <>
            <Badge variant="default" className="font-mono">
              {selectedIds.size} 件選択中
            </Badge>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleBulkDelete()}
              title="選択中の請求書を一括削除 (Undo 可)"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              選択を削除
            </Button>
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              選択解除
            </Button>
          </>
        )}
        {undoCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleUndoBulkDelete()}
            title="直近の一括削除を取り消して請求書を復元"
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1" />
            直近の一括削除を取り消す
            <Badge variant="secondary" className="ml-2 text-[10px]">
              {undoCount}
            </Badge>
          </Button>
        )}
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">
              {invoices.length === 0 ? "請求書がまだありません" : "一致する請求書がありません"}
            </p>
            {invoices.length === 0 && (
              <Link href="/invoices/edit/">
                <Button className="mt-4" variant="outline">
                  最初の請求書を作成
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <button
                      type="button"
                      onClick={() => {
                        const allVisible = filtered.every((i) => selectedIds.has(i.id));
                        if (allVisible) {
                          // 表示中だけ解除 (他ページの選択は維持しない仕様。ここは一覧全部)
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            for (const i of filtered) next.delete(i.id);
                            return next;
                          });
                        } else {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            for (const i of filtered) next.add(i.id);
                            return next;
                          });
                        }
                      }}
                      title={
                        filtered.length > 0 && filtered.every((i) => selectedIds.has(i.id))
                          ? "表示中をすべて解除"
                          : "表示中をすべて選択"
                      }
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {filtered.length > 0 && filtered.every((i) => selectedIds.has(i.id)) ? (
                        <CheckSquare className="h-4 w-4" />
                      ) : (
                        <Square className="h-4 w-4" />
                      )}
                    </button>
                  </TableHead>
                  <TableHead>番号</TableHead>
                  <TableHead>発行日</TableHead>
                  <TableHead>期日</TableHead>
                  <TableHead>取引先</TableHead>
                  <TableHead>件名</TableHead>
                  <TableHead className="text-right">金額</TableHead>
                  <TableHead>状態</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((inv) => {
                  const checked = selectedIds.has(inv.id);
                  return (
                    <TableRow
                      key={inv.id}
                      className={checked ? "bg-muted/40" : undefined}
                    >
                      <TableCell className="w-10">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSelected(inv.id)}
                          className="h-4 w-4 cursor-pointer"
                          aria-label={`${inv.invoice_number} を選択`}
                        />
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/invoices/edit/?id=${inv.id}`}
                          className="font-mono text-sm hover:underline text-primary"
                        >
                          {inv.invoice_number}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">{inv.issue_date}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {inv.due_date || "-"}
                      </TableCell>
                      <TableCell>{inv.partner_name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground truncate max-w-48">
                        {inv.subject || "-"}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        ¥{inv.total_amount.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusLabels[inv.status].variant} className="text-xs">
                          {statusLabels[inv.status].label}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
