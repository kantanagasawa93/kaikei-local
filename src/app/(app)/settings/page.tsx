"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileDown, FileText, Upload } from "lucide-react";
import Link from "next/link";
import { DataOverviewCard } from "@/components/settings/DataOverviewCard";
import { BackupRestoreCard } from "@/components/settings/BackupRestoreCard";
import { AiOcrCard } from "@/components/settings/AiOcrCard";
import { IssuerInfoCard } from "@/components/settings/IssuerInfoCard";
import { UpdaterCheckCard } from "@/components/settings/UpdaterCheckCard";
import { ReadinessCard } from "@/components/settings/ReadinessCard";
import { GuideCard } from "@/components/settings/GuideCard";
import { DangerZoneCard } from "@/components/settings/DangerZoneCard";

/**
 * 設定・データ管理ページ。
 * Round 30 で各カードを src/components/settings/ に分割した (inbox と同じ要領)。
 * ここはカードの並び順と、バックアップ系の結果メッセージ表示だけを持つ。
 */
export default function SettingsPage() {
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">設定・データ管理</h1>

      {message && (
        <div className="rounded-md bg-blue-50 border border-blue-200 text-blue-800 px-4 py-2 text-sm whitespace-pre-wrap">
          {message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileDown className="h-4 w-4" />
            他ソフトから移行
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            freee / マネーフォワード / 弥生 などから CSV をエクスポートして KAIKEI LOCAL に取り込めます。
          </p>
          <div className="flex gap-2 flex-wrap">
            <Link href="/journals/import">
              <Button variant="outline" size="sm">
                <Upload className="h-4 w-4 mr-1" />
                仕訳帳 CSV 取込（8形式）
              </Button>
            </Link>
            <Link href="/masters/import">
              <Button variant="outline" size="sm">
                <Upload className="h-4 w-4 mr-1" />
                マスタ CSV 取込（勘定科目・取引先）
              </Button>
            </Link>
            <Link href="/evidence/import">
              <Button variant="outline" size="sm">
                <Upload className="h-4 w-4 mr-1" />
                証憑 ZIP 取込（電帳法対応）
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4" />
            e-Tax 申告情報
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            確定申告 XTX ファイル生成に必要な納税者情報（氏名・住所・税務署・利用者識別番号など）を登録します。
          </p>
          <Link href="/settings/etax/">
            <Button variant="outline" size="sm">
              <FileText className="h-4 w-4 mr-1" />
              納税者情報を設定
            </Button>
          </Link>
        </CardContent>
      </Card>

      <DataOverviewCard />
      <BackupRestoreCard onMessage={setMessage} />
      <AiOcrCard />
      <IssuerInfoCard />
      <UpdaterCheckCard />
      <ReadinessCard />
      <GuideCard />
      <DangerZoneCard />
    </div>
  );
}
