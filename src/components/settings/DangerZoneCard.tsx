"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * ㉻ Round 15: データ全消去カード (アンインストール補助). 二重確認で
 * DELETE 文字入力を要求してから wipe_app_data Tauri command を呼ぶ。
 * ㉽ migrations_status で DB 適用状況もここに表示する。
 */
export function DangerZoneCard() {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [migrations, setMigrations] = useState<
    | {
        ok: boolean;
        rows?: { version: number; description: string; success: boolean }[];
        count?: number;
      }
    | null
  >(null);

  const loadMigrations = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = (await invoke("migrations_status")) as typeof migrations;
      setMigrations(res);
    } catch (e) {
      console.warn("[settings] migrations_status failed:", e);
    }
  };
  // ページ初回 mount 時に migrations を取りに行く
  useEffect(() => {
    void loadMigrations();
  }, []);

  const handleWipe = async () => {
    if (busy) return;
    if (confirmText !== "DELETE") return;
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const r = (await invoke("wipe_app_data")) as {
        ok: boolean;
        backup_path?: string;
        removed_size_bytes?: number;
        error?: string;
      };
      if (r.ok) {
        const mb =
          typeof r.removed_size_bytes === "number"
            ? (r.removed_size_bytes / 1024 / 1024).toFixed(1)
            : "?";
        alert(
          `データを全削除しました (${mb} MB)。\n\n` +
            `バックアップ: ${r.backup_path ?? "(なし)"}\n\n` +
            `アプリを終了して再起動してください。`,
        );
      } else {
        alert(`削除に失敗: ${r.error ?? "unknown"}`);
      }
    } catch (e) {
      alert(`削除に失敗: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setConfirmText("");
    }
  };

  return (
    <Card className="border-red-300">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2 text-red-800">
          危険な操作 (アンインストール補助)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {/* ㉽ migrations_status: 現在の DB 適用状況をその場で確認 */}
        {migrations && migrations.rows && (
          <div className="text-xs text-muted-foreground">
            <p className="mb-1">DB マイグレーション適用状況: {migrations.count} 件</p>
            <ul className="font-mono leading-tight">
              {migrations.rows.slice(-5).map((r) => (
                <li key={r.version}>
                  v{r.version} — {r.description} {r.success ? "✓" : "✗"}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="border-t pt-3">
          <p className="text-red-700 font-medium mb-1">データ全消去</p>
          <p className="text-xs text-muted-foreground mb-2">
            kaikei.db / 領収書画像 / 写真受信箱を完全削除します。<br />
            自動でバックアップ (<code>~/Library/Application Support/dev.kaikei.app.bak-...</code>)
            が作成されますが、消した後は新規 DB として起動します。
          </p>
          <p className="text-xs mb-2">
            実行するには下のフィールドに <code className="bg-muted px-1 rounded">DELETE</code> と入力してください:
          </p>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="DELETE"
            className="border rounded px-2 py-1 text-sm font-mono mr-2"
          />
          <Button
            variant="destructive"
            size="sm"
            disabled={busy || confirmText !== "DELETE"}
            onClick={handleWipe}
          >
            {busy ? "削除中..." : "データを全削除"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
