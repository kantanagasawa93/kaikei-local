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
 * latest.json が「まだ未公開」を意味する error メッセージかどうか判定。
 *
 * Round 22 ㊚: tauri-plugin-updater は latest.json が 404 / 内容不正の時に
 * `Could not fetch a valid release JSON from the remote` を error として投げる。
 * これを「ちゃんとアプリ側でハンドルした up_to_date」扱いにすることで、
 * リリース直前 (まだ latest.json 未配置) の期間に「auto-update 失敗」バナーが
 * 出続ける現象を回避する。
 *
 * 真の通信エラー (network down / DNS / cert) は素直に error を残す方が望ましい。
 */
function isReleaseNotPublished(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("could not fetch a valid release json") ||
    m.includes("status code 404") ||
    m.includes("404 not found") ||
    m.includes("releaseendpoint") || // tauri 2.x の "ReleaseEndpoint" 系メッセージ
    m.includes("update endpoint did not respond")
  );
}

/**
 * Round 26 ⓖ: transient (network/timeout 系) の判定.
 * これに該当する error なら静かに 1 回 retry する。
 * cert 不正 / 構文エラー (latest.json 不正な JSON) などは即諦める。
 */
function isTransientUpdaterError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("network") ||
    m.includes("connection") ||
    m.includes("dns") ||
    m.includes("getaddrinfo") ||
    m.includes("econnrefused") ||
    m.includes("enotfound") ||
    m.includes("503") ||
    m.includes("502") ||
    m.includes("500") ||
    m.includes("temporarily")
  );
}

/**
 * 内部用 — 1 回だけ check() を呼ぶ。retry の有無は呼び出し側で制御。
 */
async function checkOnce(): Promise<AutoUpdaterStatus> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) {
    const { getVersion } = await import("@tauri-apps/api/app");
    const v = await getVersion();
    return { kind: "up_to_date", currentVersion: v };
  }
  return {
    kind: "available",
    version: update.version,
    currentVersion: update.currentVersion,
    body: update.body,
    date: update.date,
  };
}

/**
 * latest.json を check し、新しい version があれば available にする。
 * 既に最新なら up_to_date、Tauri 環境外なら idle のまま。
 *
 * Round 26 ⓖ: transient エラーは 10 秒後に 1 回静かに retry する.
 */
export async function checkAutoUpdate(): Promise<AutoUpdaterStatus> {
  if (!isTauri()) {
    setStatus({ kind: "idle" });
    return _status;
  }
  setStatus({ kind: "checking" });

  const handleError = async (e: unknown): Promise<AutoUpdaterStatus> => {
    const msg = (e as Error).message ?? String(e);
    if (isReleaseNotPublished(msg)) {
      console.info(
        `[auto-updater] latest.json は未公開扱い (${msg.slice(0, 80)}) — up_to_date として静かに継続`,
      );
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const v = await getVersion();
        return { kind: "up_to_date", currentVersion: v };
      } catch {
        return { kind: "up_to_date", currentVersion: "unknown" };
      }
    }
    return { kind: "error", message: msg };
  };

  try {
    const next = await checkOnce();
    setStatus(next);
    return _status;
  } catch (e1) {
    const msg1 = (e1 as Error).message ?? String(e1);
    // Round 26 ⓖ: transient なら 10 秒待って 1 回 retry
    if (isTransientUpdaterError(msg1) && !isReleaseNotPublished(msg1)) {
      console.info(
        `[auto-updater] transient error: ${msg1.slice(0, 80)} — 10 秒後に 1 回 retry`,
      );
      await new Promise((r) => setTimeout(r, 10_000));
      try {
        const next = await checkOnce();
        setStatus(next);
        return _status;
      } catch (e2) {
        setStatus(await handleError(e2));
        return _status;
      }
    }
    setStatus(await handleError(e1));
    return _status;
  }
}

// テスト用 export
export const __test__ = { isReleaseNotPublished };

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
