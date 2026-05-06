"use client";

/**
 * Round 19 ㊏: アップデート通知バナー (永続表示).
 *
 * Round 18 ㊋ で update-check.ts は toast 通知だった。toast は数秒で消えるので
 * 見逃しやすい → 画面上部に「v0.4.0 が公開されています」を永続表示するバナーへ。
 *
 * 動作:
 *   - 起動 12 秒後 (NavigateBridge の checkForUpdate 完了後) に getUpdateState を読む
 *   - status === "available" ならバナー表示
 *   - 「ダウンロードページを開く」「✕ 閉じる」の 2 ボタン
 *   - ✕ 閉じた場合は localStorage に dismissed_version=<latest> を保存
 *     次の更なる新バージョンが出るまで再表示しない
 */

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { getUpdateState, type UpdateState } from "@/lib/update-check";

const STORAGE_DISMISSED = "kaikei_update_banner_dismissed";

export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: "unchecked" });
  const [hidden, setHidden] = useState(false);

  // checkForUpdate が完了するのを待ってから state を取得 (NavigateBridge が
  // 10 秒後に発火、5 秒タイムアウトなので 16 秒後にチェック)
  useEffect(() => {
    const t = setTimeout(() => {
      const s = getUpdateState();
      setState(s);
      // dismissed_version と一致するなら隠す
      if (s.status === "available") {
        const dismissed =
          typeof window !== "undefined"
            ? window.localStorage.getItem(STORAGE_DISMISSED)
            : null;
        if (dismissed === s.latest) {
          setHidden(true);
        }
      }
    }, 16_000);
    return () => clearTimeout(t);
  }, []);

  if (hidden || state.status !== "available") return null;

  const { current, latest, url } = state;
  const onDismiss = () => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_DISMISSED, latest);
    }
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
