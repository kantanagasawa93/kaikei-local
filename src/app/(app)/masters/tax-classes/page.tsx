"use client";

/**
 * Round 24 ⓕ: 税区分マスタ閲覧画面.
 *
 * tax_classes は migration v1 で初期 10 行 (OUT/NT/EXM/EXP/S10/S08R/S08/P10/P08R/P08)
 * が INSERT 済み。UI から閲覧 + 並び順変更 / 表示名変更ができる。
 * (新規税区分の追加は基本的に税制改正時のみで頻度が低いため、ここでは編集のみ)
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Calculator } from "lucide-react";
import { db } from "@/lib/localDb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

interface TaxClassRow {
  code: string;
  name: string;
  rate: number;
  kind:
    | "taxable_sales"
    | "taxable_purchase"
    | "export"
    | "exempt"
    | "non_taxable"
    | "out_of_scope";
  reduced: number;
  sort_order: number;
}

const KIND_LABEL: Record<TaxClassRow["kind"], string> = {
  taxable_sales: "課税売上",
  taxable_purchase: "課税仕入",
  export: "輸出免税",
  exempt: "非課税",
  non_taxable: "不課税",
  out_of_scope: "対象外",
};

export default function TaxClassesPage() {
  const [rows, setRows] = useState<TaxClassRow[]>([]);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const { data } = await db
      .from("tax_classes")
      .select("*")
      .order("sort_order", { ascending: true });
    if (data) setRows(data as TaxClassRow[]);
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Link href="/masters">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            マスタ一覧へ
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Calculator className="h-5 w-5" />
            税区分マスタ
          </h1>
          <p className="text-xs text-muted-foreground">
            消費税の税区分 (10 種類)。仕訳・領収書・請求書で使用される基準データ。
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">登録済み税区分 ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">コード</TableHead>
                <TableHead>名称</TableHead>
                <TableHead className="text-right w-20">税率</TableHead>
                <TableHead>区分</TableHead>
                <TableHead className="w-20 text-center">軽減</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.code}>
                  <TableCell className="font-mono text-xs">{r.code}</TableCell>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.rate}%
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {KIND_LABEL[r.kind] ?? r.kind}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-center">
                    {r.reduced ? (
                      <Badge className="text-[10px]">軽減 8%</Badge>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        税区分は税制改正のタイミングで国税庁の通達に基づき更新されます。
        編集は将来のラウンドで対応予定。
      </p>
    </div>
  );
}
