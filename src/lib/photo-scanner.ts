/**
 * 写真自動取込 (Phase 1〜)
 *
 * Mac の写真ライブラリ (iCloud 同期含む) から領収書候補を抽出するための
 * フロント側ヘルパ。Tauri の photos_* コマンドを呼び、結果を photo_inbox に
 * 永続化する。
 *
 * 設計:
 *   1. ユーザーが「今すぐスキャン」を押す or LaunchAgent から CLI が叩かれる
 *   2. 前回スキャン時刻を app_settings から読む
 *   3. photos_scan_recent(since_unix) で増分写真の path 配列を取得
 *   4. 各写真について photo_inbox に upsert
 *   5. (Phase 2) Vision OCR で領収書スコア付け
 *   6. (Phase 4) state='receipt' になったら自動で receipts + journals 作成
 *   7. photo_scan_log に行を作って結果を記録
 */

import { db } from "@/lib/localDb";

export interface ScannedPhoto {
  asset_id: string;
  taken_at: number; // unix seconds
  width: number;
  height: number;
  file_path: string;
}

export type AuthStatus =
  | "authorized"
  | "limited"
  | "denied"
  | "restricted"
  | "not_determined"
  | "unsupported"
  | "unknown";

const SETTING_LAST_SCAN = "photo_scan_last_unix";

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function getAuthStatus(): Promise<AuthStatus> {
  try {
    return (await invoke<string>("photos_authorization_status")) as AuthStatus;
  } catch (e) {
    console.warn("photos_authorization_status failed:", e);
    return "unknown";
  }
}

export async function requestAuth(): Promise<AuthStatus> {
  try {
    return (await invoke<string>("photos_request_authorization")) as AuthStatus;
  } catch (e) {
    console.warn("photos_request_authorization failed:", e);
    return "denied";
  }
}

export async function getLastScanUnix(): Promise<number> {
  try {
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("id", SETTING_LAST_SCAN)
      .single();
    const raw = (data as { value?: string } | null)?.value;
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export async function setLastScanUnix(unix: number): Promise<void> {
  const { data } = await db
    .from("app_settings")
    .select("id")
    .eq("id", SETTING_LAST_SCAN)
    .single();
  const value = String(unix);
  const updated_at = new Date().toISOString();
  if (data) {
    await db.from("app_settings").update({ value, updated_at }).eq("id", SETTING_LAST_SCAN);
  } else {
    await db.from("app_settings").insert({ id: SETTING_LAST_SCAN, value, updated_at });
  }
}

export interface ScanResult {
  scanned: number;
  newPhotos: number;
  errors: string[];
}

/**
 * 「今すぐスキャン」のメインエントリ。
 *
 * @param trigger 'manual' (UI ボタン) | 'launchagent' (定期実行)
 * @param fallbackSince since が未保存の時の fallback (デフォルト: 7日前)
 */
export async function scanNow(
  trigger: "manual" | "schedule" | "launchagent" = "manual",
  fallbackSince?: number
): Promise<ScanResult> {
  const auth = await getAuthStatus();
  if (auth !== "authorized" && auth !== "limited") {
    throw new Error(`写真ライブラリへのアクセスが許可されていません (status=${auth})`);
  }

  const lastScan = await getLastScanUnix();
  const since = lastScan > 0
    ? lastScan
    : (fallbackSince ?? Math.floor(Date.now() / 1000) - 7 * 24 * 3600);

  // photo_scan_log に進行中行を入れる
  const logId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await db.from("photo_scan_log").insert({
    id: logId,
    started_at: startedAt,
    trigger,
    scanned_count: 0,
    receipt_count: 0,
    imported_count: 0,
  });

  const errors: string[] = [];
  let scanned: ScannedPhoto[] = [];
  try {
    scanned = await invoke<ScannedPhoto[]>("photos_scan_recent", { sinceUnix: since });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    errors.push(msg);
    await db
      .from("photo_scan_log")
      .update({
        finished_at: new Date().toISOString(),
        error: msg,
      })
      .eq("id", logId);
    throw new Error(msg);
  }

  let newPhotos = 0;
  for (const photo of scanned) {
    try {
      // 既存の asset_id があるかチェック
      const { data: existing } = await db
        .from("photo_inbox")
        .select("id")
        .eq("source_asset_id", photo.asset_id)
        .single();
      if (existing) continue;

      await db.from("photo_inbox").insert({
        id: crypto.randomUUID(),
        source_asset_id: photo.asset_id,
        taken_at: new Date(photo.taken_at * 1000).toISOString(),
        detected_at: new Date().toISOString(),
        width: photo.width,
        height: photo.height,
        file_path: photo.file_path,
        state: "candidate",
        receipt_score: null,
      });
      newPhotos++;
    } catch (e) {
      errors.push(`${photo.asset_id}: ${(e as Error).message}`);
    }
  }

  // 完了したスキャン時刻を記録 (最新の写真の撮影時刻 or 現在時刻)
  const latestTaken = scanned.length > 0 ? Math.max(...scanned.map((p) => p.taken_at)) : 0;
  if (latestTaken > since) {
    await setLastScanUnix(latestTaken);
  } else {
    // 写真が無くても次回 since を進めて再スキャンを軽量化
    await setLastScanUnix(Math.floor(Date.now() / 1000));
  }

  await db
    .from("photo_scan_log")
    .update({
      finished_at: new Date().toISOString(),
      scanned_count: scanned.length,
      receipt_count: 0, // Phase 2 で更新
      imported_count: 0, // Phase 4 で更新
      error: errors.length > 0 ? errors.join("; ").slice(0, 500) : null,
    })
    .eq("id", logId);

  return { scanned: scanned.length, newPhotos, errors };
}

export interface InboxRow {
  id: string;
  source_asset_id: string;
  taken_at: string;
  detected_at: string;
  width: number | null;
  height: number | null;
  file_path: string | null;
  thumbnail_path: string | null;
  ocr_text: string | null;
  receipt_score: number | null;
  state: "candidate" | "receipt" | "not_receipt" | "imported" | "dismissed";
  imported_receipt_id: string | null;
  imported_at: string | null;
  notes: string | null;
  created_at: string;
}

export async function listInbox(state?: InboxRow["state"]): Promise<InboxRow[]> {
  let query = db.from("photo_inbox").select("*").order("taken_at", { ascending: false });
  if (state) query = query.eq("state", state);
  const { data } = await query;
  return (data as InboxRow[] | null) ?? [];
}

export async function setInboxState(
  id: string,
  state: InboxRow["state"]
): Promise<void> {
  await db.from("photo_inbox").update({ state }).eq("id", id);
}
