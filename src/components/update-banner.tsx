"use client";

/**
 * Round 19 ㊏: アップデート通知バナー (永続表示).
 * Round 21 ㊘: tauri-plugin-updater 統合 — DL ページに飛ぶ代わりにアプリ内で
 *              ダウンロード→自己交換→再起動できるボタンを優先表示する。
 *
 * 動作:
 *   - Tauri 環境では起動後 checkAutoUpdate() を呼んで latest.json を取りに行く
 *   - kind === "available" なら「今すぐ更新」ボタン (= downloadAndInstall)
 *   - kind === "downloading" なら進捗バー
 *   - kind === "ready" なら「再起動」ボタン
 *   - エラー時は GitHub Releases へのフォールバックリンクを出す (= 旧動線)
 *   - Web (Tauri 環境外) では従来の getUpdateState() で「ダウンロードページへ」のみ
 *   - ✕ で dismissed_version を localStorage に保存し再表示抑制
 */

import { useEffect, useState } from "react";
import { Download, Loader2, RefreshCw, X } from "lucide-react";
import { getUpdateState, type UpdateState } from "@/lib/update-check";
import {
  checkAutoUpdate,
  downloadAndInstallUpdate,
  subscribeAutoUpdater,
  type AutoUpdaterStatus,
} from "@/lib/auto-updater";

const STORAGE_DISMISSED = "kaikei_update_banner_dismissed";
// Round 28 ⓕ: アプリ内アップデータが失敗した時の最終フォールバックは
// LP の install.html ではなく GitHub Releases の最新版ページに固定する。
// LP は静的サイト側のデプロイ遅延・リンク切れの影響を受けるが、Releases は
// release.sh が DMG を直接添付するため常に最新が取れる。
const FALLBACK_URL =
  "https://github.com/kantanagasawa93/kaikei-local/releases/latest";

function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__,
  );
}

