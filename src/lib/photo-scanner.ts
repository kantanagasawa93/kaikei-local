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
import { classifyReceipt, classifyReceiptWithSignals, shouldAutoDismiss, explainAutoDismiss } from "@/lib/receipt-classifier";

export interface ScannedPhoto {
  asset_id: string;
  taken_at: number; // unix seconds
  width: number;
  height: number;
  file_path: string;
  /** Round 21 ⓐ: PHAsset.isFavorite. Frontend は signals[] にも入れてスコアブースト。 */
  is_favorite?: boolean;
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
  receiptCount: number;
  errors: string[];
  /** Round 7 ㊑: 自動破棄ルールで初期 dismissed になった件数 */
  autoDismissed?: number;
}

/**
 * Round 16 ㊀: scanNow の per-item progress イベント。
 * 1 枚ごとの OCR 完了時に scanNow が呼び出す。
 */
export interface ScanItemProgress {
  assetId: string;
  state: "candidate" | "receipt" | "not_receipt" | "dismissed";
  score: number | null;
  /** ocr_text の最初の有意 1 行 (= 店名候補)。空の時は null */
  vendorHint: string | null;
}

/**
 * 「今すぐスキャン」のメインエントリ。
 *
 * @param trigger 'manual' (UI ボタン) | 'launchagent' (定期実行)
 * @param fallbackSince since が未保存の時の fallback (デフォルト: 7日前)
 */
