"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, CheckCircle2, RefreshCw } from "lucide-react";
import {
  checkAutoUpdate,
  downloadAndInstallUpdate,
  getAutoUpdaterStatus,
  type AutoUpdaterStatus,
} from "@/lib/auto-updater";

/**
 * Round 24 ⓒ: アップデート確認カード.
 * 起動 4 秒後の自動チェック (auto-updater が呼ぶ) に加えて、
 * 「今すぐ確認」ボタンで明示的にチェックさせる動線。
 */
export function UpdaterCheckCard() {
  const [status, setStatus] = useState<AutoUpdaterStatus>(getAutoUpdaterStatus());
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // package.json の version を表示用に
    void (async () => {
      try {
        const isTauri = typeof window !== "undefined" &&
          Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
        if (isTauri) {
          const { getVersion } = await import("@tauri-apps/api/app");
          setCurrentVersion(await getVersion());
        } else {
          const pkg = (await import("../../../package.json")).default ?? {};
          setCurrentVersion((pkg as { version?: string }).version ?? "?");
        }
      } catch {
        setCurrentVersion("?");
      }
    })();
  }, []);

  const onCheck = async () => {
    setBusy(true);
    try {
      const next = await checkAutoUpdate();
      setStatus(next);
    } finally {
      setBusy(false);
    }
  };

  const onInstall = async () => {
    setBusy(true);
    try {
      await downloadAndInstallUpdate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Download className="h-4 w-4" />
          アプリのアップデート
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground">現在のバージョン:</span>
          <code className="font-mono">v{currentVersion || "?"}</code>
        </div>
        {status.kind === "available" && (
          <div className="rounded border border-blue-300 bg-blue-50 p-3 text-blue-900">
            <p className="font-medium">
              新しいバージョン v{status.version} が公開されています
            </p>
            {status.body && (
              <p className="text-xs mt-1 line-clamp-3">{status.body}</p>
            )}
            <Button
              size="sm"
              className="mt-2"
              onClick={() => void onInstall()}
              disabled={busy}
            >
              ダウンロードして再起動
            </Button>
          </div>
        )}
        {status.kind === "up_to_date" && (
          <div className="text-xs text-muted-foreground inline-flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3 text-green-600" />
            最新です (v{status.currentVersion})
          </div>
        )}
        {status.kind === "downloading" && (
          <div className="text-xs">
            ダウンロード中…{" "}
            {status.total
              ? `${Math.round((status.bytes / status.total) * 100)}%`
              : `${Math.round(status.bytes / 1024 / 1024)} MB`}
          </div>
        )}
        {status.kind === "error" && (
          <p className="text-xs text-red-700">エラー: {status.message}</p>
        )}
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onCheck()}
            disabled={busy || status.kind === "downloading"}
          >
            <RefreshCw className={`h-3 w-3 mr-1 ${busy ? "animate-spin" : ""}`} />
            今すぐ確認
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
