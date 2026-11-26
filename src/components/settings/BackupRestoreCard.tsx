"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  HardDriveDownload,
  HardDriveUpload,
  FolderOpen,
  Trash2,
  FileImage,
} from "lucide-react";
import { cleanupOrphanReceiptFiles, migrateRawPdfReceipts } from "@/lib/receipts";
import { confirmDialog } from "@/lib/confirm";

interface BackupSummary {
  path: string;
  db_bytes: number;
  file_count: number;
  file_bytes: number;
  journals: number;
  receipts: number;
}

interface StagedRestore {
  journals: number;
  receipts: number;
  file_count: number;
  schema_version: number;
  backup_app_version: string | null;
  backup_created_at: string | null;
  source: string;
}

/** Tauri の invoke は Err(String) を文字列のまま reject するので両対応で取り出す */
function errText(e: unknown): string {
  if (typeof e === "string") return e;
  return (e as Error)?.message || String(e);
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** ファイル名用のローカル日時 (toISOString は UTC なので日本時間の朝だと前日になる) */
function localStamp(): string {
  const d = new Date();
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(
    d.getMinutes(),
  )}-${p(d.getSeconds())}`;
}

/**
 * 設定画面「バックアップ・復元」: DB + 領収書画像 (receipts/・inbox/) の ZIP 書き出し・復元・
 * データフォルダを開く・孤児ファイル整理。
 * 結果メッセージはページ上部に出すため onMessage で親へ渡す。
 *
 * DB は WAL モードで開かれているので、kaikei.db を画面側から直接読み書きしてはいけない
 * (直近の入力がバックアップから欠ける / 復元した DB が終了時に壊れる)。
 * 実処理は Rust 側 (src-tauri/src/backup.rs) の backup_create / restore_stage が行い、
 * 復元の差し替えは「次回起動時、DB を開く前」に行われる。
 */
export function BackupRestoreCard({
  onMessage,
}: {
  onMessage: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  // 復元が予約済み (再起動待ち) ならその概要
  const [pending, setPending] = useState<StagedRestore | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        setPending((await invoke<StagedRestore | null>("restore_pending")) ?? null);
      } catch {
        /* Tauri 外 (ブラウザ実行) では何もしない */
      }
    })();
  }, []);

  const handleCleanup = async () => {
    if (
      !(await confirmDialog(
        "どの領収書からも参照されていない画像ファイルを削除します。\n" +
          "（通常は削除済み領収書の残りファイル。原本 PDF・トリミング前の画像・スマホ受信分は消しません）"
      ))
    )
      return;
    setBusy(true);
    try {
      const { removed, kept, pendingPhone } = await cleanupOrphanReceiptFiles();
      onMessage(
        `整理完了: ${removed}件削除 / ${kept}件保持` +
          (pendingPhone > 0
            ? `\nスマホから受信して未登録の ${pendingPhone}件は対象外です（「スマホ取込」ページで登録または破棄してください）`
            : ""),
      );
    } catch (e) {
      onMessage(`整理に失敗: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // Round 33: PDF→JPEG 変換 (v0.3.2) 以前に取り込まれた raw PDF 領収書の移行
  const handleMigratePdf = async () => {
    if (
      !(await confirmDialog(
        "PDF のまま登録されている領収書に、表示・読み取り用の画像 (JPEG) を作ります。\n" +
          "変換後はサムネイル表示と AI OCR が使えるようになります。\n" +
          "元の PDF は原本としてそのまま残します。"
      ))
    )
      return;
    setBusy(true);
    try {
      const { converted, failed, total } = await migrateRawPdfReceipts();
      if (total === 0) {
        onMessage("PDF のままの領収書はありません（移行不要）");
      } else {
        onMessage(
          `PDF領収書の画像化: ${converted}件変換` +
            (failed > 0 ? ` / ${failed}件失敗（PDF のまま残しています）` : ""),
        );
      }
    } catch (e) {
      onMessage(`PDF領収書の画像化に失敗: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async (which: "data" | "receipts") => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_app_folder", { which });
    } catch (e) {
      onMessage(`フォルダを開けませんでした: ${errText(e)}`);
    }
  };

  const handleBackup = async () => {
    setBusy(true);
    onMessage(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");

      const outPath = await save({
        defaultPath: `kaikei-local-backup-${localStamp()}.zip`,
        filters: [{ name: "kaikei backup", extensions: ["zip"] }],
      });
      if (!outPath) return;

      onMessage("バックアップを作成中…（画像が多いと 1 分ほどかかります）");
      const s = await invoke<BackupSummary>("backup_create", { destPath: outPath });
      onMessage(
        `バックアップ完了: ${s.path}\n` +
          `仕訳 ${s.journals}件 / 領収書 ${s.receipts}件 / 画像 ${s.file_count}枚` +
          `（${formatBytes(s.db_bytes + s.file_bytes)}）`,
      );
    } catch (e) {
      console.error(e);
      onMessage(`バックアップに失敗しました: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    if (
      !(await confirmDialog(
        "バックアップから復元します。\n\n" +
          "・今のデータは、選んだバックアップの内容に置き換わります\n" +
          "・置き換えはアプリの再起動時に行われます\n" +
          "・今のデータは「pre-restore-日時」フォルダに退避されます（直近 1 回分）\n\n" +
          "続けますか？",
        "復元",
      ))
    )
      return;
    setBusy(true);
    onMessage(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");

      const selected = await open({
        multiple: false,
        filters: [{ name: "kaikei backup", extensions: ["zip", "db"] }],
      });
      const path = typeof selected === "string" ? selected : "";
      if (!path) return;

      onMessage("バックアップを確認中…");
      // ここでは検証とステージング領域への展開だけを行う。今のデータには触れない。
      const staged = await invoke<StagedRestore>("restore_stage", { srcPath: path });
      setPending(staged);

      const detail =
        `仕訳 ${staged.journals}件 / 領収書 ${staged.receipts}件 / 画像 ${staged.file_count}枚` +
        (staged.backup_created_at
          ? `\n作成日時: ${staged.backup_created_at.slice(0, 19).replace("T", " ")}`
          : "") +
        (staged.file_count === 0 && staged.receipts > 0
          ? "\n※ このバックアップには画像が含まれていません（旧形式）"
          : "");

      const restartNow = await confirmDialog(
        `バックアップを確認しました。\n${detail}\n\n` +
          "今すぐアプリを再起動して復元を適用しますか？\n" +
          "（キャンセルすると、次にアプリを起動した時に適用されます）",
        "復元の準備ができました",
      );
      if (restartNow) {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
        return;
      }
      onMessage(
        `復元の準備ができました（${detail.split("\n")[0]}）。\n` +
          "アプリを終了して起動し直すと反映されます。",
      );
    } catch (e) {
      console.error(e);
      // ステージングの段階で失敗しているので、今のデータは変更されていない
      onMessage(`復元できませんでした: ${errText(e)}\n今のデータは変更されていません。`);
    } finally {
      setBusy(false);
    }
  };

  const handleCancelRestore = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("restore_cancel");
      setPending(null);
      onMessage("復元の予約を取り消しました。今のデータのまま使い続けられます。");
    } catch (e) {
      onMessage(`取り消しに失敗しました: ${errText(e)}`);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">バックアップ・復元</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          仕訳などのデータ (<code>kaikei.db</code>) と領収書の画像をまとめて 1 つの ZIP に保存します。
          定期的にバックアップを取り、別のMacへ移行することもできます。
        </p>
        {pending && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 space-y-2">
            <p>
              復元が予約されています（仕訳 {pending.journals}件 / 領収書 {pending.receipts}件）。
              アプリを再起動すると、今のデータがこのバックアップの内容に置き換わります。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  const { relaunch } = await import("@tauri-apps/plugin-process");
                  await relaunch();
                }}
              >
                今すぐ再起動して復元
              </Button>
              <Button size="sm" variant="outline" onClick={handleCancelRestore}>
                復元の予約を取り消す
              </Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={handleBackup} disabled={busy}>
            <HardDriveDownload className="h-4 w-4 mr-1" />
            バックアップ（ZIP）
          </Button>
          <Button onClick={handleRestore} disabled={busy} variant="outline">
            <HardDriveUpload className="h-4 w-4 mr-1" />
            復元
          </Button>
          <Button onClick={() => openFolder("data")} variant="outline">
            <FolderOpen className="h-4 w-4 mr-1" />
            データフォルダを開く
          </Button>
          <Button onClick={() => openFolder("receipts")} variant="outline">
            <FolderOpen className="h-4 w-4 mr-1" />
            領収書画像フォルダを開く
          </Button>
          <Button onClick={handleCleanup} variant="outline" disabled={busy}>
            <Trash2 className="h-4 w-4 mr-1" />
            孤児ファイル整理
          </Button>
          <Button
            onClick={handleMigratePdf}
            variant="outline"
            disabled={busy}
            title="PDF のまま登録済みの領収書に表示用の画像を作る (サムネ・AI OCR が有効に。原本 PDF は残します)"
          >
            <FileImage className="h-4 w-4 mr-1" />
            PDF領収書を画像化
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          別のMacへ移行する時は、この ZIP を移行先に持っていき、移行先の KAIKEI LOCAL で「復元」を選びます。
          ZIP は解凍せず、そのまま選んでください。
        </p>
      </CardContent>
    </Card>
  );
}
