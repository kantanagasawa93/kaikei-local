"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Database } from "lucide-react";

type Stats = {
  journals: number;
  receipts: number;
  invoices: number;
  partners: number;
  fixedAssets: number;
};

/** 設定画面「データ概要」: 主要テーブルの件数とデータ保存先を表示する。 */
export function DataOverviewCard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [appDir, setAppDir] = useState<string>("");

  useEffect(() => {
    (async () => {
      try {
        const { db } = await import("@/lib/localDb");
        const [j, r, inv, p, f] = await Promise.all([
          db.from("journals").select("id", { count: "exact", head: true }),
          db.from("receipts").select("id", { count: "exact", head: true }),
          db.from("invoices").select("id", { count: "exact", head: true }),
          db.from("partners").select("id", { count: "exact", head: true }),
          db.from("fixed_assets").select("id", { count: "exact", head: true }),
        ]);
        setStats({
          journals: j.count || 0,
          receipts: r.count || 0,
          invoices: inv.count || 0,
          partners: p.count || 0,
          fixedAssets: f.count || 0,
        });

        const { appDataDir } = await import("@tauri-apps/api/path");
        setAppDir(await appDataDir());
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="h-4 w-4" />
          データ概要
        </CardTitle>
      </CardHeader>
      <CardContent>
        {stats ? (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label="仕訳" value={stats.journals} />
            <Stat label="領収書" value={stats.receipts} />
            <Stat label="請求書" value={stats.invoices} />
            <Stat label="取引先" value={stats.partners} />
            <Stat label="固定資産" value={stats.fixedAssets} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">読込中...</p>
        )}
        {appDir && (
          <div className="mt-4 text-xs text-muted-foreground break-all">
            <Badge variant="outline" className="mr-2">
              データ保存先
            </Badge>
            {appDir}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-bold">{value.toLocaleString()}</p>
    </div>
  );
}
