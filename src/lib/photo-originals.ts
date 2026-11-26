/**
 * 取り込み済みの写真を「写真」ライブラリから削除する (写真アプリの整理)。
 *
 * 取り込んだ写真は、アプリ側 (inbox/) に画像を持っていて、領収書がそれを参照している。
 * 元の写真を写真アプリから消しても帳簿には影響しないが、消す操作は取り消しにくい
 * (「最近削除した項目」に 30 日残るだけで、iCloud 写真なら他の端末からも消える)。
 * そのため、対象は次の条件をすべて満たすものに限る:
 *
 *   - 受信箱の状態が「取り込み済み」
 *   - 取り込み先の領収書が実在する
 *   - その領収書の画像が、この写真から作ったアプリ側のファイルを指している
 *   - まだ削除を記録していない
 *
 * さらに Rust 側 (photos_delete_assets) が、アプリ側のファイルが実在して中身があることを
 * 確かめてから消す。実際の削除では OS が確認ダイアログを出す (アプリ側では省けない)。
 */

import { db } from "@/lib/localDb";

/** 1 回の操作 (= OS の確認ダイアログ 1 回) で消す上限。Rust 側の DELETE_ASSETS_MAX と合わせる */
export const DELETE_ORIGINALS_BATCH = 500;

const SETTING_AUTO_DELETE = "photo_delete_after_import";

export interface DeletableOriginal {
  inboxId: string;
  assetId: string;
  receiptId: string;
  /** アプリ側に持っている画像 */
  filePath: string;
}

/** Rust (photos_delete_assets) の戻り値 */
export interface DeleteAssetsOutcome {
  requested: number;
  deleted: string[];
  missing: string[];
  cancelled: boolean;
  error: string | null;
  skipped_no_copy?: string[];
}

export interface PhotoOriginalsDeps {
  deleteAssets: (items: { asset_id: string; file_path: string }[]) => Promise<DeleteAssetsOutcome>;
  existingAssetIds: (assetIds: string[]) => Promise<string[]>;
}

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const tauriDeps: PhotoOriginalsDeps = {
  deleteAssets: (items) => tauriInvoke<DeleteAssetsOutcome>("photos_delete_assets", { items }),
  existingAssetIds: (assetIds) => tauriInvoke<string[]>("photos_existing_asset_ids", { assetIds }),
};

interface InboxOriginalRow {
  id: string;
  source_asset_id: string | null;
  file_path: string | null;
  imported_receipt_id: string | null;
  source_deleted_at: string | null;
}

/**
 * 写真アプリから消してよい写真の一覧 (取り込みの古い順)。
 * ここで選ばれなかった写真は、何があっても削除を依頼しない。
 */
export async function listDeletableOriginals(): Promise<DeletableOriginal[]> {
  const { data, error } = await db
    .from("photo_inbox")
    .select("id, source_asset_id, file_path, imported_receipt_id, source_deleted_at, imported_at")
    .eq("state", "imported")
    .order("imported_at", { ascending: true });
  if (error) throw error;
  const rows = ((data as InboxOriginalRow[] | null) ?? []).filter(
    (r) => r.source_asset_id && r.file_path && r.imported_receipt_id && !r.source_deleted_at,
  );
  if (rows.length === 0) return [];

  // 取り込み先の領収書が実在し、その画像がこの写真のファイルを指していること
  const imageByReceipt = new Map<string, string | null>();
  const receiptIds = [...new Set(rows.map((r) => r.imported_receipt_id as string))];
  for (let i = 0; i < receiptIds.length; i += 400) {
    const { data: receipts, error: receiptError } = await db
      .from("receipts")
      .select("id, image_url")
      .in("id", receiptIds.slice(i, i + 400));
    if (receiptError) throw receiptError;
    for (const r of (receipts as { id: string; image_url: string | null }[] | null) ?? []) {
      imageByReceipt.set(r.id, r.image_url);
    }
  }

  const out: DeletableOriginal[] = [];
  for (const r of rows) {
    const receiptId = r.imported_receipt_id as string;
    const filePath = r.file_path as string;
    if (imageByReceipt.get(receiptId) !== `file://${filePath}`) continue;
    out.push({ inboxId: r.id, assetId: r.source_asset_id as string, receiptId, filePath });
  }
  return out;
}

/** 写真アプリから消してよい写真の枚数 (画面の表示用) */
export async function countDeletableOriginals(): Promise<number> {
  return (await listDeletableOriginals()).length;
}

async function markSourceDeleted(inboxIds: string[], at: string): Promise<void> {
  for (const id of inboxIds) {
    const { error } = await db.from("photo_inbox").update({ source_deleted_at: at }).eq("id", id);
    if (error) throw error;
  }
}

export interface DeleteOriginalsResult {
  /** 削除を依頼した枚数 */
  requested: number;
  /** この操作で写真ライブラリから消えた枚数 */
  deleted: number;
  /** 依頼の時点で既にライブラリに無かった枚数 (記録だけ更新した) */
  alreadyGone: number;
  /** アプリ側に画像が見つからず、削除を見送った枚数 */
  skippedNoCopy: number;
  /** 利用者が OS の確認ダイアログで取り消した */
  cancelled: boolean;
  /** まだ写真ライブラリに残っている対象の枚数 */
  remaining: number;
  error: string | null;
}

