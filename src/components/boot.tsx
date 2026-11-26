"use client";

import { useEffect } from "react";
import { installErrorReporter } from "@/lib/error-reporter";
import { runAutoBackup } from "@/lib/auto-backup";
import { checkForUpdate } from "@/lib/update-check";
import { expireOldCandidates, purgeOldDismissed } from "@/lib/photo-scanner";
import { checkPartnerCleanup } from "@/lib/partner-cleanup";

/**
 * 起動時の1回限りのセットアップ。
 * layout.tsx からマウントされる。
 */
export function Boot() {
  useEffect(() => {
    installErrorReporter();
    // 設定画面で予約した「復元」は、この起動の最初 (DB を開く前) に Rust 側で適用済み。
    // 結果を 1 度だけ受け取って知らせる。
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const r = (await invoke("restore_take_result")) as {
          ok: boolean;
          error?: string | null;
          journals: number;
          receipts: number;
          file_count: number;
        } | null;
        if (!r) return;
        const { toast } = await import("@/lib/toast");
        if (r.ok) {
          toast.success(
            `バックアップを復元しました（仕訳 ${r.journals}件 / 領収書 ${r.receipts}件 / 画像 ${r.file_count}枚）`,
          );
        } else {
          toast.error(
            `復元できませんでした: ${r.error ?? "不明なエラー"}（データは復元前のままです）`,
          );
        }
      } catch {
        /* Tauri 外 (ブラウザ実行) では何もしない */
      }
    })();
    // 日次ローリングバックアップ (失敗しても静かに無視)
    runAutoBackup();
    // 新バージョンチェック (起動時 1 回、10 秒遅延でネットが落ち着いてから)
    setTimeout(() => {
      checkForUpdate();
    }, 10_000);
    // Round 23 ㊜: 30 日経過の未閲覧 candidate を静かに自動 dismissed へ
    // (1 日 1 回までに抑制、UI には何も出さない)
    setTimeout(() => {
      expireOldCandidates().catch((e) =>
        console.warn("expireOldCandidates failed:", e),
      );
    }, 8_000);
    // Round 25 ⓕ: 90 日経過の dismissed を物理削除 (jpg + DB 行)
    // (1 日 1 回まで、UI には何も出さない、ストレージ抑制目的)
    setTimeout(() => {
      purgeOldDismissed().catch((e) =>
        console.warn("purgeOldDismissed failed:", e),
      );
    }, 12_000);
    // Round 26 ㊣: 1 ヶ月に 1 回、auto-learned & 未使用 & 30 日経過の partner を集計
    // → 件数が >0 なら toast.info で通知 (削除自体は手動)
    setTimeout(() => {
      checkPartnerCleanup().catch((e) =>
        console.warn("checkPartnerCleanup failed:", e),
      );
    }, 15_000);
  }, []);
  return null;
}
