/**
 * Round 21 ㊘: tauri-plugin-updater への薄いラッパ。
 *
 * Round 18-20 までの update-check.ts は GitHub Releases API を fetch して
 * 「新しいバージョンがあります → ダウンロードページへどうぞ」と案内するだけ
 * だった (= ユーザは自分で DMG を落として手動で差し替える必要があった)。
 *
 * このモジュールは tauri-plugin-updater 経由で:
 *   1. latest.json を fetch (config の endpoints から)
 *   2. minisign 署名検証 (pubkey は tauri.conf.json に embed 済み)
 *   3. ダウンロード → 自己交換 → 再起動 を一気通貫で実行
 *
 * Web (= Tauri 環境外) では何もしない (window.__TAURI_INTERNALS__ 検出)。
 */
export type AutoUpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | {
      kind: "available";
      version: string;
      currentVersion: string;
      body?: string;
      date?: string;
    }
  | { kind: "up_to_date"; currentVersion: string }
  | { kind: "downloading"; bytes: number; total?: number }
  | { kind: "ready" } // ダウンロード完了 → 再起動待ち
  | { kind: "error"; message: string };

let _status: AutoUpdaterStatus = { kind: "idle" };
const _listeners = new Set<(s: AutoUpdaterStatus) => void>();

function setStatus(s: AutoUpdaterStatus) {
  _status = s;
  for (const fn of _listeners) {
    try {
      fn(s);
    } catch {
      // ignore
    }
  }
}

export function getAutoUpdaterStatus(): AutoUpdaterStatus {
  return _status;
}

export function subscribeAutoUpdater(
  fn: (s: AutoUpdaterStatus) => void,
): () => void {
  _listeners.add(fn);
  fn(_status);
  return () => {
    _listeners.delete(fn);
  };
}

function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__,
  );
}

/**
 * latest.json を check し、新しい version があれば available にする。
 * 既に最新なら up_to_date、Tauri 環境外なら idle のまま。
 */
export async function checkAutoUpdate(): Promise<AutoUpdaterStatus> {
  if (!isTauri()) {
    setStatus({ kind: "idle" });
    return _status;
  }
  setStatus({ kind: "checking" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      // tauri-plugin-updater の最新仕様: null = 最新
      const { getVersion } = await import("@tauri-apps/api/app");
      const v = await getVersion();
      setStatus({ kind: "up_to_date", currentVersion: v });
      return _status;
    }
    setStatus({
      kind: "available",
      version: update.version,
      currentVersion: update.currentVersion,
      body: update.body,
      date: update.date,
    });
    return _status;
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    setStatus({ kind: "error", message: msg });
    return _status;
  }
}

/**
 * 確認済みの update を download → install → relaunch する。
 * UI はバナーから「今すぐ更新」ボタンで呼ぶ想定。
 */
export async function downloadAndInstallUpdate(): Promise<AutoUpdaterStatus> {
  if (!isTauri()) {
    setStatus({
      kind: "error",
      message: "デスクトップアプリ以外では auto-update は使えません",
    });
    return _status;
  }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      setStatus({
        kind: "error",
        message: "アップデートが見つかりません (既に最新かもしれません)",
      });
      return _status;
    }
    let total: number | undefined;
    let downloaded = 0;
    setStatus({ kind: "downloading", bytes: 0, total: undefined });

    await update.downloadAndInstall((event) => {
      // event.event: 'Started' | 'Progress' | 'Finished'
      if (event.event === "Started") {
        total = event.data.contentLength;
        setStatus({ kind: "downloading", bytes: 0, total });
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        setStatus({ kind: "downloading", bytes: downloaded, total });
      } else if (event.event === "Finished") {
        setStatus({ kind: "ready" });
      }
    });

    // インストール完了後、自動的に再起動 (process plugin)
    const { relaunch } = await import("@tauri-apps/plugin-process");
    setStatus({ kind: "ready" });
    await relaunch();
    return _status;
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    setStatus({ kind: "error", message: msg });
    return _status;
  }
}
