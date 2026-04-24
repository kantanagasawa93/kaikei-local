/**
 * 起動時の自動バックアップ (ローリング 7 日分)。
 *
 * アプリ起動時に ~/Library/Application Support/dev.kaikei.app/snapshots/
 * に kaikei-YYYY-MM-DD.db を作成。既存ファイルがあれば skip (日 1 回)。
 * 7 日より古いスナップショットは自動削除。
 *
 * メインの kaikei.db と同じ場所なので容量は倍必要になるが、
 * 誤操作で DB を壊した時の保険。ユーザーは設定画面から直近の snapshot を
 * kaikei.db にリネーム/コピーすれば復元できる。
 */

const SNAP_DIR = "snapshots";
const KEEP_DAYS = 7;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export async function runAutoBackup(): Promise<void> {
  try {
    const { mkdir, readFile, writeFile, readDir, remove, BaseDirectory } =
      await import("@tauri-apps/plugin-fs");

    // 現 DB 読込 (無ければ何もしない = 初回起動)
    let dbBytes: Uint8Array;
    try {
      dbBytes = await readFile("kaikei.db", { baseDir: BaseDirectory.AppData });
    } catch {
      return;
    }
    if (!dbBytes || dbBytes.length === 0) return;

    // snapshots/ 作成
    try {
      await mkdir(SNAP_DIR, {
        baseDir: BaseDirectory.AppData,
        recursive: true,
      });
    } catch {}

    const today = todayStr();
    const snapName = `${SNAP_DIR}/kaikei-${today}.db`;

    // 既存 (同日) があれば skip
    let existing: { name: string; isFile: boolean }[] = [];
    try {
      existing = (await readDir(SNAP_DIR, {
        baseDir: BaseDirectory.AppData,
      })) as { name: string; isFile: boolean }[];
    } catch {}

    const alreadyToday = existing.some((e) => e.isFile && e.name === `kaikei-${today}.db`);
    if (!alreadyToday) {
      await writeFile(snapName, dbBytes, { baseDir: BaseDirectory.AppData });
    }

    // 7 日より古いスナップショットを削除
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
    for (const entry of existing) {
      if (!entry.isFile) continue;
      const m = entry.name.match(/^kaikei-(\d{4})-(\d{2})-(\d{2})\.db$/);
      if (!m) continue;
      const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
      if (d < cutoff) {
        try {
          await remove(`${SNAP_DIR}/${entry.name}`, {
            baseDir: BaseDirectory.AppData,
          });
        } catch {}
      }
    }
  } catch (e) {
    // 自動バックアップ失敗は致命ではないので静かに無視
    console.warn("[auto-backup] failed:", e);
  }
}
