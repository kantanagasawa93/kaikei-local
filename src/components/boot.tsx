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
