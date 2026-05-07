"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Plus,
  Search,
  Receipt as ReceiptIcon,
  CheckSquare,
  Square,
  Trash2,
  Download,
} from "lucide-react";
import type { Receipt } from "@/types";
import { ReceiptDropZone } from "@/components/receipt-drop-zone";
import { downloadCsv } from "@/lib/journal-export";
import { toast } from "@/lib/toast";

export default function ReceiptsPage() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [search, setSearch] = useState("");
  const [monthFilter, setMonthFilter] = useState("");
  // Round 24 ⓑ: bulk select 状態
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadReceipts();
  }, []);

  async function loadReceipts() {
    const { data } = await supabase
      .from("receipts")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setReceipts(data);
  }

  function toggleSelected(id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible(ids: string[]) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
      if (allSelected) {
        for (const id of ids) next.delete(id);
      } else {
        for (const id of ids) next.add(id);
      }
      return next;
    });
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    if (!confirm(`${selectedIds.size} 件の領収書を削除します。よろしいですか?`))
      return;
    let count = 0;
    for (const id of selectedIds) {
      try {
        await supabase.from("receipts").delete().eq("id", id);
        count++;
      } catch (e) {
        console.warn(`bulk delete ${id} failed:`, e);
      }
    }
    toast.success(`${count} 件削除しました`);
    setSelectedIds(new Set());
    loadReceipts();
  }

  function handleBulkExport() {
    if (selectedIds.size === 0) return;
    const targets = receipts.filter((r) => selectedIds.has(r.id));
    const escape = (v: string) =>
      v.includes(",") || v.includes('"') || v.includes("\n")
        ? `"${v.replace(/"/g, '""')}"`
        : v;
    const headers = [
      "日付",
      "取引先",
      "金額",
      "勘定科目コード",
      "勘定科目名",
      "ステータス",
      "ファイル",
    ];
    const lines = [
      headers.map(escape).join(","),
      ...targets.map((r) =>
        [
          r.date ?? "",
          r.vendor_name ?? "",
          r.amount != null ? String(r.amount) : "",
          r.account_code ?? "",
          r.account_name ?? "",
          r.status ?? "",
          r.image_url ?? "",
        ]
          .map(escape)
          .join(","),
      ),
    ];
    const csv = "﻿" + lines.join("\r\n") + "\r\n";
    downloadCsv(
      csv,
      `kaikei_receipts_${new Date().toISOString().slice(0, 10)}.csv`,
    );
    toast.success(`${targets.length} 件を CSV で書き出しました`);
  }

  const filteredReceipts = receipts.filter((r) => {
    const matchesSearch =
      !search ||
      r.vendor_name?.toLowerCase().includes(search.toLowerCase()) ||
      r.account_name?.toLowerCase().includes(search.toLowerCase());
    const matchesMonth =
      !monthFilter || r.date?.startsWith(monthFilter);
    return matchesSearch && matchesMonth;
  });

  const formatCurrency = (amount: number | null) =>
    amount != null
      ? new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(amount)
      : "-";

  const statusLabels: Record<string, { label: string; variant: "default" | "secondary" | "outline" }> = {
    pending: { label: "未処理", variant: "outline" },
    processed: { label: "処理済", variant: "secondary" },
    confirmed: { label: "確認済", variant: "default" },
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">領収書</h1>
        <Link href="/receipts/new">
          <Button>
            <Plus className="h-4 w-4 mr-1" />
            新規登録
          </Button>
        </Link>
      </div>

      <ReceiptDropZone onImported={loadReceipts} />

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="店名・科目で検索..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Input
          type="month"
          value={monthFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
          className="w-44"
        />
      </div>

      {/* Round 24 ⓑ: bulk action toolbar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 border border-blue-200 rounded-md">
          <span className="text-sm font-medium text-blue-700">
            {selectedIds.size} 件選択中
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={handleBulkExport}
            title="選択した領収書を CSV でダウンロード"
          >
            <Download className="h-3 w-3 mr-1" />
            CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleBulkDelete()}
            title="選択した領収書を削除"
          >
            <Trash2 className="h-3 w-3 mr-1" />
            削除
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelectedIds(new Set())}
          >
            選択解除
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => selectAllVisible(filteredReceipts.map((r) => r.id))}
            className="ml-auto"
          >
            表示中すべて選択
          </Button>
        </div>
      )}

      {filteredReceipts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <ReceiptIcon className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">
              {receipts.length === 0
                ? "領収書がまだありません"
                : "検索条件に一致する領収書がありません"}
            </p>
            {receipts.length === 0 && (
              <Link href="/receipts/new">
                <Button className="mt-4" variant="outline">
                  最初の領収書を登録
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filteredReceipts.map((receipt) => (
            <Link key={receipt.id} href={`/receipts/view/?id=${receipt.id}`}>
              <Card
                className={`hover:shadow-md transition-shadow cursor-pointer ${
                  selectedIds.has(receipt.id) ? "ring-2 ring-primary" : ""
                }`}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    {/* Round 24 ⓑ: bulk select checkbox (Link を抑制) */}
                    <button
                      type="button"
                      onClick={(e) => toggleSelected(receipt.id, e)}
                      className="mr-2 mt-0.5 hover:opacity-70 flex-shrink-0"
                      aria-label={selectedIds.has(receipt.id) ? "選択解除" : "選択"}
                    >
                      {selectedIds.has(receipt.id) ? (
                        <CheckSquare className="h-4 w-4 text-primary" />
                      ) : (
                        <Square className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">
                        {receipt.vendor_name || "不明な取引先"}
                      </p>
                      <p className="text-lg font-bold mt-1">
                        {formatCurrency(receipt.amount)}
                      </p>
                      <div className="flex items-center gap-2 mt-2">
                        <span className="text-xs text-muted-foreground">
                          {receipt.date || "日付不明"}
                        </span>
                        {receipt.account_name && (
                          <Badge variant="secondary" className="text-xs">
                            {receipt.account_name}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Badge variant={statusLabels[receipt.status]?.variant || "outline"}>
                      {statusLabels[receipt.status]?.label || receipt.status}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
