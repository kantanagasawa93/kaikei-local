/**
 * confirm.ts — 確認ダイアログ (Round 33)
 *
 * Tauri 環境の window.confirm は tauri-plugin-dialog の init-iife.js に
 * async 関数へ上書きされる (しかもクレート側に confirm コマンドが無く常に
 * reject する) ため、同期前提の `if (!confirm(...))` は確認をすり抜ける。
 *
 * 全画面この confirmDialog() (await 必須) を使うこと。実体は Rust の
 * confirm_dialog コマンドがネイティブの OK/キャンセル ダイアログを出す。
 * ブラウザ開発時 (Tauri 外) は素の window.confirm にフォールバックする。
 */

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

export async function confirmDialog(message: string, title?: string): Promise<boolean> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<boolean>("confirm_dialog", { message, title: title ?? null });
    } catch (e) {
      // Tauri 内の window.confirm は上書き済みの壊れた async 版なので、ここで
      // フォールバックしてはいけない。確認が取れない時は安全側 (実行しない)。
      console.error("[confirmDialog] confirm_dialog の呼び出しに失敗:", e);
      return false;
    }
  }
  // Tauri 外 (ブラウザ dev / vitest)。ここでの window.confirm は未上書きの
  // 同期ネイティブ実装なのでそのまま使える。それも無ければ安全側 (false)。
  if (typeof window !== "undefined" && typeof window.confirm === "function") {
    return window.confirm(message);
  }
  return false;
}
