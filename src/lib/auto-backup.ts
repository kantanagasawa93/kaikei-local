/**
 * 起動時の自動バックアップ (ローリング 7 世代)。
 *
 * アプリ起動時に ~/Library/Application Support/dev.kaikei.app/snapshots/
 * に kaikei-YYYY-MM-DD.db を作成。同じ日付のものが既にあれば skip (日 1 回)。
 *
 * - スナップショットは Rust 側の db_snapshot (VACUUM INTO) で作る。
 *   kaikei.db は WAL モードなので、ファイルを直接コピーすると前回の異常終了などで
 *   WAL に残っているコミットが欠ける。
 * - 残すのは「新しい方から 7 個」。以前は「7 日より古いものを削除」だったため、
 *   しばらくアプリを開かないと、次の起動で過去分が全部消えて当日分だけになっていた
 *   (= 保険として一番欲しい「数日前の状態」が残らない)。
 *
 * 画像は含まない DB だけの保険。丸ごとのバックアップは設定画面の「バックアップ（ZIP）」。
 */

const SNAP_DIR = "snapshots";
const KEEP_COUNT = 7;
const SNAP_RE = /^kaikei-(\d{4})-(\d{2})-(\d{2})\.db$/;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/** 残すスナップショットを選ぶ (日付の新しい順に keep 個)。純関数にしてテストする。 */
export function selectSnapshotsToRemove(names: string[], keep: number = KEEP_COUNT): string[] {
  const snaps = names.filter((n) => SNAP_RE.test(n)).sort(); // YYYY-MM-DD なので辞書順 = 日付順
  return snaps.slice(0, Math.max(0, snaps.length - keep));
}

export async function runAutoBackup(): Promise<void> {
  try {
    const { exists, readDir, remove, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    const { invoke } = await import("@tauri-apps/api/core");

    // DB が無ければ何もしない (= 初回起動)
    if (!(await exists("kaikei.db", { baseDir: BaseDirectory.AppData }))) return;

    let existing: { name: string; isFile: boolean }[] = [];
    try {
      existing = (await readDir(SNAP_DIR, {
        baseDir: BaseDirectory.AppData,
      })) as { name: string; isFile: boolean }[];
    } catch {
      /* snapshots/ がまだ無い — db_snapshot 側で作られる */
    }

    const todayName = `kaikei-${todayStr()}.db`;
    const names = existing.filter((e) => e.isFile).map((e) => e.name);
    if (!names.includes(todayName)) {
      await invoke<number>("db_snapshot", { name: todayName });
      names.push(todayName);
    }

    for (const name of selectSnapshotsToRemove(names)) {
      try {
        await remove(`${SNAP_DIR}/${name}`, { baseDir: BaseDirectory.AppData });
      } catch {
        /* 消せなくても次回また試す */
      }
    }
  } catch (e) {
    // 自動バックアップ失敗は致命ではないので静かに無視
    console.warn("[auto-backup] failed:", e);
  }
}
