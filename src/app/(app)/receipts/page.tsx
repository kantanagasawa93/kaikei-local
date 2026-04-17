"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Plus, Search, Receipt as ReceiptIcon } from "lucide-react";
import type { Receipt } from "@/types";
import { ReceiptDropZone } from "@/components/receipt-drop-zone";

export default function ReceiptsPage() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [search, setSearch] = useState("");
  const [monthFilter, setMonthFilter] = useState("");

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
              <Card className="hover:shadow-md transition-shadow cursor-pointer">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
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