export function UpdateBanner() {
  const [legacyState, setLegacyState] = useState<UpdateState>({
    status: "unchecked",
  });
  const [autoState, setAutoState] = useState<AutoUpdaterStatus>({ kind: "idle" });
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    // Tauri 環境では plugin-updater で latest.json を引きに行く
    const unsub = subscribeAutoUpdater(setAutoState);
    if (isTauri()) {
      // 起動 4 秒後に checkAutoUpdate (LP fetch を 16 秒待つ Web 動線より早い)
      const t = setTimeout(() => {
        void checkAutoUpdate();
      }, 4_000);
      return () => {
        clearTimeout(t);
        unsub();
      };
    }
    // Web fallback: 旧動線 (update-check.ts の結果を 16 秒後に取りに行く)
    const t = setTimeout(() => {
      setLegacyState(getUpdateState());
    }, 16_000);
    return () => {
      clearTimeout(t);
      unsub();
    };
  }, []);

  // dismissed 確認 — render 中に判定する (setState in effect は不要)
  const isDismissed = (() => {
    if (typeof window === "undefined") return false;
    const dismissed = window.localStorage.getItem(STORAGE_DISMISSED);
    if (autoState.kind === "available") return dismissed === autoState.version;
    if (legacyState.status === "available") return dismissed === legacyState.latest;
    return false;
  })();

  if (hidden || isDismissed) return null;

  // Tauri 動線
  if (isTauri()) {
    if (autoState.kind === "available") {
      const onUpdate = () => void downloadAndInstallUpdate();
      const onDismiss = () => {
        window.localStorage.setItem(STORAGE_DISMISSED, autoState.version);
        setHidden(true);
      };
      return (
        <div
          role="status"
          className="fixed top-0 left-0 right-0 z-[80]
                     bg-blue-600 text-white text-sm shadow-lg
                     flex items-center gap-3 px-4 py-2"
        >
          <Download className="h-4 w-4 flex-shrink-0" />
          <span className="flex-1">
            新しいバージョン <b>v{autoState.version}</b> が公開されました
            (現在 v{autoState.currentVersion})。
          </span>
          <button
            type="button"
            onClick={onUpdate}
            className="bg-white/20 hover:bg-white/30 rounded px-3 py-1 text-xs font-medium"
          >
            今すぐ更新
          </button>
          <a
            href={FALLBACK_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs underline hover:no-underline"
          >
            手動 DL
          </a>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onDismiss}
            className="hover:bg-white/20 rounded p-1"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      );
    }
    if (autoState.kind === "downloading") {
      const pct =
        autoState.total && autoState.total > 0
          ? Math.min(100, Math.round((autoState.bytes / autoState.total) * 100))
          : null;
      return (
        <div
          role="status"
          className="fixed top-0 left-0 right-0 z-[80]
                     bg-blue-700 text-white text-sm shadow-lg
                     flex items-center gap-3 px-4 py-2"
        >
          <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" />
          <span className="flex-1">
            ダウンロード中… {pct !== null ? `${pct}%` : `${Math.round(autoState.bytes / 1024 / 1024)} MB`}
          </span>
        </div>
      );
    }
    if (autoState.kind === "ready") {
      return (
        <div
          role="status"
          className="fixed top-0 left-0 right-0 z-[80]
                     bg-green-600 text-white text-sm shadow-lg
                     flex items-center gap-3 px-4 py-2"
        >
          <RefreshCw className="h-4 w-4 flex-shrink-0" />
          <span className="flex-1">
            更新の準備が整いました。アプリを再起動します…
          </span>
        </div>
      );
    }
    if (autoState.kind === "error") {
      // Round 22 ㊚: ネットワーク系の真エラーだけ表示する。
      // latest.json 未公開 (= release 直前 / 鍵入れ替え期間) は auto-updater 側で
      // up_to_date 化済みなので、ここに来る error はだいたい本物の通信問題。
      // それでも UI は控えめ (amber) に出して、手動 DL で逃げ道を残す。
      const errMsg = autoState.message ?? "";
      // 念のため二重ガード: ここでも 404 系は無視
      if (
        /404|could not fetch a valid release json|releaseendpoint|update endpoint did not respond/i.test(
          errMsg,
        )
      ) {
        return null;
      }
      return (
        <div
          role="status"
          className="fixed top-0 left-0 right-0 z-[80]
                     bg-amber-500 text-white text-sm shadow-lg
                     flex items-center gap-3 px-4 py-2"
        >
          <Download className="h-4 w-4 flex-shrink-0" />
          <span className="flex-1">
            自動更新に失敗 ({errMsg.slice(0, 80)}) — 手動 DL ページから取得してください
          </span>
          <a
            href={FALLBACK_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-white/20 hover:bg-white/30 rounded px-3 py-1 text-xs font-medium"
          >
            ダウンロード
          </a>
          <button
            type="button"
            aria-label="閉じる"
            onClick={() => setHidden(true)}
            className="hover:bg-white/20 rounded p-1"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      );
    }
    // idle / checking / up_to_date は表示しない
    return null;
  }

  // Web fallback (LP 等)
  if (legacyState.status !== "available") return null;
  const { current, latest, url } = legacyState;
  const onDismiss = () => {
    window.localStorage.setItem(STORAGE_DISMISSED, latest);
    setHidden(true);
  };
  return (
    <div
      role="status"
      className="fixed top-0 left-0 right-0 z-[80]
                 bg-blue-600 text-white text-sm shadow-lg
                 flex items-center gap-3 px-4 py-2"
    >
      <Download className="h-4 w-4 flex-shrink-0" />
      <span className="flex-1">
        新しいバージョン <b>v{latest}</b> が公開されました (現在 v{current})。
      </span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="bg-white/20 hover:bg-white/30 rounded px-3 py-1 text-xs font-medium"
      >
        ダウンロード
      </a>
      <button
        type="button"
        aria-label="閉じる"
        onClick={onDismiss}
        className="hover:bg-white/20 rounded p-1"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
