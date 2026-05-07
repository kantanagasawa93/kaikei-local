"use client";

/**
 * Round 24 ⓕ: マスタデータの一覧ページ.
 * 税区分 / 勘定科目 / 取引先 / 品目 / 部門 などの基準データへの入口。
 */

import Link from "next/link";
import {
  Calculator,
  FileSpreadsheet,
  Users,
  Package,
  Building2,
  Upload,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface MasterEntry {
  href: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

const ENTRIES: MasterEntry[] = [
  {
    href: "/masters/tax-classes",
    label: "税区分",
    description: "消費税の税区分 (10 種)。仕訳・領収書・請求書で使用。",
    icon: Calculator,
  },
  {
    href: "/masters/accounts",
    label: "勘定科目",
    description: "既定 + ユーザ追加の勘定科目。仕訳画面の選択肢の元データ。",
    icon: FileSpreadsheet,
  },
  {
    href: "/partners",
    label: "取引先",
    description: "顧客 / 仕入先のリスト。OCR の自動学習で増えることもあり。",
    icon: Users,
  },
  {
    href: "/masters/import",
    label: "マスタ一括インポート",
    description: "freee / マネーフォワード から CSV で取引先を一括取込。",
    icon: Upload,
  },
];

export default function MastersIndexPage() {
  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold">マスタ管理</h1>
        <p className="text-xs text-muted-foreground mt-1">
          仕訳・請求書で使う基準データ。税区分・勘定科目は既定セットあり。
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {ENTRIES.map((e) => {
          const Icon = e.icon;
          return (
            <Link key={e.href} href={e.href}>
              <Card className="hover:shadow-md hover:border-primary/40 transition-all cursor-pointer h-full">
                <CardContent className="flex items-start gap-3 p-4">
                  <Icon className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="font-medium">{e.label}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {e.description}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
