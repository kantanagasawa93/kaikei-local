"use client";

import { useEffect } from "react";
import { installErrorReporter } from "@/lib/error-reporter";
import { runAutoBackup } from "@/lib/auto-backup";
import { checkForUpdate } from "@/lib/update-check";

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
  }, []);
  return null;
}