export async function scanNow(
  trigger: "manual" | "schedule" | "launchagent" = "manual",
  fallbackSince?: number,
  /** Round 16 ㊀ per-photo 進捗コールバック (省略可) */
  onProgress?: (done: number, total: number, lastItem?: ScanItemProgress) => void,
  /** Round 17 ㊅ AbortSignal — UI から「キャンセル」ボタンで中断 */
  signal?: AbortSignal,
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

  // Round 7 ㊑ 自動破棄ルール: ユーザーが過去に dismissed / not_receipt と
  // マークしたテキスト集合を取り、新規 candidate と類似していれば直接 dismissed。
  // 大量ライブラリでも速いように 1 回だけ取得して in-memory で照合。
  const { data: dismissedRows } = await db
    .from("photo_inbox")
    .select("ocr_text")
    .in("state", ["dismissed", "not_receipt"]);
  const dismissedTexts = ((dismissedRows as { ocr_text: string | null }[] | null) ?? [])
    .map((r) => r.ocr_text)
    .filter((t): t is string => !!t);

  // Round 10 ㉡: Vision OCR の customWords にドメイン語を注入する。
  // partners.name (登録済み取引先) + receipts.vendor_name (過去 OCR で確定した
  // 店名) を集めて固有名詞辞書を作る。重複排除 + 短すぎる語を除外。
  const customWordsSet = new Set<string>();
  try {
    const { data: partners } = await db.from("partners").select("name");
    for (const p of (partners as { name: string | null }[] | null) ?? []) {
      if (p.name && p.name.length >= 2) customWordsSet.add(p.name.trim());
    }
    const { data: vendors } = await db.from("receipts").select("vendor_name");
    for (const r of (vendors as { vendor_name: string | null }[] | null) ?? []) {
      if (r.vendor_name && r.vendor_name.length >= 2) customWordsSet.add(r.vendor_name.trim());
    }
  } catch {
    // 失敗しても OCR は走らせる (空配列 fallback)
  }
  const customWords = Array.from(customWordsSet).slice(0, 200); // Vision 上限気にして 200 で打ち切り

  let newPhotos = 0;
  let receiptCount = 0;
  let autoDismissed = 0;
  let processed = 0;
  let cancelled = false;
  for (const photo of scanned) {
    // ㊅ Round 17: 各 photo 開始時に AbortSignal をチェック。
    // 既に処理中の photo は最後まで完走させ、その後ループを抜ける。
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    processed++;
    try {
      // 既存の asset_id があるかチェック
      const { data: existing } = await db
        .from("photo_inbox")
        .select("id")
        .eq("source_asset_id", photo.asset_id)
        .single();
      if (existing) continue;

      // Vision OCR + 領収書スコアリング (完全ローカル)
      // Round 10 ㉡ + Round 11 ㉦: customWords + ヒット数のレポート
      // Round 13 ㉰: classify の signals[] を JSON 化して保存
      let ocrText: string | null = null;
      let score: number | null = null;
      let initialState: "candidate" | "receipt" | "not_receipt" | "dismissed" = "candidate";
      let scoreSignalsJson: string | null = null;
      try {
        const visionRes = await invoke<{
          lines: string[];
          joined: string;
          language: string;
          custom_word_hits?: Record<string, number>;
        }>("vision_recognize_text", { filePath: photo.file_path, customWords });
        ocrText = visionRes.joined;
        if (visionRes.custom_word_hits && Object.keys(visionRes.custom_word_hits).length > 0) {
          const summary = Object.entries(visionRes.custom_word_hits)
            .map(([w, c]) => `${w}×${c}`)
            .join(", ");
          console.info(`[vision] customWords hits for ${photo.asset_id}: ${summary}`);
        }
        // Round 21 ⓐ: PHAsset.isFavorite を classifier に渡してブースト
        const cls = classifyReceiptWithSignals(ocrText, {
          is_favorite: photo.is_favorite === true,
        });
        score = cls.score;
        initialState = cls.state;
        // ㉰ signals[] を JSON 化 (UI tooltip で展開する)
        if (cls.signals && cls.signals.length > 0) {
          scoreSignalsJson = JSON.stringify({
            score: Number(cls.score.toFixed(3)),
            signals: cls.signals.map((s) => ({
              score: Number(s.score.toFixed(3)),
              reason: s.reason,
            })),
          });
        }
      } catch (e) {
        console.warn(`vision OCR failed for ${photo.asset_id}:`, e);
      }

      // Round 7 ㊑ + Round 8 ㊗: classify 結果が receipt になっていない場合のみ、
      // 過去の dismissed パターンと類似度を見て自動破棄。
      // (receipt 判定の写真は確実に領収書なので学習で潰さない)
      // 自動破棄になった時は理由 (類似度・共通キーワード・snippet) を JSON で
      // photo_inbox.auto_dismissed_reason に保存して透明性を担保する。
      let autoDismissedReason: string | null = null;
      if (initialState !== "receipt" && ocrText) {
        const reason = explainAutoDismiss(ocrText, dismissedTexts);
        if (reason.matched) {
          initialState = "dismissed";
          autoDismissed++;
          autoDismissedReason = JSON.stringify({
            similarity: Number(reason.similarity.toFixed(3)),
            matched_keywords: reason.matchedKeywords,
            matched_past_snippet: reason.matchedPastSnippet,
            decided_at: new Date().toISOString(),
          });
        }
      }

      await db.from("photo_inbox").insert({
        id: crypto.randomUUID(),
        source_asset_id: photo.asset_id,
        taken_at: new Date(photo.taken_at * 1000).toISOString(),
        detected_at: new Date().toISOString(),
        width: photo.width,
        height: photo.height,
        file_path: photo.file_path,
        ocr_text: ocrText,
        state: initialState,
        receipt_score: score,
        auto_dismissed_reason: autoDismissedReason,
        score_signals_json: scoreSignalsJson,
      });
      newPhotos++;
      if (initialState === "receipt") receiptCount++;

      // ㊀ Round 16: per-photo 進捗 callback
      if (onProgress) {
        // OCR テキストの最初の非空行を vendor 候補として渡す (~30 文字 trim)
        const vendorHint = (() => {
          if (!ocrText) return null;
          for (const ln of ocrText.split(/\r?\n/)) {
            const t = ln.trim();
            if (t.length >= 2) return t.slice(0, 30);
          }
          return null;
        })();
        try {
          onProgress(processed, scanned.length, {
            assetId: photo.asset_id,
            state: initialState,
            score,
            vendorHint,
          });
        } catch {
          /* UI コールバック失敗は scan 全体を止めない */
        }
      }
    } catch (e) {
      errors.push(`${photo.asset_id}: ${(e as Error).message}`);
      if (onProgress) {
        try {
          onProgress(processed, scanned.length, {
            assetId: photo.asset_id,
            state: "candidate",
            score: null,
            vendorHint: null,
          });
        } catch {
          /* silent */
        }
      }
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
      receipt_count: receiptCount,
      imported_count: 0, // Phase 4 で更新
      error:
        errors.length > 0
          ? errors.join("; ").slice(0, 500)
          : cancelled
            ? "user_cancelled"
            : null,
    })
    .eq("id", logId);

  if (cancelled) {
    // 「user_cancelled」を errors の先頭に積んで呼出側で判別可能に
    errors.unshift("user_cancelled");
  }
  return { scanned: scanned.length, newPhotos, receiptCount, errors, autoDismissed };
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
  state: "candidate" | "receipt" | "not_receipt" | "imported" | "dismissed" | "receipt_failed";
  imported_receipt_id: string | null;
  imported_at: string | null;
  notes: string | null;
  created_at: string;
  // v4 追加カラム
  claude_result_json: string | null;
  last_error: string | null;
  attempts: number | null;
  // v6 追加カラム (Round 8 ㊗: 自動破棄理由 — JSON 文字列)
  auto_dismissed_reason: string | null;
  // v7 追加カラム (Round 13 ㉰: score の内訳 signals[] — JSON 文字列)
  score_signals_json: string | null;
  // v8 追加カラム (Round 21 ⓑ: ユーザが受信箱でカードを開いた最終時刻)
  last_viewed_at?: string | null;
}

