import { db } from "@/lib/localDb";
import { origPathFor } from "@/lib/receipt-backup";
import { todayLocal } from "@/lib/date-utils";

/**
 * 領収書ファイル (AppData/receipts/) の取り扱いをまとめたモジュール。
 *
 * ファイル名の約束:
 *   - `<base>.<ext>`        … 領収書の画像 (receipts.image_url が指す)
 *   - `<base>.pdf`          … PDF で受け取った領収書の **原本**。プレビュー用の
 *                             `<base>.jpg` と同じ base で隣に置く。
 *                             電子取引データは受け取った形式のまま保存する必要が
 *                             あるので、画像化しても原本は消さない。
 *   - `<base>.orig.<ext>`   … トリミング前のバックアップ (receipt-backup.ts)
 *   - `phone-<秒>-<uuid>.*` … スマホから LAN 経由で受信したファイル (lan_server.rs)
 *
 * localDb は失敗しても throw せず `{ error }` を返す。ファイルを消す・成功を
 * 報告する前に必ず error を検査すること。
 */

const PHONE_PREFIX = "phone-";

export type ImportOutcome =
  /** 取り込んだ */
  | "added"
  /** PDF の画像化に失敗したので、原本 PDF のまま取り込んだ (サムネ・OCR は効かない) */
  | "added_pdf_unrendered"
  /** 同じファイルが登録済みだったので取り込まなかった */
  | "duplicate";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function isRegisteredHash(hashHex: string): Promise<boolean> {
  const { data, error } = await db.from("receipts").select("id").eq("file_hash", hashHex);
  if (error) throw error;
  return ((data as unknown[] | null) || []).length > 0;
}

/** `receipts/<base>.jpg` → `receipts/<base>.pdf` (原本 PDF の置き場)。 */
export function originalPdfPathFor(relPath: string): string {
  const lastSlash = relPath.lastIndexOf("/");
  const lastDot = relPath.lastIndexOf(".");
  const base = lastDot > lastSlash ? relPath.slice(0, lastDot) : relPath;
  return `${base}.pdf`;
}

