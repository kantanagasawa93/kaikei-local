"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  HardDriveDownload,
  HardDriveUpload,
  FolderOpen,
  Trash2,
} from "lucide-react";
import { cleanupOrphanReceiptFiles, openReceiptsFolder } from "@/lib/receipts";

/**
 * 設定画面「バックアップ・復元」: kaikei.db + receipts/ の ZIP 書き出し・復元・
 * データフォルダを開く・孤児ファイル整理。
 * 結果メッセージはページ上部に出すため onMessage で親へ渡す。
 */
export function BackupRestoreCard({
  onMessage,
}: {
  onMessage: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  const handleCleanup = async () => {
    if (
      !confirm(
        "DBに紐付いていない画像ファイルを削除します。\n（通常は削除済み領収書のゴミファイル）"
      )
    )
      return;
    setBusy(true);
    try {
      const { removed, kept } = await cleanupOrphanReceiptFiles();
      onMessage(`整理完了: ${removed}件削除 / ${kept}件保持`);
    } catch (e) {
      onMessage(`整理に失敗: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const openDataFolder = async () => {
    try {
      const { appDataDir } = await import("@tauri-apps/api/path");
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(await appDataDir());
    } catch (e) {
      console.error("open failed", e);
    }
  };

  const handleBackup = async () => {
    setBusy(true);
    onMessage(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { readFile, writeFile, exists, readDir, BaseDirectory } = await import(
        "@tauri-apps/plugin-fs"
      );
      const JSZip = (await import("jszip")).default;

      const now = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const outPath = await save({
        defaultPath: `kaikei-local-backup-${now}.zip`,
        filters: [{ name: "kaikei backup", extensions: ["zip"] }],
      });
      if (!outPath) {
        setBusy(false);
        return;
      }

      const zip = new JSZip();

      // DB 本体
      const dbExists = await exists("kaikei.db", { baseDir: BaseDirectory.AppData });
      if (!dbExists) {
        onMessage("データベースが見つかりません");
        setBusy(false);
        return;
      }
      const dbBytes = await readFile("kaikei.db", { baseDir: BaseDirectory.AppData });
      zip.file("kaikei.db", dbBytes);

      // receipts 画像ファイル
      let receiptCount = 0;
      try {
        const entries = await readDir("receipts", { baseDir: BaseDirectory.AppData });
        for (const entry of entries) {
          if (!entry.isFile) continue;
          const rel = `receipts/${entry.name}`;
          try {
            const bytes = await readFile(rel, { baseDir: BaseDirectory.AppData });
            zip.file(rel, bytes);
            receiptCount++;
          } catch (e) {
            console.warn(`skip ${rel}:`, e);
          }
        }
      } catch (e) {
        // receipts ディレクトリがまだ無い場合は無視
        console.info("receipts dir missing or empty", e);
      }

      // メタ情報 (version は実行中アプリから取得。旧実装は "0.1.0" 固定だった)
      let appVersion = "unknown";
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        appVersion = await getVersion();
      } catch {
        /* Tauri 外では unknown のまま */
      }
      zip.file(
        "meta.json",
        JSON.stringify(
          {
            app: "KAIKEI LOCAL",
            version: appVersion,
            created_at: new Date().toISOString(),
            receipt_count: receiptCount,
          },
          null,
          2
        )
      );

      const zipBytes = await zip.generateAsync({ type: "uint8array" });
      await writeFile(outPath, zipBytes);
      onMessage(`バックアップ完了: ${outPath}\nDB + 領収書 ${receiptCount}件`);
    } catch (e) {
      console.error(e);
      onMessage(`バックアップに失敗しました: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    if (
      !confirm(
        "現在のデータは全て上書きされます。続行しますか？\n念のため事前にバックアップを取ることを推奨します。"
      )
    )
      return;
    setBusy(true);
    onMessage(null);
    // rollback 関数は catch からも見える必要があるので try の外で宣言
    let rollback: () => Promise<void> = async () => {};
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const {
        readFile,
        writeFile,
        mkdir,
        remove,
        readDir,
        BaseDirectory,
      } = await import("@tauri-apps/plugin-fs");
      const JSZip = (await import("jszip")).default;

      const selected = await open({
        multiple: false,
        filters: [
          { name: "kaikei backup", extensions: ["zip", "db"] },
        ],
      });
      if (!selected) {
        setBusy(false);
        return;
      }

      const path = typeof selected === "string" ? selected : "";
      if (!path) {
        setBusy(false);
        return;
      }

      const bytes = await readFile(path);

      // ── 復元前スナップショット ──
      // 失敗してもロールバックできるように、現在の kaikei.db を
      // kaikei.db.pre-restore にコピーしておく。
      let preRestoreCreated = false;
      try {
        const current = await readFile("kaikei.db", {
          baseDir: BaseDirectory.AppData,
        });
        await writeFile("kaikei.db.pre-restore", current, {
          baseDir: BaseDirectory.AppData,
        });
        preRestoreCreated = true;
      } catch {
        // 現DB が無い = 初回なので snapshot 不要
      }

      rollback = async () => {
        if (!preRestoreCreated) return;
        try {
          const snap = await readFile("kaikei.db.pre-restore", {
            baseDir: BaseDirectory.AppData,
          });
          await writeFile("kaikei.db", snap, {
            baseDir: BaseDirectory.AppData,
          });
        } catch {}
      };

      if (path.toLowerCase().endsWith(".zip")) {
        // ZIP 展開
        const zip = await JSZip.loadAsync(bytes);

        // 既存 receipts フォルダのファイルを削除
        try {
          const entries = await readDir("receipts", { baseDir: BaseDirectory.AppData });
          for (const entry of entries) {
            if (entry.isFile) {
              try {
                await remove(`receipts/${entry.name}`, { baseDir: BaseDirectory.AppData });
              } catch {}
            }
          }
        } catch {}

        try {
          await mkdir("receipts", { baseDir: BaseDirectory.AppData, recursive: true });
        } catch {}

        let dbRestored = false;
        let receiptCount = 0;

        for (const [name, file] of Object.entries(zip.files)) {
          if (file.dir) continue;
          const content = await file.async("uint8array");
          if (name === "kaikei.db") {
            await writeFile("kaikei.db", content, { baseDir: BaseDirectory.AppData });
            dbRestored = true;
          } else if (name.startsWith("receipts/")) {
            await writeFile(name, content, { baseDir: BaseDirectory.AppData });
            receiptCount++;
          }
          // meta.json は無視
        }

        if (!dbRestored) {
          await rollback();
          onMessage("バックアップ ZIP に kaikei.db が含まれていません。元のデータに戻しました。");
          setBusy(false);
          return;
        }
        onMessage(
          `復元しました (DB + 領収書 ${receiptCount}件)\nアプリを再起動してください。\n復元前のデータは kaikei.db.pre-restore に保存されています (問題があれば削除してリネーム)。`
        );
      } else {
        // 旧フォーマット: .db のみ
        await writeFile("kaikei.db", bytes, { baseDir: BaseDirectory.AppData });
        onMessage("復元しました。アプリを再起動してください。\n(旧フォーマットのため画像は復元されません)\n復元前のデータは kaikei.db.pre-restore に保存されています。");
      }
    } catch (e) {
      console.error(e);
      await rollback();
      onMessage(`復元に失敗しました: ${(e as Error).message}\n元のデータに自動でロールバックしました。`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">バックアップ・復元</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          全データはSQLiteファイル (<code>kaikei.db</code>) にまとまっています。
          定期的にバックアップを取り、別のMacへ移行することもできます。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={handleBackup} disabled={busy}>
            <HardDriveDownload className="h-4 w-4 mr-1" />
            バックアップ（ZIP）
          </Button>
          <Button onClick={handleRestore} disabled={busy} variant="outline">
            <HardDriveUpload className="h-4 w-4 mr-1" />
            復元
          </Button>
          <Button onClick={openDataFolder} variant="outline">
            <FolderOpen className="h-4 w-4 mr-1" />
            データフォルダを開く
          </Button>
          <Button onClick={openReceiptsFolder} variant="outline">
            <FolderOpen className="h-4 w-4 mr-1" />
            領収書画像フォルダを開く
          </Button>
          <Button onClick={handleCleanup} variant="outline" disabled={busy}>
            <Trash2 className="h-4 w-4 mr-1" />
            孤児ファイル整理
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          バックアップは kaikei.db と receipts/ フォルダを丸ごと ZIP に固めます。
          友達のMacに移行する場合は、この ZIP を渡してください。
        </p>
      </CardContent>
    </Card>
  );
}
