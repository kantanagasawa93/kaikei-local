"use client";

/**
 * Round 6 ㊎: CLI (`kaikei --navigate=/inbox`) が書く control file を 1 秒
 * 間隔で polling し、ターゲットルートが見つかったら router.push する。
 *
 * 経緯:
 *   - Claude (verify-app.sh) が起動中の KAIKEI LOCAL.app の特定ページに
 *     遷移してスクショを取りたいケースが多い (受信箱・設定 AI OCR ログ等)
 *   - osascript の `keystroke` は macOS の TCC で常に弾かれる
 *   - Tauri 起動済みプロセスに別プロセスから直接 IPC は出来ない
 *   → 一番確実な手段: control file を CLI が書き、Frontend が poll する
 *
 * 安全性: target file は app_data_dir 内 (`.navigate-target`) で、Frontend は
 * 値を `/^\/[a-zA-Z0-9_\-/]+$/` でマッチ確認してから router.push する。
 * 任意 URL は受け付けない (XSS / Tauri command 経由の侵入を阻止)。
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_MS = 1000;
const SAFE_ROUTE_RE = /^\/[a-zA-Z0-9_\-/]*$/;

export function NavigateBridge() {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const target = ((await invoke("navigate_target_get")) as string) || "";
        if (target && SAFE_ROUTE_RE.test(target)) {
          // router.push の前に file をクリア (二重発火を避ける)
          await invoke("navigate_target_clear");
          if (!cancelled) {
            router.push(target);
          }
        } else if (target) {
          // 形式が変なターゲットは黙って削除
          await invoke("navigate_target_clear");
        }
      } catch {
        /* Tauri 外で動いている時 (ブラウザ実行) は何もしない */
      }
      if (!cancelled) {
        timer = setTimeout(poll, POLL_MS);
      }
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [router]);

  return null;
}
