import { db } from "@/lib/localDb";

/**
 * 領収書の削除。DB 行の削除と併せて、ローカルに保存している画像ファイルも削除する。
 * image_url が local:// 形式の場合のみファイル削除を試みる。
 */
export async function deleteReceipt(id: string): Promise<void> {
  // 画像パスを取得
  const { data } = await db
    .from("receipts")
    .select("image_url")
    .eq("id", id)
    .single();

  const imageUrl = (data as { image_url?: string } | null)?.image_url || null;

  // DB 行削除
  await db.from("receipts").delete().eq("id", id);

  // 画像ファイル削除（local:// のみ）
  if (imageUrl && imageUrl.startsWith("local://")) {
    const relative = imageUrl.replace(/^local:\/\//, "");
    try {
      const { remove, BaseDirectory } = await import("@tauri-apps/plugin-fs");
      await remove(relative, { baseDir: BaseDirectory.AppData });
    } catch (e) {
      // ファイルが既に無い等は無視
      console.warn("receipt file remove failed:", e);
    }
  }
}

/**
 * receipts/ フォルダを Finder で開く。
 * AppData 配下の receipts/ が未作成なら先に作ってから shell.open で開く。
 */
export async function openReceiptsFolder(): Promise<void> {
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  const { mkdir, BaseDirectory } = await import("@tauri-apps/plugin-fs");
  try {
    await mkdir("receipts", { baseDir: BaseDirectory.AppData, recursive: true });
  } catch {
    // 既にあれば無視
  }
  const full = await join(await appDataDir(), "receipts");
  const { open } = await import("@tauri-apps/plugin-shell");
  await open(full);
}

/**
 * raw PDF のまま登録済みの領収書を JPEG 化する移行 (Round 33)。
 *
 * PDF→JPEG 変換 (Round 31, d932ec5) より前に取り込まれた領収書は .pdf の
 * まま保存されており、サムネも OCR も効かない。しかも file_hash の重複判定で
 * 同じ PDF の再ドロップも弾かれるため、自動では直らない。
 * この関数が既存の .pdf 領収書を 1 ページ目 JPEG に変換してファイルを差し替える。
 * file_hash は元 PDF のまま維持する (同じ PDF の再ドロップは引き続き重複扱い)。
 *
 * 変換に失敗した行はそのまま残す (元 PDF は消さない)。
 */
export async function migrateRawPdfReceipts(): Promise<{
  converted: number;
  failed: number;
  total: number;
}> {
  const { readFile, writeFile, remove, BaseDirectory } = await import(
    "@tauri-apps/plugin-fs"
  );

  const { data } = await db.from("receipts").select("id, image_url, doc_type");
  const targets = (
    (data as { id: string; image_url?: string; doc_type?: string }[] | null) || []
  ).filter(
    (r) =>
      r.image_url?.startsWith("local://") &&
      r.image_url.toLowerCase().endsWith(".pdf"),
  );

  let converted = 0;
  let failed = 0;
  for (const row of targets) {
    const rel = row.image_url!.replace(/^local:\/\//, "");
    try {
      const original = await readFile(rel, { baseDir: BaseDirectory.AppData });
      const { renderPdfFirstPageToJpeg } = await import("@/lib/pdf-to-image");
      const jpeg = await renderPdfFirstPageToJpeg(original);

      const safeName = `${Date.now()}-${crypto.randomUUID()}.jpg`;
      const newRel = `receipts/${safeName}`;
      await writeFile(newRel, jpeg, { baseDir: BaseDirectory.AppData });

      // DB を新ファイルへ向けてから旧 PDF を削除 (途中で落ちても参照切れにしない)。
      // doc_type は触らない (invoice=受領請求書 等の既存分類を壊さない)
      await db
        .from("receipts")
        .update({ image_url: `local://${newRel}` })
        .eq("id", row.id);
      try {
        await remove(rel, { baseDir: BaseDirectory.AppData });
      } catch (e) {
        console.warn(`旧 PDF の削除に失敗 (${rel}):`, e);
      }
      converted++;
    } catch (e) {
      console.error(`PDF 領収書の JPEG 化に失敗 (${rel}):`, e);
      failed++;
    }
  }
  return { converted, failed, total: targets.length };
}

/**
 * DB に紐付いていない孤児ファイルを receipts/ ディレクトリから検出して削除する。
 * ユーザが「ストレージを整理」ボタンを押した時に使う想定。
 */
export async function cleanupOrphanReceiptFiles(): Promise<{
  removed: number;
  kept: number;
}> {
  const { readDir, remove, BaseDirectory } = await import("@tauri-apps/plugin-fs");

  // DB にある image_url を全部取得
  const { data } = await db.from("receipts").select("image_url");
  const known = new Set<string>();
  for (const row of (data as { image_url?: string }[] | null) || []) {
    if (row.image_url?.startsWith("local://")) {
      known.add(row.image_url.replace(/^local:\/\//, ""));
    }
  }

  // receipts/ 以下のファイルを列挙
  let entries: { name: string; isFile: boolean }[] = [];
  try {
    entries = (await readDir("receipts", {
      baseDir: BaseDirectory.AppData,
    })) as { name: string; isFile: boolean }[];
  } catch {
    return { removed: 0, kept: 0 };
  }

  let removed = 0;
  let kept = 0;
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const rel = `receipts/${entry.name}`;
    if (known.has(rel)) {
      kept++;
    } else {
      try {
        await remove(rel, { baseDir: BaseDirectory.AppData });
        removed++;
      } catch (e) {
        console.warn(`failed to remove orphan ${rel}:`, e);
      }
    }
  }
  return { removed, kept };
}
