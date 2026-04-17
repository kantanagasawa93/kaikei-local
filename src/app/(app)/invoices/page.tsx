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
import { Plus, Search, FileText, Settings } from "lucide-react";
import type { Invoice } from "@/types";

const statusLabels: Record<Invoice["status"], { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  draft: { label: "下書き", variant: "outline" },
  sent: { label: "送付済", variant: "secondary" },
  paid: { label: "入金済", variant: "default" },
  cancelled: { label: "キャンセル", variant: "destructive" },
};

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const { data } = await db
      .from("invoices")
      .select("*")
      .order("issue_date", { ascending: false });
    if (data) setInvoices(data);
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

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="番号・取引先・件名で検索"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
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
                {filtered.map((inv) => (
                  <TableRow key={inv.id}>
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
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