/**
 * Round 21 ⓑ: 受信箱でカードを開いた時刻を記録する。
 * UI が <ReceiptCard> の onClick (展開) で呼ぶと、次回以降「未確認」バッジが消える。
 */
export async function markInboxViewed(inboxId: string): Promise<void> {
  await db
    .from("photo_inbox")
    .update({ last_viewed_at: new Date().toISOString() })
    .eq("id", inboxId);
}

/**
 * Round 22 ⓒ: candidate でかつ last_viewed_at が NULL の行を一括で「既読」化する。
 * 受信箱の「全部既読」ボタンから呼ぶ想定。
 *
 * @param ids 対象 inbox.id の配列 (UI 側で表示中の candidate のみに絞った id list)
 *            空なら何もしない。空 array でも update せず 0 を返す。
 * @returns 更新できた件数
 */
export async function markInboxAllViewed(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const now = new Date().toISOString();
  let count = 0;
  // Tauri SQL の .in().update() を順次。1000 件規模でも 1〜2 秒で済む。
  for (const id of ids) {
    try {
      await db.from("photo_inbox").update({ last_viewed_at: now }).eq("id", id);
      count++;
    } catch (e) {
      console.warn(`markInboxAllViewed: ${id} failed:`, e);
    }
  }
  return count;
}

/**
 * Round 9 ㉞ で拡張: state に加えて検索クエリ + 撮影日範囲を受ける。
 * - q: ocr_text に対する LIKE %q% (大文字小文字は SQLite の LIKE 仕様に従う)
 * - fromDate / toDate: ISO 文字列で taken_at の前後制限
 */
export async function listInbox(
  state?: InboxRow["state"],
  opts: { q?: string; fromDate?: string; toDate?: string } = {},
): Promise<InboxRow[]> {
  let query = db.from("photo_inbox").select("*").order("taken_at", { ascending: false });
  if (state) query = query.eq("state", state);
  if (opts.q && opts.q.trim().length > 0) {
    query = query.like("ocr_text", `%${opts.q.trim()}%`);
  }
  if (opts.fromDate) {
    query = query.gte("taken_at", opts.fromDate);
  }
  if (opts.toDate) {
    // 終日の 23:59:59 まで含めるため日付末尾の "T23:59:59" を補う
    query = query.lte("taken_at", `${opts.toDate}T23:59:59`);
  }
  const { data } = await query;
  return (data as InboxRow[] | null) ?? [];
}

export async function setInboxState(
  id: string,
  state: InboxRow["state"]
): Promise<void> {
  await db.from("photo_inbox").update({ state }).eq("id", id);
}

/**
 * Round 16 ㉿: 受信箱カードで AI OCR の vendor / amount / date を編集する。
 * claude_result_json をパース → 部分上書き → 保存。次の再仕訳化や
 * receipts/new の prefill (Round 5 ㊇) で更新後の値が使われる。
 */
export async function updateInboxClaudeResult(
  inboxId: string,
  patch: {
    vendor_name?: string | null;
    amount?: number | null;
    date?: string | null;
  },
): Promise<void> {
  const { data } = await db
    .from("photo_inbox")
    .select("claude_result_json")
    .eq("id", inboxId)
    .single();
  let parsed: Record<string, unknown> = {};
  const raw = (data as { claude_result_json: string | null } | null)?.claude_result_json;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* 破損 JSON は丸ごと上書き */
    }
  }
  // null は明示的に値を消す意味、undefined は触らない
  if (patch.vendor_name !== undefined) parsed.vendor_name = patch.vendor_name;
  if (patch.amount !== undefined) parsed.amount = patch.amount;
  if (patch.date !== undefined) parsed.date = patch.date;
  await db
    .from("photo_inbox")
    .update({ claude_result_json: JSON.stringify(parsed) })
    .eq("id", inboxId);
}

