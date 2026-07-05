"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileSpreadsheet, Loader2, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";
import { checkReadiness, type ReadinessReport } from "@/lib/etax/readiness";
import Link from "next/link";

/**
 * Round 28 ⓓ: 確定申告の準備状況カード (設定画面版).
 * ダッシュボードの同カードは 1/1〜3/15 のみ自動表示だが、こちらはボタン押下で
 * 通年いつでも開ける。年度はその時点で「進行中の年」を対象にする。
 */
export function ReadinessCard() {
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [loading, setLoading] = useState(false);

  const onShow = async () => {
    setLoading(true);
    try {
      // 期間外でも見たいので「進行中の年」を対象に集計する
      // (checkReadiness は now を基準に inWindow / year を決めるため、
      //  6/1 のような日付を渡すと year=現在年・inWindow=false になる)
      const probe = new Date();
      probe.setMonth(5, 1); // 6月1日 → 必ず期間外 → year は現在進行中の年
      setReport(await checkReadiness(probe));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileSpreadsheet className="h-4 w-4" />
          確定申告の準備状況
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          帳簿の入力状況・要対応項目をチェックリストで確認します。
          確定申告期 (1/1〜3/15) はダッシュボードにも自動表示されますが、ここからは通年で開けます。
        </p>
        {!report && (
          <Button variant="outline" size="sm" onClick={() => void onShow()} disabled={loading}>
            {loading ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <FileSpreadsheet className="h-3 w-3 mr-1" />
            )}
            準備状況を見る
          </Button>
        )}
        {report && (
          <div className="rounded border border-blue-200 bg-blue-50/60 p-3 space-y-1.5">
            <p className="font-medium text-blue-900">
              {report.year} 年分 — {report.completionPct}% 完了
              {report.blockers > 0 && (
                <span className="ml-2 text-red-700">({report.blockers} 件 要対応)</span>
              )}
            </p>
            {report.checks.map((c) => {
              const icon =
                c.status === "ok" ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
                ) : c.status === "warning" ? (
                  <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0" />
                );
              const inner = (
                <div className="flex items-start gap-2 py-1">
                  {icon}
                  <div className="flex-1">
                    <p className="font-medium">{c.label}</p>
                    <p className="text-xs text-muted-foreground">{c.detail}</p>
                  </div>
                  {c.href && <span className="text-blue-700 text-xs">→</span>}
                </div>
              );
              return c.href ? (
                <Link key={c.id} href={c.href} className="block hover:bg-blue-100/60 rounded px-1 -mx-1">
                  {inner}
                </Link>
              ) : (
                <div key={c.id} className="px-1 -mx-1">
                  {inner}
                </div>
              );
            })}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => void onShow()}
              disabled={loading}
            >
              <RefreshCw className={`h-3 w-3 mr-1 ${loading ? "animate-spin" : ""}`} />
              再計算
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
