"use client";

/**
 * JS側で起きたエラー・console.error/warn を全部 Rust 側に転送する。
 * - tauri-plugin-log のログファイルに記録される
 * - `~/Library/Logs/dev.kaikei.app/kaikei.log` 相当の場所から tail 可能
 *
 * これにより、外側から tail で JS 実行時エラーを継続監視できる。
 */

let installed = false;

export async function installErrorReporter() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  try {
    const { error: logError, warn: logWarn, info: logInfo } = await import(
      "@tauri-apps/plugin-log"
    );

    // 1. window.onerror で未捕捉エラー
    window.addEventListener("error", (event) => {
      const msg = `[window.error] ${event.message} at ${event.filename}:${event.lineno}:${event.colno}\n${event.error?.stack ?? ""}`;
      logError(msg).catch(() => {});
    });

    // 2. unhandledrejection で未捕捉 promise reject
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      const msg = `[unhandledrejection] ${
        reason instanceof Error
          ? `${reason.message}\n${reason.stack}`
          : JSON.stringify(reason)
      }`;
      logError(msg).catch(() => {});
    });

    // 3. console.error / console.warn をフック
    const origErr = console.error;
    const origWarn = console.warn;
    const origInfo = console.info;

    console.error = (...args: unknown[]) => {
      origErr.apply(console, args);
      logError(formatArgs("ERR", args)).catch(() => {});
    };
    console.warn = (...args: unknown[]) => {
      origWarn.apply(console, args);
      logWarn(formatArgs("WARN", args)).catch(() => {});
    };
    console.info = (...args: unknown[]) => {
      origInfo.apply(console, args);
      logInfo(formatArgs("INFO", args)).catch(() => {});
    };

    // 4. 初期化マーカー
    logInfo(`[kaikei] error reporter installed at ${new Date().toISOString()}`).catch(() => {});

    // 5. URL/パス遷移の追跡
    const pushState = history.pushState;
    history.pushState = function (...args) {
      const ret = pushState.apply(this, args);
      logInfo(`[nav] pushState ${window.location.pathname}${window.location.search}`).catch(() => {});
      return ret;
    };
    window.addEventListener("popstate", () => {
      logInfo(`[nav] popstate ${window.location.pathname}${window.location.search}`).catch(() => {});
    });
  } catch (e) {
    // プラグインが使えない環境（ビルドプレビュー等）では何もしない
    console.log("error reporter init skipped:", e);
  }
}

function formatArgs(prefix: string, args: unknown[]): string {
  const parts = args.map((a) => {
    if (a instanceof Error) return `${a.message}\n${a.stack}`;
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  });
  return `[${prefix}] ${parts.join(" ")}`;
}