function relOf(imageUrl: string | null | undefined): string | null {
  if (!imageUrl || !imageUrl.startsWith("local://")) return null;
  return imageUrl.replace(/^local:\/\//, "");
}

async function removeQuietly(rel: string): Promise<void> {
  try {
    const { remove, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    await remove(rel, { baseDir: BaseDirectory.AppData });
  } catch {
    /* 既に無い等は無視 */
  }
}

/**
 * 画像 / PDF のバイト列を領収書として取り込む (ドラッグ&ドロップ・ファイル選択用)。
 *
 * - 同じファイル (SHA-256 一致) が登録済みなら取り込まない
 * - PDF は全ページを 1 枚の JPEG にしてプレビューにし、原本 PDF も隣に保存する
 * - DB への登録に失敗したら、書き出したファイルは片付けてから例外を投げる
 */
export async function importReceiptBytes(
  original: Uint8Array,
  opts: { fileName: string; isPdf: boolean },
): Promise<ImportOutcome> {
  const { writeFile, mkdir, BaseDirectory } = await import("@tauri-apps/plugin-fs");

  // ハッシュは「元ファイル」で計算する (PDF を画像化しても同じ PDF を重複検知できる)
  const hashHex = await sha256Hex(original);
  if (await isRegisteredHash(hashHex)) return "duplicate";

  try {
    await mkdir("receipts", { baseDir: BaseDirectory.AppData, recursive: true });
  } catch {
    /* 既にあれば無視 */
  }

  const base = `receipts/${Date.now()}-${crypto.randomUUID()}`;
  const written: string[] = [];
  let imageRel: string;
  let docType = "receipt";
  let outcome: ImportOutcome = "added";

  if (opts.isPdf) {
    const pdfRel = `${base}.pdf`;
    await writeFile(pdfRel, original, { baseDir: BaseDirectory.AppData });
    written.push(pdfRel);
    try {
      const { renderPdfToJpeg } = await import("@/lib/pdf-to-image");
      const { jpeg } = await renderPdfToJpeg(original);
      const jpgRel = `${base}.jpg`;
      await writeFile(jpgRel, jpeg, { baseDir: BaseDirectory.AppData });
      written.push(jpgRel);
      imageRel = jpgRel;
    } catch (e) {
      // 画像化できなくても取り込み自体は成立させる (原本は保存済み)
      console.error("PDF の画像化に失敗:", e);
      imageRel = pdfRel;
      docType = "other";
      outcome = "added_pdf_unrendered";
    }
  } else {
    const ext = (opts.fileName.includes(".") ? opts.fileName.split(".").pop() : null) || "jpg";
    imageRel = `${base}.${ext.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg"}`;
    await writeFile(imageRel, original, { baseDir: BaseDirectory.AppData });
    written.push(imageRel);
  }

  const { error } = await db.from("receipts").insert({
    image_url: `local://${imageRel}`,
    vendor_name: null,
    amount: null,
    date: todayLocal(),
    status: "pending",
    doc_type: docType,
    file_hash: hashHex,
  });
  if (error) {
    // 行が無いのにファイルだけ残ると「成功」に見える孤児になるので片付ける
    for (const rel of written) await removeQuietly(rel);
    throw error;
  }
  return outcome;
}

/**
 * スマホから受信済みのファイル (`receipts/phone-…`) を領収書として登録する。
 * ファイルはその場所のまま使う (PDF の時だけプレビュー JPEG を隣に作る)。
 */
export async function registerPhoneUpload(relPath: string): Promise<ImportOutcome> {
  const { readFile, writeFile, BaseDirectory } = await import("@tauri-apps/plugin-fs");
  const original = await readFile(relPath, { baseDir: BaseDirectory.AppData });

  const hashHex = await sha256Hex(original);
  if (await isRegisteredHash(hashHex)) {
    // 同じ写真を 2 回送った等。未登録の一覧に残り続けないよう片付ける
    await removeQuietly(relPath);
    return "duplicate";
  }

  let imageRel = relPath;
  let docType = "receipt";
  let outcome: ImportOutcome = "added";
  let previewWritten: string | null = null;

  if (relPath.toLowerCase().endsWith(".pdf")) {
    try {
      const { renderPdfToJpeg } = await import("@/lib/pdf-to-image");
      const { jpeg } = await renderPdfToJpeg(original);
      const jpgRel = relPath.replace(/\.pdf$/i, ".jpg");
      await writeFile(jpgRel, jpeg, { baseDir: BaseDirectory.AppData });
      previewWritten = jpgRel;
      imageRel = jpgRel; // 原本 PDF は同じ base のまま隣に残る
    } catch (e) {
      console.error("PDF の画像化に失敗:", e);
      docType = "other";
      outcome = "added_pdf_unrendered";
    }
  }

  const { error } = await db.from("receipts").insert({
    image_url: `local://${imageRel}`,
    vendor_name: null,
    amount: null,
    date: todayLocal(),
    status: "pending",
    doc_type: docType,
    file_hash: hashHex,
  });
  if (error) {
    // 受信ファイル本体は残す (もう一度「登録」できるように)。作ったプレビューだけ消す
    if (previewWritten) await removeQuietly(previewWritten);
    throw error;
  }
  return outcome;
}

/** スマホから受信したファイルを登録せずに捨てる。 */
export async function discardPhoneUpload(relPath: string): Promise<void> {
  const name = relPath.split("/").pop() || "";
  if (!relPath.startsWith("receipts/") || !name.startsWith(PHONE_PREFIX)) {
    throw new Error("スマホ受信ファイルではありません");
  }
  const { remove, BaseDirectory } = await import("@tauri-apps/plugin-fs");
  await remove(relPath, { baseDir: BaseDirectory.AppData });
}

/**
 * 与えた相対パスのうち、領収書として登録済み (receipts.image_url が指している、
 * またはその原本 PDF) のものを返す。スマホ取込ページが「未登録の受信分」を出すのに使う。
 */
export async function findRegisteredReceiptFiles(relPaths: string[]): Promise<Set<string>> {
  const registered = new Set<string>();
  if (relPaths.length === 0) return registered;
  const { data, error } = await db.from("receipts").select("image_url");
  if (error) throw error;
  const known = new Set<string>();
  for (const row of (data as { image_url?: string }[] | null) || []) {
    const rel = relOf(row.image_url);
    if (!rel) continue;
    known.add(rel);
    known.add(originalPdfPathFor(rel));
  }
  for (const rel of relPaths) {
    if (known.has(rel)) registered.add(rel);
  }
  return registered;
}

/**
 * 領収書の削除。DB 行の削除と併せて、ローカルに保存している画像ファイル
 * (プレビュー・原本 PDF・トリミング前バックアップ) も削除する。
 * image_url が local:// 形式の場合のみファイル削除を試みる。
 */
export async function deleteReceipt(id: string): Promise<void> {
  const { data, error: selectError } = await db
    .from("receipts")
    .select("image_url")
    .eq("id", id)
    .single();
  if (selectError) throw selectError;

  const rel = relOf((data as { image_url?: string } | null)?.image_url);

  // 先に DB 行を消す。失敗した時にファイルだけ消すと「画像の無い領収書」が残る
  const { error: deleteError } = await db.from("receipts").delete().eq("id", id);
  if (deleteError) throw deleteError;

  if (rel) {
    const siblings = new Set([rel, origPathFor(rel), originalPdfPathFor(rel)]);
    for (const f of siblings) await removeQuietly(f);
  }
}

/**
 * PDF のまま登録されている領収書に、プレビュー用の JPEG を作って付け替える。
 *
 * PDF→JPEG 変換の導入より前に取り込まれた領収書は .pdf のまま保存されており、
 * サムネも OCR も効かない。しかも file_hash の重複判定で同じ PDF の再ドロップも
 * 弾かれるため、自動では直らない。
 *
 * 元の PDF は **消さない**。同じ base 名の `.jpg` を隣に作り、image_url をそちらへ
 * 向けるだけなので、PDF は原本としてそのまま残る (以前は 1 ページ目だけを画像に
 * して原本を削除していたため、2 ページ目以降と電子取引の原本が失われていた)。
 * file_hash は元 PDF のまま維持する (同じ PDF の再ドロップは引き続き重複扱い)。
 */
export async function migrateRawPdfReceipts(): Promise<{
  converted: number;
  failed: number;
  total: number;
}> {
  const { readFile, writeFile, BaseDirectory } = await import("@tauri-apps/plugin-fs");

  const { data, error: selectError } = await db.from("receipts").select("id, image_url");
  if (selectError) throw selectError;
  const targets = ((data as { id: string; image_url?: string }[] | null) || []).filter(
    (r) => r.image_url?.startsWith("local://") && r.image_url.toLowerCase().endsWith(".pdf"),
  );

  if (targets.length === 0) return { converted: 0, failed: 0, total: 0 };

  const { renderPdfToJpeg } = await import("@/lib/pdf-to-image");

  let converted = 0;
  let failed = 0;
  for (const row of targets) {
    const rel = row.image_url!.replace(/^local:\/\//, "");
    const jpgRel = rel.replace(/\.pdf$/i, ".jpg");
    try {
      const original = await readFile(rel, { baseDir: BaseDirectory.AppData });
      const { jpeg } = await renderPdfToJpeg(original);
      await writeFile(jpgRel, jpeg, { baseDir: BaseDirectory.AppData });

      // doc_type は触らない (invoice=受領請求書 等の既存分類を壊さない)
      const { error: updateError } = await db
        .from("receipts")
        .update({ image_url: `local://${jpgRel}` })
        .eq("id", row.id);
      if (updateError) {
        // DB はまだ PDF を指している。作ったプレビューだけ片付けて失敗扱いにする
        await removeQuietly(jpgRel);
        throw updateError;
      }
      converted++;
    } catch (e) {
      console.error(`PDF 領収書の画像化に失敗 (${rel}):`, e);
      failed++;
    }
  }
  return { converted, failed, total: targets.length };
}

/**
 * 孤児ファイル整理で「消してよいファイル」を選ぶ (純関数。テスト用に切り出し)。
 *
 * 残すもの:
 *   - 領収書が参照している画像 (known)
 *   - その原本 PDF (`<base>.pdf`) とトリミング前バックアップ (`<base>.orig.<ext>`)
 *   - スマホから受信して未登録のファイル (`phone-…`)。スマホ取込ページで
 *     「登録 / 破棄」を選ぶものなので、ここでは勝手に消さない
 */
export function selectOrphanReceiptFiles(
  fileNames: string[],
  knownRelPaths: Iterable<string>,
): { orphans: string[]; kept: number; pendingPhone: number } {
  const protectedPaths = new Set<string>();
  for (const rel of knownRelPaths) {
    protectedPaths.add(rel);
    protectedPaths.add(originalPdfPathFor(rel));
    protectedPaths.add(origPathFor(rel));
  }
  const orphans: string[] = [];
  let kept = 0;
  let pendingPhone = 0;
  for (const name of fileNames) {
    const rel = `receipts/${name}`;
    if (protectedPaths.has(rel)) {
      kept++;
    } else if (name.startsWith(PHONE_PREFIX)) {
      pendingPhone++;
    } else {
      orphans.push(rel);
    }
  }
  return { orphans, kept, pendingPhone };
}

/**
 * DB に紐付いていない孤児ファイルを receipts/ 直下から検出して削除する。
 * ユーザが「孤児ファイル整理」ボタンを押した時に使う。
 */
export async function cleanupOrphanReceiptFiles(): Promise<{
  removed: number;
  kept: number;
  pendingPhone: number;
}> {
  const { readDir, remove, BaseDirectory } = await import("@tauri-apps/plugin-fs");

  // DB が参照している画像。ここの読み込みに失敗したまま進むと「参照ゼロ」と
  // 見なして全ファイルを消してしまうので、エラーは必ず止める。
  const known = new Set<string>();
  for (const [table, col] of [
    ["receipts", "image_url"],
    ["withholding_slips", "image_url"],
    ["issuer_settings", "seal_image_url"],
  ] as const) {
    const { data, error } = await db.from(table).select(col);
    if (error) throw error;
    for (const row of (data as Record<string, string | null>[] | null) || []) {
      const rel = relOf(row[col]);
      if (rel) known.add(rel);
    }
  }

  let entries: { name: string; isFile: boolean }[] = [];
  try {
    entries = (await readDir("receipts", {
      baseDir: BaseDirectory.AppData,
    })) as { name: string; isFile: boolean }[];
  } catch {
    return { removed: 0, kept: 0, pendingPhone: 0 };
  }
  const fileNames = entries.filter((e) => e.isFile).map((e) => e.name);

  const { orphans, kept, pendingPhone } = selectOrphanReceiptFiles(fileNames, known);

  // 画像は山ほどあるのに DB からは 1 枚も参照されていない = DB を読み違えている
  // 可能性が高い (別の DB を開いている、復元途中 等)。取り返しがつかないので中止する。
  if (known.size === 0 && orphans.length > 0) {
    throw new Error(
      `画像が ${orphans.length} 件あるのに、データベースから参照されている画像が 1 件もありません。` +
        "データベースを正しく読めていない可能性があるため、整理を中止しました。",
    );
  }

  let removed = 0;
  for (const rel of orphans) {
    try {
      await remove(rel, { baseDir: BaseDirectory.AppData });
      removed++;
    } catch (e) {
      console.warn(`failed to remove orphan ${rel}:`, e);
    }
  }
  return { removed, kept, pendingPhone };
}
