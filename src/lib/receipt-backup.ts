/**
 * 領収書画像のトリミング前バックアップを管理する。
 *
 * 挙動:
 *   - 初回トリミング時に現画像を `<relPath>.orig.<ext>` にコピー
 *   - 以降のトリミングでは既に .orig が存在するので上書きしない（= 常に「最初の元画像」が残る）
 *   - 「元に戻す」で .orig を本体にコピーバック
 *
 * 最初の元画像だけを持つので、何度トリミングしてもいつでも "完全な元" に戻せる。
 */

export function origPathFor(relPath: string): string {
  // receipts/abc.jpg → receipts/abc.orig.jpg
  const lastSlash = relPath.lastIndexOf("/");
  const lastDot = relPath.lastIndexOf(".");
  if (lastDot <= lastSlash) {
    return `${relPath}.orig`;
  }
  const base = relPath.slice(0, lastDot);
  const ext = relPath.slice(lastDot);
  return `${base}.orig${ext}`;
}

export async function backupIfNotExists(relPath: string): Promise<boolean> {
  const { readFile, writeFile, exists, BaseDirectory } = await import(
    "@tauri-apps/plugin-fs"
  );
  const orig = origPathFor(relPath);
  try {
    const already = await exists(orig, { baseDir: BaseDirectory.AppData });
    if (already) return false;
  } catch {
    // exists が失敗したら作ろうとする
  }
  try {
    const bytes = await readFile(relPath, { baseDir: BaseDirectory.AppData });
    await writeFile(orig, bytes, { baseDir: BaseDirectory.AppData });
    return true;
  } catch (e) {
    console.warn("backup failed:", e);
    return false;
  }
}

export async function hasBackup(relPath: string): Promise<boolean> {
  const { exists, BaseDirectory } = await import("@tauri-apps/plugin-fs");
  try {
    return await exists(origPathFor(relPath), { baseDir: BaseDirectory.AppData });
  } catch {
    return false;
  }
}

/**
 * バックアップから本体を復元。復元後、バックアップファイルは削除する。
 * （将来また「手動で元に戻す」を何度もやりたいケースに備え、現状は残す方針にする選択もあり）
 * デフォルトでは削除する（2度目の復元は意味がないため）。
 */
export async function restoreFromBackup(
  relPath: string,
  opts: { keepBackup?: boolean } = {}
): Promise<{ restored: boolean; hashHex: string | null }> {
  const { readFile, writeFile, remove, exists, BaseDirectory } = await import(
    "@tauri-apps/plugin-fs"
  );
  const orig = origPathFor(relPath);
  try {
    const has = await exists(orig, { baseDir: BaseDirectory.AppData });
    if (!has) return { restored: false, hashHex: null };
  } catch {
    return { restored: false, hashHex: null };
  }

  const bytes = await readFile(orig, { baseDir: BaseDirectory.AppData });
  await writeFile(relPath, bytes, { baseDir: BaseDirectory.AppData });

  // file_hash 再計算
  const hashBuf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (!opts.keepBackup) {
    try {
      await remove(orig, { baseDir: BaseDirectory.AppData });
    } catch {}
  }
  return { restored: true, hashHex };
}