let deleting = false;

/**
 * 取り込み済みの写真を写真ライブラリから削除する (1 回につき最大 DELETE_ORIGINALS_BATCH 枚)。
 * OS の確認ダイアログで利用者が「削除」を選んだ分だけが消える。
 */
export async function deleteImportedOriginals(
  deps: PhotoOriginalsDeps = tauriDeps,
): Promise<DeleteOriginalsResult> {
  // 確認ダイアログが開いている間にもう一度押されても、二重に依頼しない
  if (deleting) throw new Error("写真の削除を実行中です（写真アプリの確認ダイアログを確認してください）");
  deleting = true;
  try {
    const all = await listDeletableOriginals();
    const batch = all.slice(0, DELETE_ORIGINALS_BATCH);
    if (batch.length === 0) {
      return {
        requested: 0,
        deleted: 0,
        alreadyGone: 0,
        skippedNoCopy: 0,
        cancelled: false,
        remaining: 0,
        error: null,
      };
    }

    const outcome = await deps.deleteAssets(
      batch.map((b) => ({ asset_id: b.assetId, file_path: b.filePath })),
    );

    // 依頼したものだけを記録の対象にする (戻り値に知らない ID が混ざっていても無視)
    const byAsset = new Map(batch.map((b) => [b.assetId, b.inboxId]));
    const idsOf = (assetIds: string[] | undefined) =>
      (assetIds ?? []).map((a) => byAsset.get(a)).filter((x): x is string => !!x);
    const deletedIds = idsOf(outcome.deleted);
    const goneIds = idsOf(outcome.missing);
    const now = new Date().toISOString();
    await markSourceDeleted([...deletedIds, ...goneIds], now);

    return {
      requested: batch.length,
      deleted: deletedIds.length,
      alreadyGone: goneIds.length,
      skippedNoCopy: idsOf(outcome.skipped_no_copy).length,
      cancelled: Boolean(outcome.cancelled),
      remaining: all.length - deletedIds.length - goneIds.length,
      error: outcome.error ?? null,
    };
  } finally {
    deleting = false;
  }
}

/**
 * 利用者が写真アプリ側で自分で消した分を、受信箱の記録に反映する。
 * @returns 反映した枚数
 */
export async function reconcileDeletedOriginals(
  deps: PhotoOriginalsDeps = tauriDeps,
): Promise<number> {
  const all = await listDeletableOriginals();
  if (all.length === 0) return 0;
  const stillThere = new Set<string>();
  for (let i = 0; i < all.length; i += DELETE_ORIGINALS_BATCH) {
    const ids = all.slice(i, i + DELETE_ORIGINALS_BATCH).map((x) => x.assetId);
    for (const id of await deps.existingAssetIds(ids)) stillThere.add(id);
  }
  const gone = all.filter((x) => !stillThere.has(x.assetId));
  // 1 枚も見つからない時は「全部消された」より「ライブラリを読めていない」可能性が高いので、何もしない
  if (gone.length === 0 || stillThere.size === 0) return 0;
  await markSourceDeleted(
    gone.map((x) => x.inboxId),
    new Date().toISOString(),
  );
  return gone.length;
}

/** 「まとめて仕訳化したあとに、写真アプリからの削除を確認する」設定 */
export async function getAutoDeleteOriginals(): Promise<boolean> {
  try {
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("id", SETTING_AUTO_DELETE)
      .single();
    return (data as { value?: string } | null)?.value === "1";
  } catch {
    return false;
  }
}

export async function setAutoDeleteOriginals(enabled: boolean): Promise<void> {
  const value = enabled ? "1" : "0";
  const updated_at = new Date().toISOString();
  const { data } = await db.from("app_settings").select("id").eq("id", SETTING_AUTO_DELETE).single();
  const { error } = data
    ? await db.from("app_settings").update({ value, updated_at }).eq("id", SETTING_AUTO_DELETE)
    : await db.from("app_settings").insert({ id: SETTING_AUTO_DELETE, value, updated_at });
  if (error) throw error;
}

/** 削除の結果を、利用者向けの 1 文にする (純関数) */
export function describeDeleteResult(r: DeleteOriginalsResult): string {
  if (r.requested === 0) return "写真アプリから消せる取り込み済みの写真はありません";
  const parts: string[] = [];
  if (r.deleted > 0) parts.push(`${r.deleted} 枚を写真アプリから削除しました（「最近削除した項目」に 30 日残ります）`);
  if (r.alreadyGone > 0) parts.push(`${r.alreadyGone} 枚は既に写真アプリにありませんでした`);
  if (r.skippedNoCopy > 0) parts.push(`${r.skippedNoCopy} 枚はアプリ側の画像が見つからないため消していません`);
  if (r.cancelled && r.deleted === 0) parts.push("削除を取り消しました");
  if (r.error) parts.push(`エラー: ${r.error}`);
  if (parts.length === 0) parts.push("写真アプリからは何も消していません");
  if (r.remaining > 0) parts.push(`残り ${r.remaining} 枚`);
  return parts.join(" / ");
}
