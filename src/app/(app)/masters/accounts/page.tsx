"use client";

/**
 * Round 24 ⓕ: 勘定科目マスタ閲覧画面.
 *
 * 既定の勘定科目セット (DEFAULT_ACCOUNTS in src/lib/accounts.ts) を表示。
 * DB 側の accounts テーブルに INSERT されたユーザ追加分も併記。
 * カテゴリ別 (asset / liability / equity / revenue / expense / other) に分類表示。
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FileSpreadsheet } from "lucide-react";
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
import { DEFAULT_ACCOUNTS } from "@/lib/accounts";

interface AccountRow {
  code: string;
  name: string;
  category: string | null;
  default_tax_code: string | null;
  is_default?: number;
}

const CATEGORY_LABEL: Record<string, string> = {
  asset: "資産",
  liability: "負債",
  equity: "純資産",
  revenue: "収益",
  expense: "費用",
  other: "その他",
};

const CATEGORY_ORDER = ["asset", "liability", "equity", "revenue", "expense", "other"];

export default function AccountsMasterPage() {
  const [userRows, setUserRows] = useState<AccountRow[]>([]);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const { data } = await db.from("accounts").select("*").order("code");
    setUserRows((data as AccountRow[] | null) ?? []);
  }

  // DEFAULT_ACCOUNTS にユーザ追加分をマージ (code で重複排除)
  const merged: AccountRow[] = (() => {
    const map = new Map<string, AccountRow>();
    for (const a of DEFAULT_ACCOUNTS) {
      map.set(a.code, {
        code: a.code,
        name: a.name,
        category: a.category,
        default_tax_code: null,
        is_default: 1,
      });
    }
    for (const u of userRows) {
      // ユーザ登録分が同 code なら上書き、そうでなければ追加
      map.set(u.code, u);
    }
    return Array.from(map.values()).sort((a, b) => a.code.localeCompare(b.code));
  })();

  // カテゴリでグループ化
  const grouped: Record<string, AccountRow[]> = {};
  for (const r of merged) {
    const cat = r.category ?? "other";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(r);
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
            <FileSpreadsheet className="h-5 w-5" />
            勘定科目マスタ
          </h1>
          <p className="text-xs text-muted-foreground">
            既定の勘定科目 + ユーザー追加分。仕訳画面で選べる科目の元データ。
          </p>
        </div>
      </div>

      {CATEGORY_ORDER.map((cat) => {
        const rows = grouped[cat];
        if (!rows || rows.length === 0) return null;
        return (
          <Card key={cat}>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                {CATEGORY_LABEL[cat] ?? cat}
                <Badge variant="outline" className="text-[10px]">
                  {rows.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">コード</TableHead>
                    <TableHead>科目名</TableHead>
                    <TableHead className="w-32">既定税区分</TableHead>
                    <TableHead className="w-20 text-center">既定</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.code}>
                      <TableCell className="font-mono text-xs">
                        {r.code}
                      </TableCell>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.default_tax_code ?? "-"}
                      </TableCell>
                      <TableCell className="text-center">
                        {r.is_default ? (
                          <Badge variant="secondary" className="text-[10px]">
                            既定
                          </Badge>
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
        );
      })}
    </div>
  );
}