/**
 * Round 14 ㉵: 受信箱の 1 件を Vision OCR で再認識する。
 *
 * - twoPass=true で両言語独立 OCR + 結合 (Round 13 ㉲)。英字メニューが
 *   ja モデルでひらがな化される事故の救済に有効
 * - 再分類した結果で score / state / score_signals_json / ocr_text を更新
 *
 * @returns 更新後の score
 */
export async function reocrInboxRow(
  inboxId: string,
  options: { twoPass?: boolean; lang?: "ja" | "en" } = {},
): Promise<{ score: number | null; state: InboxRow["state"] }> {
  const { data } = await db
    .from("photo_inbox")
    .select("id, file_path")
    .eq("id", inboxId)
    .single();
  const row = data as { id: string; file_path: string | null } | null;
  if (!row || !row.file_path) {
    throw new Error("対象の写真または file_path がありません");
  }

  // customWords を partners + receipts.vendor_name から再構築
  const set = new Set<string>();
  try {
    const { data: ps } = await db.from("partners").select("name");
    for (const p of (ps as { name: string | null }[] | null) ?? []) {
      if (p.name && p.name.length >= 2) set.add(p.name.trim());
    }
    const { data: rs } = await db.from("receipts").select("vendor_name");
    for (const r of (rs as { vendor_name: string | null }[] | null) ?? []) {
      if (r.vendor_name && r.vendor_name.length >= 2) set.add(r.vendor_name.trim());
    }
  } catch {
    /* silent */
  }
  const customWords = Array.from(set).slice(0, 200);

  const visionRes = await invoke<{
    lines: string[];
    joined: string;
    language: string;
    custom_word_hits?: Record<string, number>;
  }>("vision_recognize_text", {
    filePath: row.file_path,
    customWords,
    twoPass: options.twoPass === true,
    lang: options.lang,
  });

  const cls = classifyReceipt(visionRes.joined);
  const signalsJson =
    cls.signals && cls.signals.length > 0
      ? JSON.stringify({
          score: Number(cls.score.toFixed(3)),
          signals: cls.signals.map((s) => ({
            score: Number(s.score.toFixed(3)),
            reason: s.reason,
          })),
        })
      : null;

  // state は「現状から悪化させない」方針: 既に dismissed/imported なら触らない、
  // candidate / receipt / receipt_failed のみ classify 結果で上書き
  const { data: cur } = await db
    .from("photo_inbox")
    .select("state")
    .eq("id", inboxId)
    .single();
  const curState = (cur as { state: string } | null)?.state;
  const update: Record<string, unknown> = {
    ocr_text: visionRes.joined,
    receipt_score: cls.score,
    score_signals_json: signalsJson,
  };
  if (curState === "candidate" || curState === "receipt" || curState === "receipt_failed") {
    update.state = cls.state;
  }
  await db.from("photo_inbox").update(update).eq("id", inboxId);

  return { score: cls.score, state: (update.state as InboxRow["state"]) ?? (curState as InboxRow["state"]) };
}

// ────────────────────────────────────────────────────────────
// LaunchAgent (定期スキャン)
// ────────────────────────────────────────────────────────────

export interface LaunchAgentStatus {
  installed: boolean;
  time?: string | null;
  plist_path?: string | null;
  last_run?: string | null;
}

export async function launchAgentStatus(): Promise<LaunchAgentStatus> {
  try {
    return await invoke<LaunchAgentStatus>("launchd_status");
  } catch (e) {
    console.warn("launchd_status failed:", e);
    return { installed: false };
  }
}

/** time = "HH:MM" */
export async function launchAgentInstall(time: string): Promise<LaunchAgentStatus> {
  return await invoke<LaunchAgentStatus>("launchd_install", { time });
}

export async function launchAgentUninstall(): Promise<LaunchAgentStatus> {
  return await invoke<LaunchAgentStatus>("launchd_uninstall");
}

export interface ScanLogRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: "manual" | "schedule" | "launchagent";
  scanned_count: number;
  receipt_count: number;
  imported_count: number;
  error: string | null;
}

export async function recentScanLog(limit = 10): Promise<ScanLogRow[]> {
  const { data } = await db
    .from("photo_scan_log")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  return (data as ScanLogRow[] | null) ?? [];
}
