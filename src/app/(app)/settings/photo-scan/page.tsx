"use client";

/**
 * 写真自動取込の設定ページ
 *
 * Phase 1: アクセス権限の確認 + 手動スキャン
 * Phase 3 で「毎日 21:00 に自動スキャン」を追加予定 (LaunchAgent 登録)
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Camera,
  Lock,
  CheckCircle2,
  AlertTriangle,
  Inbox as InboxIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getAuthStatus,
  requestAuth,
  scanNow,
  getLastScanUnix,
  type AuthStatus,
} from "@/lib/photo-scanner";
import { toast } from "@/lib/toast";

export default function PhotoScanSettingsPage() {
  const [auth, setAuth] = useState<AuthStatus>("unknown");
  const [lastScan, setLastScan] = useState<number>(0);
  const [requesting, setRequesting] = useState(false);
  const [scanning, setScanning] = useState(false);

  const refresh = async () => {
    setAuth(await getAuthStatus());
    setLastScan(await getLastScanUnix());
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleRequestAuth = async () => {
    setRequesting(true);
    try {
      const result = await requestAuth();
      setAuth(result);
      if (result === "authorized" || result === "limited") {
        toast.success("写真へのアクセスを許可しました");
      } else {
        toast.error(`アクセス許可が得られませんでした (${result})`);
      }
    } finally {
      setRequesting(false);
    }
  };

  const handleScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const result = await scanNow("manual");
      toast.success(
        `スキャン完了: ${result.scanned} 枚取得 / 新規 ${result.newPhotos} 枚`
      );
      await refresh();
    } catch (e) {
      toast.error(`スキャン失敗: ${(e as Error).message}`);
    } finally {
      setScanning(false);
    }
  };

  const isAuthorized = auth === "authorized" || auth === "limited";

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-4">
        <Link href="/settings">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            戻る
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Camera className="h-6 w-6" />
            写真自動取込
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            iCloud 写真から領収書候補を自動で見つけます
          </p>
        </div>
      </div>

      {/* プライバシー説明 */}
      <Card className="border-blue-200 bg-blue-50/50">
        <CardContent className="pt-6 text-sm space-y-2">
          <p className="font-semibold flex items-center gap-2">
            <Lock className="h-4 w-4 text-blue-600" />
            プライバシーへのこだわり
          </p>
          <ul className="list-disc pl-5 space-y-1 text-muted-foreground text-[13px] leading-relaxed">
            <li>
              この機能は <strong>明示的にオプトイン</strong> しない限り動きません。
              許可した後も、増分スキャン (前回以降の写真のみ) で動作します。
            </li>
            <li>
              写真の判定は <strong>すべて Mac 上 (Vision OCR)</strong>{" "}
              で完結します。Claude OCR への送信は、ユーザが「この写真を仕訳に
              するため詳細抽出する」を実行した時のみ行います。
            </li>
            <li>
              いつでも 設定 → 写真自動取込 から無効化でき、その後はスキャンが
              止まります。蓄積した写真受信箱データはローカル DB にのみ残ります。
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* 権限ステータス */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">macOS のアクセス権限</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            {isAuthorized ? (
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            ) : auth === "denied" || auth === "restricted" ? (
              <AlertTriangle className="h-5 w-5 text-red-600" />
            ) : (
              <Camera className="h-5 w-5 text-muted-foreground" />
            )}
            <div className="flex-1">
              <div className="font-medium text-sm">
                {auth === "authorized" && "全件アクセス許可済み"}
                {auth === "limited" && "選択した写真のみアクセス許可"}
                {auth === "denied" && "拒否されています"}
                {auth === "restricted" && "管理者ポリシーで制限されています"}
                {auth === "not_determined" && "未設定 (許可ダイアログ未表示)"}
                {auth === "unsupported" && "macOS 以外のため利用不可"}
                {auth === "unknown" && "確認中..."}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                ステータス: <code className="bg-muted px-1 py-0.5 rounded">{auth}</code>
              </div>
            </div>
          </div>

          {auth === "not_determined" && (
            <Button onClick={handleRequestAuth} disabled={requesting}>
              <Camera className="h-4 w-4 mr-2" />
              {requesting ? "ダイアログ応答待ち..." : "macOS の許可ダイアログを表示"}
            </Button>
          )}

          {(auth === "denied" || auth === "restricted") && (
            <div className="text-xs text-muted-foreground space-y-2 bg-muted p-3 rounded-md">
              <p>
                許可するには <strong>システム設定 → プライバシーとセキュリティ → 写真</strong> で
                「KAIKEI LOCAL」をオンにしてください。
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  const { invoke } = await import("@tauri-apps/api/core");
                  await invoke("plugin:shell|open", {
                    path: "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos",
                  });
                }}
              >
                システム設定を開く
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* スキャン実行 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">スキャン</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm">
            <div>
              前回スキャン:{" "}
              <span className="text-muted-foreground">
                {lastScan > 0 ? new Date(lastScan * 1000).toLocaleString("ja-JP") : "未実行"}
              </span>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {lastScan > 0
                ? "前回以降に撮影された写真だけが対象になります"
                : "初回は過去 7 日以内の写真をスキャンします"}
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleScan} disabled={!isAuthorized || scanning}>
              {scanning ? "スキャン中..." : "今すぐスキャン"}
            </Button>
            <Link href="/inbox">
              <Button variant="outline">
                <InboxIcon className="h-4 w-4 mr-1" />
                受信箱を見る
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Phase 3 placeholder */}
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base text-muted-foreground">
            毎日決まった時間に自動スキャン (準備中)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            macOS LaunchAgent を使った定期スキャン (例: 毎日 21:00) は次の
            アップデートで提供予定です。それまでは「今すぐスキャン」をお使いください。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
