"use client";

/**
 * 写真自動取込「受信箱」ページ
 *
 * - macOS の写真ライブラリ (iCloud 同期含む) から取り込まれた写真候補を一覧
 * - 状態: candidate (未判定) / receipt (領収書) / not_receipt / imported / dismissed
 * - 各行で "領収書として登録" / "違う" / "破棄" のアクション
 *
 * 注: Phase 1 ではユーザが手動で「今すぐスキャン」を押す。Vision OCR や
 * 自動仕訳は Phase 2〜4 で順次有効化される。
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Inbox as InboxIcon,
  RefreshCw,
  Camera,
  Settings,
  AlertCircle,
  Check,
  X as XIcon,
  Trash2,
  RotateCcw,
  Search,
  ScanText,
  Sparkles,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { db } from "@/lib/localDb";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { AiOcrQuotaBanner } from "@/components/ai-ocr-quota-banner";
import { InboxCard } from "@/components/inbox/InboxCard";
import { HoverPreview } from "@/components/inbox/HoverPreview";
import {
  scanNow,
  listInbox,
  setInboxState,
  reocrInboxRow,
  markInboxViewed,
  markInboxAllViewed,
  getAuthStatus,
  getLastScanSummary,
  getLastPurgeUnix,
  type AuthStatus,
  type InboxRow,
  type LastScanSummary,
} from "@/lib/photo-scanner";
import {
  autoJournalizeAllReceipts,
  getAutoJournalMode,
  quickConfirmOne,
  resetFailedToReceipt,
  resetAllFailedToReceipt,
  getFailureStats,
  classifyOcrError,
  BlockedByPattern,
  type FailureStats,
  type FailureBucket,
} from "@/lib/auto-journal";
import { toast } from "@/lib/toast";

type InboxState = InboxRow["state"];

export default function InboxPage() {
  const router = useRouter();
  const [items, setItems] = useState<InboxRow[]>([]);
  const [auth, setAuth] = useState<AuthStatus>("unknown");
  const [scanning, setScanning] = useState(false);
  // Round 23 ⓖ: 直近スキャン結果のサマリーバー
  const [lastScan, setLastScan] = useState<LastScanSummary | null>(null);
  // Round 26 ⓕ: 90 日 purge の最終実行時刻 (dismissed タブで表示)
  const [lastPurgeUnix, setLastPurgeUnix] = useState<number | null>(null);
  const [filter, setFilter] = useState<InboxState | "all">("candidate");
  // Round 24 ⓖ: 破棄タブで「expired_30d 自動破棄のみ」フィルタ
  const [expiredOnly, setExpiredOnly] = useState(false);
  // Round 26 ⓑ: 破棄 reason 別 click filter (Badge クリックで toggle)
  // Round 28 ⓒ: 失敗タブで failure bucket 別フィルタ (Badge クリックで toggle)
  const [failureBucketFilter, setFailureBucketFilter] = useState<FailureBucket | null>(null);
  const [reasonFilter, setReasonFilter] = useState<
    "expired_30d" | "duplicate" | "pattern" | "manual" | null
  >(null);
  const [, setAutoMode] = useState(false);
  const [journalizing, setJournalizing] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    lastLabel?: string;
    lastOk?: boolean;
  } | null>(null);
  // ⓓ クイック確定中の inbox.id を持っておく (カード単位の押下中表示)
  const [quickConfirming, setQuickConfirming] = useState<string | null>(null);
  // ㉵ Round 14: 再 OCR 実行中の inbox.id (カード単位のスピナー)
  const [reocrInProgress, setReocrInProgress] = useState<string | null>(null);
  // Round 28 ⓖ: bulk 再 OCR の進捗 ({done, total, ok, fail} — null なら非表示)
  const [bulkReocrProgress, setBulkReocrProgress] = useState<{
    done: number;
    total: number;
    ok: number;
    fail: number;
  } | null>(null);
  // ㊅ Round 17: scanNow をキャンセルするための AbortController
  const scanAbortRef = useRef<AbortController | null>(null);

  // ㉢ Round 10: フォーカス対象カードの index (キーボード操作の基点)
  const [focusIdx, setFocusIdx] = useState<number>(-1);
  // ㉧ Round 11: ヘルプモーダル表示
  const [helpOpen, setHelpOpen] = useState(false);
  // ㉧ Round 11: 検索 input にフォーカスを当てたい時のフラグ
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // ㊌ hover preview ハンドラ: enter で 250ms 後に表示、leave で 100ms 後に消す
  // Round 28: ホバー対象カードが画面右半分にある時はプレビューを左に出して
  // 該当カードの操作ボタンに被らないようにする (event を受け取って判定)
  const handleHoverEnter = (row: InboxRow, e?: React.MouseEvent) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (e && typeof window !== "undefined") {
      const target = e.currentTarget as HTMLElement | null;
      const rect = target?.getBoundingClientRect();
      const cardCenter = rect ? rect.left + rect.width / 2 : e.clientX;
      setPreviewSide(cardCenter > window.innerWidth / 2 ? "left" : "right");
    }
    hoverTimer.current = setTimeout(() => setHovered(row), 250);
  };
  const handleHoverLeave = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHovered(null), 100);
  };
  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    };
  }, []);

  // ㊇ Round 17: kaikei:demo-action イベントを listen して、所定の関数を呼ぶ
  // verify-app.sh demo-scenario から control file 経由で発火される
  useEffect(() => {
    const handler = (e: Event) => {
      const action = (e as CustomEvent<string>).detail;
      switch (action) {
        case "scan-now":
          void handleScan();
          break;
        case "journalize-all-receipts":
          void handleJournalizeAll();
          break;
        case "open-help":
          setHelpOpen(true);
          break;
        default:
          console.warn("[demo-action] 未知のアクション:", action);
      }
    };
    window.addEventListener("kaikei:demo-action", handler);
    return () => window.removeEventListener("kaikei:demo-action", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ㉢ Round 10: グローバルキーボードショートカット
  // - ↑↓: focusIdx を移動
  // - A: 領収書 / X: 違う / D: 破棄 / R: 未判定に戻す
  // - Enter: receipt なら登録に進む、candidate なら「いますぐ仕訳化」
  // - Space: hover preview をトグル
  // - Esc: 選択解除 + フォーカスクリア
  // 入力中 (input/textarea/contenteditable) は無効化
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (items.length === 0) return;

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setFocusIdx((i) => Math.min(items.length - 1, i < 0 ? 0 : i + 1));
        return;
      }
      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setFocusIdx((i) => Math.max(0, i < 0 ? 0 : i - 1));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        clearSelection();
        setFocusIdx(-1);
        setHovered(null);
        setHelpOpen(false);
        return;
      }
      // ㉧ Round 11: ? でヘルプモーダル / / で検索フォーカス
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setHelpOpen((o) => !o);
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        setShowSearch(true);
        // 1 frame 後に input にフォーカス
        setTimeout(() => searchInputRef.current?.focus(), 50);
        return;
      }

      if (focusIdx < 0 || focusIdx >= items.length) return;
      const row = items[focusIdx];

      if (e.key === " ") {
        e.preventDefault();
        // Space で hover preview を toggle
        setHovered((cur) => (cur && cur.id === row.id ? null : row));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (row.state === "receipt") {
          router.push(`/receipts/new?inbox=${row.id}`);
        } else if (row.state === "candidate" || row.state === "receipt_failed") {
          void quickConfirm(row.id);
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "a") {
        e.preventDefault();
        void markReceipt(row.id);
      } else if (k === "x") {
        e.preventDefault();
        void markNotReceipt(row.id);
      } else if (k === "d") {
        e.preventDefault();
        void dismiss(row.id);
      } else if (k === "r") {
        e.preventDefault();
        void restoreToCandidate(row.id);
      } else if (k === "s") {
        // S = select / unselect (Cmd+クリックの代替)
        e.preventDefault();
        toggleSelected(row.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, focusIdx]);
  // ㊁ 失敗パターン集計 (top バケットを「失敗」タブの近くにヒント表示)
  const [failureStats, setFailureStats] = useState<FailureStats | null>(null);
  // ㊌ Round 6: hover プレビュー対象 (右側 pane に拡大画像 + OCR を表示)
  const [hovered, setHovered] = useState<InboxRow | null>(null);
  // Round 28: プレビューの出る側 (ホバー対象カードの位置で左右自動切替)
  const [previewSide, setPreviewSide] = useState<"left" | "right">("right");
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ㉜ Round 9: マルチ選択 (Cmd/Shift+クリックでチェック → 一括判定)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // ㉞ Round 9: 検索 (OCR テキスト + 撮影日範囲)
  const [searchQ, setSearchQ] = useState("");
  const [searchFrom, setSearchFrom] = useState(""); // YYYY-MM-DD
  const [searchTo, setSearchTo] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  // 件数バッジ用: state ごとの行数 (タブ表示の補助)
  const [counts, setCounts] = useState<Record<InboxState | "all", number>>({
    candidate: 0,
    receipt: 0,
    imported: 0,
    not_receipt: 0,
    dismissed: 0,
    receipt_failed: 0,
    all: 0,
  });

  const refresh = async () => {
    setAuth(await getAuthStatus());
    setItems(
      await listInbox(filter === "all" ? undefined : filter, {
        q: searchQ,
        fromDate: searchFrom || undefined,
        toDate: searchTo || undefined,
      }),
    );
    setAutoMode(await getAutoJournalMode());
    // Round 23 ⓖ: 直近スキャンサマリーをロード
    try {
      setLastScan(await getLastScanSummary());
    } catch {
      /* silent */
    }
    // Round 26 ⓕ: 最終 purge 日時 (dismissed タブで表示)
    try {
      setLastPurgeUnix(await getLastPurgeUnix());
    } catch {
      /* silent */
    }
    // 件数バッジ: 状態ごとに件数を取得 (検索条件は除外 — 全体を見せる)
    const all = await listInbox();
    const next: Record<InboxState | "all", number> = {
      candidate: 0,
      receipt: 0,
      imported: 0,
      not_receipt: 0,
      dismissed: 0,
      receipt_failed: 0,
      all: all.length,
    };
    for (const r of all) next[r.state] = (next[r.state] ?? 0) + 1;
    setCounts(next);
    // ㊁ 失敗パターン集計を refresh のたびに更新
    try {
      setFailureStats(await getFailureStats());
    } catch {
      setFailureStats(null);
    }
  };

  useEffect(() => {
    void refresh();
  }, [filter, searchQ, searchFrom, searchTo]);

  // Round 22 ⓒ: 表示中の candidate でかつ未確認 (last_viewed_at IS NULL) を一括既読化
  const handleMarkAllViewed = async () => {
    const targets = items.filter(
      (it) => it.state === "candidate" && !it.last_viewed_at,
    );
    if (targets.length === 0) {
      toast.info("未確認のカードはありません");
      return;
    }
    const updated = await markInboxAllViewed(targets.map((t) => t.id));
    // ローカル state 即時反映
    const now = new Date().toISOString();
    const updatedIds = new Set(targets.map((t) => t.id));
    setItems((prev) =>
      prev.map((p) =>
        updatedIds.has(p.id) ? { ...p, last_viewed_at: now } : p,
      ),
    );
    toast.success(`${updated} 件を既読化しました`);
  };

  const handleDismissAllCandidates = async () => {
    const candidates = await listInbox("candidate");
    const count = candidates.length;
    if (count === 0) {
      toast.info("未判定の写真がありません");
      return;
    }
    const ok = window.confirm(
      `未判定 ${count} 件をまとめて「破棄」状態にします。\n\n` +
        `※ 画像ファイル自体は残ります (受信箱内の状態が変わるだけ)。\n` +
        `※ 後で「破棄」タブから個別に「領収書」へ戻すこともできます。\n\n` +
        `続行しますか?`
    );
    if (!ok) return;
    try {
      // 1 回の UPDATE で全 candidate を dismissed へ
      await db.from("photo_inbox").update({ state: "dismissed" }).eq("state", "candidate");
      toast.success(`${count} 件を破棄しました`);
      await refresh();
    } catch (e) {
      toast.error(`破棄に失敗: ${(e as Error).message}`);
    }
  };

  const handleJournalizeAll = async () => {
    if (journalizing) return;

    // 課金前確認: state='receipt' の件数を数えて、Claude API 課金が発生する旨を明示
    const receiptItems = await listInbox("receipt");
    const count = receiptItems.length;
    if (count === 0) {
      toast.info("領収書状態の写真がありません");
      return;
    }

    // ㊆ Round 5: スマートトリミング — 直近の失敗バケットを参照し、actionable
    // な原因 (license/consent) が支配的なら「設定を直してから実行」を促す。
    // 「とりあえず押した → 全件 license_limit で落ちる → 月次上限を浪費」を防ぐ。
    let warnMsg = "";
    if (failureStats?.top && failureStats.top.count >= 2) {
      const b = failureStats.top.bucket;
      if (b === "license" || b === "consent") {
        warnMsg =
          `\n\n⚠️ 直近の失敗 ${failureStats.total} 件中 ${failureStats.top.count} 件は「${failureStats.top.hint}」で落ちています。\n` +
          `先に設定を直してから実行することをおすすめします。`;
      }
    }

    const ok = window.confirm(
      `${count} 枚の領収書を AI OCR にかけて自動仕訳します。\n\n` +
        `Claude API への画像送信が ${count} 回発生します (ライセンスキーの月次使用量を消費)。${warnMsg}\n\n` +
        `続行しますか?`
    );
    if (!ok) return;

    setJournalizing(true);
    setProgress({ done: 0, total: 0 });
    try {
      // ㉱ Round 13: per-item の結果を直近ラベルとしてライブ更新
      const result = await autoJournalizeAllReceipts((done, total, lastItem) => {
        let lastLabel: string | undefined;
        let lastOk: boolean | undefined;
        if (lastItem) {
          lastOk = lastItem.ok;
          if (lastItem.ok) {
            const v = lastItem.vendor || "(店名不明)";
            const a = typeof lastItem.amount === "number" ? `¥${lastItem.amount.toLocaleString()}` : "";
            lastLabel = `✓ ${v} ${a}`.trim();
          } else {
            lastLabel = `✗ ${lastItem.error?.slice(0, 50) ?? "失敗"}`;
          }
        }
        setProgress({ done, total, lastLabel, lastOk });
      });
      if (result.imported > 0) {
        toast.success(
          `${result.imported} 件を自動仕訳しました${
            result.failed > 0 ? ` (失敗 ${result.failed} 件)` : ""
          }`
        );
      } else if (result.total === 0) {
        toast.info("領収書状態の写真がありません");
      } else {
        toast.error(`全 ${result.failed} 件失敗: ${result.errors[0] ?? ""}`);
      }
      await refresh();
    } catch (e) {
      toast.error(`自動仕訳に失敗: ${(e as Error).message}`);
    } finally {
      setJournalizing(false);
      setProgress(null);
    }
  };

  const handleScan = async () => {
    if (scanning) return;
    setScanning(true);
    // ㊀ Round 16: スキャン中も per-photo の進捗を progress ライブバナーで表示
    setProgress({ done: 0, total: 0 });
    // ㊅ Round 17: AbortController を準備、キャンセルボタンに紐付け
    const controller = new AbortController();
    scanAbortRef.current = controller;
    try {
      const result = await scanNow(
        "manual",
        undefined,
        (done, total, item) => {
          let lastLabel: string | undefined;
          let lastOk: boolean | undefined;
          if (item) {
            lastOk = item.state === "receipt";
            const v = item.vendorHint || "(候補テキストなし)";
            const s =
              item.score !== null && item.score !== undefined
                ? ` score ${item.score.toFixed(2)}`
                : "";
            lastLabel = `${item.state === "receipt" ? "✓" : "·"} ${v}${s}`;
          }
          setProgress({ done, total, lastLabel, lastOk });
        },
        controller.signal,
      );
      if (result.errors[0] === "user_cancelled") {
        toast.info(`キャンセルされました (新規 ${result.newPhotos} 枚は保存済み)`);
      }
      if (result.newPhotos > 0) {
        const receiptMsg = result.receiptCount > 0
          ? ` (うち領収書 ${result.receiptCount} 枚)`
          : "";
        // Round 7 ㊑: 自動破棄件数があれば併記 (学習効果を見える化)
        const autoMsg = result.autoDismissed && result.autoDismissed > 0
          ? ` / 過去パターンと類似で ${result.autoDismissed} 枚を自動破棄`
          : "";
        // Round 23: 厳格フィルタで弾いた件数も併記 (透明性 — どれだけ弾いたか分かる)
        const skipMsg = result.skipped && result.skipped > 0
          ? ` / 明らかに対象外 ${result.skipped} 枚は除外`
          : "";
        // Round 23 ⓐ: 重複統合した件数
        const dupMsg = result.duplicate && result.duplicate > 0
          ? ` / 重複 ${result.duplicate} 枚を統合`
          : "";
        toast.success(
          `新規 ${result.newPhotos} 枚を取り込みました${receiptMsg}${autoMsg}${skipMsg}${dupMsg}`,
        );
      } else if (result.scanned === 0) {
        toast.info("新規の写真はありませんでした");
      } else if (result.skipped && result.skipped > 0) {
        toast.info(
          `${result.scanned} 枚スキャン: 明らかに対象外 ${result.skipped} 枚を除外、新規はありません`,
        );
      } else {
        toast.info(`${result.scanned} 枚スキャン (新規はありません)`);
      }
      await refresh();
    } catch (e) {
      toast.error(`スキャン失敗: ${(e as Error).message}`);
    } finally {
      setScanning(false);
      setProgress(null);
      scanAbortRef.current = null;
    }
  };

  // ㊅ Round 17: スキャンを中断 (現在処理中の photo は完走、その後ループ抜け)
  const handleCancelScan = () => {
    if (scanAbortRef.current) {
      scanAbortRef.current.abort();
      toast.info("キャンセル中... (現在処理中の写真は完走させます)");
    }
  };

  const markReceipt = async (id: string) => {
    await setInboxState(id, "receipt");
    await refresh();
  };
  const markNotReceipt = async (id: string) => {
    await setInboxState(id, "not_receipt");
    await refresh();
  };
  const dismiss = async (id: string) => {
    await setInboxState(id, "dismissed");
    await refresh();
  };
  // ③ 逆操作: 破棄 / 違う / 失敗 → 領収書 候補に戻す
  const restoreToCandidate = async (id: string) => {
    await setInboxState(id, "candidate");
    await refresh();
  };
  const retryFailed = async (id: string) => {
    await resetFailedToReceipt(id);
    toast.success("再試行待ち (state=領収書) に戻しました");
    await refresh();
  };
  const retryAllFailed = async () => {
    const n = await resetAllFailedToReceipt();
    if (n === 0) {
      toast.info("失敗状態の写真がありません");
    } else {
      toast.success(`${n} 件を再試行待ちに戻しました。「領収書をすべて自動仕訳」で再実行してください`);
    }
    await refresh();
  };

  // ㉜ Round 9: マルチ選択ヘルパ + bulk action
  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAllVisible = () => {
    setSelected(new Set(items.map((it) => it.id)));
  };
  const clearSelection = () => setSelected(new Set());

  // 一括判定: 選択中の photo_inbox 行を 1 クエリで update する
  const bulkSetState = async (state: InboxState) => {
    if (selected.size === 0) {
      toast.info("選択された写真がありません");
      return;
    }
    const ids = Array.from(selected);
    try {
      // photo_inbox.id IN (...) で一括更新
      await db.from("photo_inbox").update({ state }).in("id", ids);
      toast.success(`${ids.length} 件を「${state}」に変更しました`);
      clearSelection();
      await refresh();
    } catch (e) {
      toast.error(`一括変更に失敗: ${(e as Error).message}`);
    }
  };

  // Round 27 ⓓ: 選択した写真をまとめて Vision OCR 再実行
  // Round 28 ⓖ: 件数が多いと数十秒かかるので進捗バーをライブ表示する
  const bulkReocr = async () => {
    if (selected.size === 0) {
      toast.info("選択された写真がありません");
      return;
    }
    if (bulkReocrProgress) return; // 二重起動防止
    const ids = Array.from(selected);
    let ok = 0;
    let fail = 0;
    setBulkReocrProgress({ done: 0, total: ids.length, ok: 0, fail: 0 });
    try {
      for (let i = 0; i < ids.length; i++) {
        try {
          await reocrInboxRow(ids[i], { twoPass: false });
          ok++;
        } catch (e) {
          console.warn(`bulkReocr ${ids[i]} failed:`, e);
          fail++;
        }
        setBulkReocrProgress({ done: i + 1, total: ids.length, ok, fail });
      }
    } finally {
      setBulkReocrProgress(null);
    }
    if (fail === 0) {
      toast.success(`${ok} 件を再 OCR しました`);
    } else {
      toast.info(`${ok} 件成功 / ${fail} 件失敗`);
    }
    clearSelection();
    await refresh();
  };

  // ㉵ Round 14 + ㉺ Round 15: 受信箱の 1 件を Vision で再 OCR
  // モード選択: 既定 (ja+en 同時) / ja-only / en-only / two-pass (独立結合)
  const [reocrModalFor, setReocrModalFor] = useState<string | null>(null);

  const reocrOne = async (
    inboxId: string,
    mode: "default" | "ja" | "en" | "two-pass",
  ) => {
    if (reocrInProgress) return;
    setReocrInProgress(inboxId);
    try {
      const res = await reocrInboxRow(inboxId, {
        twoPass: mode === "two-pass",
        lang: mode === "ja" ? "ja" : mode === "en" ? "en" : undefined,
      });
      toast.success(
        `再 OCR 完了 (${mode}) — score ${res.score?.toFixed(2) ?? "-"} / state ${res.state}`,
      );
      await refresh();
    } catch (e) {
      toast.error(`再 OCR 失敗: ${(e as Error).message}`);
    } finally {
      setReocrInProgress(null);
      setReocrModalFor(null);
    }
  };

  // ⓓ クイック確定: 1 クリックで AI OCR → receipt + journal 作成
  // Round 6 ㊋: BlockedByPattern (license/consent エラーが 2 件以上連続) は
  // 個別 modal で「設定を開く」を促し、それ以外のエラーは普通の toast.error
  const quickConfirm = async (inboxId: string) => {
    if (quickConfirming) return;
    setQuickConfirming(inboxId);
    try {
      await quickConfirmOne(inboxId);
      toast.success("仕訳化しました — 仕訳帳で確認できます");
    } catch (e) {
      if (e instanceof BlockedByPattern) {
        const open = window.confirm(
          `仕訳化を止めました。\n\n${e.hint}\n\n` +
            `「OK」で AI OCR の設定画面を開きます。`,
        );
        if (open) router.push("/settings");
      } else {
        toast.error(`仕訳化に失敗: ${(e as Error).message}`);
      }
    } finally {
      setQuickConfirming(null);
      await refresh();
    }
  };

  const isAuthorized = auth === "authorized" || auth === "limited";

  return (
    <div className="space-y-6">
      {/* Round 28: Gemini Free Tier 上限超過バナー (該当時のみ表示) */}
      <AiOcrQuotaBanner />
      {/* ㉺ Round 15: 再 OCR モード選択モーダル */}
      {reocrModalFor && (
        <div
          className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4"
          onClick={() => setReocrModalFor(null)}
        >
          <div
            className="bg-card border rounded-lg shadow-2xl max-w-sm w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold mb-2">再 OCR モードを選択</h2>
            <p className="text-xs text-muted-foreground mb-4">
              Vision で再認識します。日英混在の領収書なら two-pass、純粋な
              英字メニューなら en-only が精度高めです。
            </p>
            <div className="space-y-2">
              <Button
                size="sm"
                variant="default"
                onClick={() => reocrOne(reocrModalFor, "default")}
                disabled={!!reocrInProgress}
                className="w-full justify-start"
              >
                <ScanText className="h-4 w-4 mr-2" />
                ja + en (既定) — 速い、混在テキストで標準
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => reocrOne(reocrModalFor, "ja")}
                disabled={!!reocrInProgress}
                className="w-full justify-start"
              >
                <ScanText className="h-4 w-4 mr-2" />
                ja-only — 純日本語の領収書
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => reocrOne(reocrModalFor, "en")}
                disabled={!!reocrInProgress}
                className="w-full justify-start"
              >
                <ScanText className="h-4 w-4 mr-2" />
                en-only — 英字メニュー / 海外領収書
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => reocrOne(reocrModalFor, "two-pass")}
                disabled={!!reocrInProgress}
                className="w-full justify-start"
              >
                <ScanText className="h-4 w-4 mr-2" />
                two-pass — 両言語独立 OCR を結合 (約 2 倍遅い)
              </Button>
            </div>
            <div className="mt-4 text-right">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setReocrModalFor(null)}
                disabled={!!reocrInProgress}
              >
                キャンセル
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ㉧ Round 11: ?ヘルプモーダル */}
      {helpOpen && (
        <div
          className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4"
          onClick={() => setHelpOpen(false)}
        >
          <div
            className="bg-card border rounded-lg shadow-2xl max-w-md w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold mb-3">キーボードショートカット</h2>
            <table className="w-full text-sm">
              <tbody>
                {[
                  ["↑↓ / j k", "フォーカス移動"],
                  ["A", "領収書として確定"],
                  ["X", "違う"],
                  ["D", "破棄"],
                  ["R", "未判定に戻す"],
                  ["S", "選択 (チェック) トグル"],
                  ["Space", "プレビュー toggle"],
                  ["Enter", "登録 / クイック確定"],
                  ["/", "検索フォーカス"],
                  ["?", "このヘルプ"],
                  ["Esc", "選択解除 / 閉じる"],
                ].map(([k, v]) => (
                  <tr key={k} className="border-b last:border-b-0">
                    <td className="py-1.5 pr-3 font-mono text-xs">{k}</td>
                    <td className="py-1.5 text-muted-foreground">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-muted-foreground mt-3">
              入力欄にフォーカスがある時は無効。Cmd/Ctrl + キーは普通通り動きます。
            </p>
            <div className="mt-4 text-right">
              <Button size="sm" variant="outline" onClick={() => setHelpOpen(false)}>
                閉じる (Esc)
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ㊌ Round 6: hover preview pane — 右上に固定。マウスがカード外に出ても
          少し残り、その間に preview 自体に hover すれば消えない。 */}
      {hovered && (
        <HoverPreview
          row={hovered}
          side={previewSide}
          onMouseEnter={() => {
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
          }}
          onMouseLeave={handleHoverLeave}
        />
      )}

      {/* Round 28 ⓖ: bulk 再 OCR 進捗バー (上中央に固定表示) */}
      {bulkReocrProgress && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[min(420px,90vw)]
                        bg-card border-2 border-primary shadow-2xl rounded-lg px-4 py-3">
          <div className="flex items-center justify-between text-sm mb-1.5">
            <span className="font-medium inline-flex items-center gap-1.5">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              再 OCR 中… {bulkReocrProgress.done} / {bulkReocrProgress.total} 件
            </span>
            <span className="text-xs text-muted-foreground">
              成功 {bulkReocrProgress.ok}
              {bulkReocrProgress.fail > 0 && (
                <span className="text-red-600"> / 失敗 {bulkReocrProgress.fail}</span>
              )}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-200"
              style={{
                width: `${Math.round((bulkReocrProgress.done / Math.max(1, bulkReocrProgress.total)) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* ㉜ Round 9: bulk action bar — selection が 1 件以上で下中央に固定表示 */}
      {selected.size > 0 && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50
                     bg-card border-2 border-primary shadow-2xl rounded-full
                     px-4 py-2 flex items-center gap-2 text-sm"
        >
          <Badge variant="default" className="font-mono">
            {selected.size} 件選択中
          </Badge>
          <Button size="sm" variant="default" onClick={() => bulkSetState("receipt")}>
            <Check className="h-3.5 w-3.5 mr-1" />
            領収書
          </Button>
          <Button size="sm" variant="outline" onClick={() => bulkSetState("not_receipt")}>
            <XIcon className="h-3.5 w-3.5 mr-1" />
            違う
          </Button>
          <Button size="sm" variant="outline" onClick={() => bulkSetState("dismissed")}>
            <Trash2 className="h-3.5 w-3.5 mr-1" />
            破棄
          </Button>
          <Button size="sm" variant="outline" onClick={() => bulkSetState("candidate")} title="未判定に戻す">
            <RotateCcw className="h-3.5 w-3.5 mr-1" />
            未判定
          </Button>
          {/* Round 27 ⓓ: 選択写真を一括 Vision 再 OCR */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void bulkReocr()}
            disabled={!!bulkReocrProgress}
            title="選択した写真を Vision OCR で再認識"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${bulkReocrProgress ? "animate-spin" : ""}`} />
            再 OCR
          </Button>
          <span className="mx-1 h-4 w-px bg-border" />
          <Button size="sm" variant="ghost" onClick={selectAllVisible} title="表示中の全件を選択">
            全選択
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection}>
            選択解除
          </Button>
        </div>
      )}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <InboxIcon className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">写真受信箱</h1>
            <p className="text-sm text-muted-foreground">
              iCloud 写真から文書検出 + キーワード判定で抽出した領収書候補
            </p>
            {/* ㉢ Round 10 + ㉧ Round 11: キーボードショートカットヒント */}
            <p className="text-[10px] text-muted-foreground/80 mt-1 font-mono">
              ↑↓: 移動 / A: 領収書 / X: 違う / D: 破棄 / R: 未判定 / S: 選択 / /: 検索 / ?: ヘルプ
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href="/settings/photo-scan">
            <Button variant="outline" size="sm">
              <Settings className="h-4 w-4 mr-1" />
              設定
            </Button>
          </Link>
          <Button onClick={handleScan} disabled={scanning || !isAuthorized}>
            <RefreshCw className={`h-4 w-4 mr-1 ${scanning ? "animate-spin" : ""}`} />
            {scanning ? "スキャン中..." : "今すぐスキャン"}
          </Button>
          {/* Round 22 ⓒ: 全部既読化 (未確認バッジを一掃) */}
          {items.some((it) => it.state === "candidate" && !it.last_viewed_at) && (
            <Button
              variant="outline"
              onClick={handleMarkAllViewed}
              title="未確認カードをすべて既読化 (state は変えず last_viewed_at を更新)"
            >
              全部既読
            </Button>
          )}
          <Button
            variant="outline"
            onClick={handleDismissAllCandidates}
            title="state=未判定 の写真をすべて破棄状態にする"
          >
            <Trash2 className="h-4 w-4 mr-1" />
            未判定をまとめて破棄
          </Button>
          <Button
            variant="default"
            onClick={handleJournalizeAll}
            disabled={journalizing}
            title="state=領収書 の写真を AI OCR にかけて、receipts/journals を自動生成"
          >
            <Sparkles className={`h-4 w-4 mr-1 ${journalizing ? "animate-pulse" : ""}`} />
            {journalizing
              ? progress
                ? `仕訳化中 ${progress.done}/${progress.total}`
                : "仕訳化中..."
              : "領収書をすべて自動仕訳"}
          </Button>
        </div>
      </div>

      {/* Round 23 ⓖ: 直近スキャンのサマリーバー (取り込み・除外・重複の透明性) */}
      {lastScan &&
        (lastScan.scanned > 0 || lastScan.skipped > 0) && (
          <div className="flex items-center gap-3 text-xs px-3 py-2 rounded border bg-muted/30 text-muted-foreground">
            <span className="font-medium text-foreground">直近スキャン:</span>
            <span>
              取込 <b>{lastScan.newPhotos}</b>
            </span>
            {lastScan.receiptCount > 0 && (
              <span>
                / 領収書 <b>{lastScan.receiptCount}</b>
              </span>
            )}
            {lastScan.skipped > 0 && (
              <span>
                / 対象外 <b>{lastScan.skipped}</b> 枚を除外
              </span>
            )}
            {lastScan.duplicate > 0 && (
              <span>
                / 重複 <b>{lastScan.duplicate}</b> 枚を統合
              </span>
            )}
            <span className="ml-auto text-[10px]">
              {new Date(lastScan.finished_at).toLocaleString("ja-JP")}
            </span>
            <Link
              href="/settings/photo-scan"
              className="text-primary hover:underline text-[11px]"
            >
              設定
            </Link>
          </div>
        )}

      {/* ㉱ Round 13 + ㊀ Round 16: 仕訳化中 / スキャン中の最新 1 件をライブ表示。
          直前 1 件の店名/金額/score で「ちゃんと進んでいる」がひと目で分かる */}
      {(journalizing || scanning) && progress && progress.lastLabel && (
        <div
          className={`flex items-center gap-2 text-xs px-3 py-2 rounded border ${
            progress.lastOk === false
              ? "border-red-300 bg-red-50 text-red-900"
              : "border-emerald-300 bg-emerald-50 text-emerald-900"
          }`}
        >
          <span className="font-mono tabular-nums">
            [{progress.done}/{progress.total}]
          </span>
          <span className="flex-1 truncate">{progress.lastLabel}</span>
          {/* ㊅ Round 17: scan 実行中のみキャンセルボタン (journalize には未対応) */}
          {scanning && scanAbortRef.current && (
            <button
              type="button"
              onClick={handleCancelScan}
              className="text-xs px-2 py-0.5 rounded border border-current hover:bg-white/50"
            >
              キャンセル
            </button>
          )}
        </div>
      )}

      {!isAuthorized && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="pt-6 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="space-y-2 flex-1">
              <p className="text-sm">
                写真ライブラリへのアクセスが許可されていません (status:{" "}
                <code className="bg-white px-1 rounded">{auth}</code>)
              </p>
              <p className="text-xs text-muted-foreground">
                設定ページからアクセス権を許可してください。許可しなくても、
                ドラッグ&ドロップやスマホ取込からの登録はそのまま使えます。
              </p>
              <div>
                <Link href="/settings/photo-scan">
                  <Button size="sm" variant="outline">
                    <Settings className="h-3.5 w-3.5 mr-1" />
                    アクセスを許可する
                  </Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2 flex-wrap items-center">
        {[
          { key: "candidate", label: "未判定" },
          { key: "receipt", label: "領収書" },
          { key: "imported", label: "取り込み済" },
          { key: "receipt_failed", label: "失敗" },
          { key: "not_receipt", label: "違う" },
          { key: "dismissed", label: "破棄" },
          { key: "all", label: "すべて" },
        ].map((f) => {
          const k = f.key as InboxState | "all";
          const c = counts[k] ?? 0;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(k)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                filter === f.key
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background hover:bg-muted"
              }`}
            >
              {f.label}
              <span className="ml-1.5 opacity-70 tabular-nums">{c}</span>
            </button>
          );
        })}
        {counts.receipt_failed > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={retryAllFailed}
            className="ml-2 h-7 text-xs"
            title="失敗 を全部 領収書 状態に戻して、再度自動仕訳できるようにする"
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1" />
            失敗をまとめて再試行待ちに戻す
          </Button>
        )}
      </div>

      {/* ㉞ Round 9: 検索バー — トグルで開閉、入力で即フィルタ */}
      <div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowSearch((s) => !s)}
          className="text-xs"
        >
          <Search className="h-3.5 w-3.5 mr-1" />
          検索 {(searchQ || searchFrom || searchTo) ? "(条件あり)" : ""}
        </Button>
        {showSearch && (
          <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2">
            <Input
              ref={searchInputRef}
              placeholder="OCR テキストで検索 (例: スターバックス)"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
            />
            <Input
              type="date"
              value={searchFrom}
              onChange={(e) => setSearchFrom(e.target.value)}
              placeholder="撮影日 開始"
            />
            <Input
              type="date"
              value={searchTo}
              onChange={(e) => setSearchTo(e.target.value)}
              placeholder="撮影日 終了"
            />
            {(searchQ || searchFrom || searchTo) && (
              <button
                type="button"
                onClick={() => {
                  setSearchQ("");
                  setSearchFrom("");
                  setSearchTo("");
                }}
                className="text-xs text-muted-foreground hover:text-foreground underline col-span-full justify-self-start"
              >
                条件をクリア
              </button>
            )}
          </div>
        )}
      </div>

      {/* ㊁ 失敗パターンの一行ヒント (top バケットだけ目立たせる).
          原因が偏っている時は「再試行を勧める」より「設定を直しに行く」を促す。 */}
      {failureStats && failureStats.top && failureStats.top.count >= 2 && (
        <div className="flex items-start gap-2 text-xs px-3 py-2 rounded border border-amber-200 bg-amber-50 text-amber-900">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <span className="font-medium">失敗 {failureStats.total} 件中 {failureStats.top.count} 件は同じ原因:</span>{" "}
            {failureStats.top.hint}
          </div>
        </div>
      )}

      {/* Round 28 ⓒ: 失敗タブで failure bucket 別件数 (破棄タブの reason 別と同パターン) */}
      {filter === "receipt_failed" && (() => {
        const BUCKET_LABEL: Record<FailureBucket, string> = {
          quota: "本日枠超過",
          license: "ライセンス",
          consent: "未同意",
          network: "ネットワーク",
          image: "画像読込",
          server: "サーバー",
          unknown: "原因不明",
        };
        const byBucket: Record<FailureBucket, number> = {
          quota: 0, license: 0, consent: 0, network: 0, image: 0, server: 0, unknown: 0,
        };
        for (const it of items) {
          byBucket[classifyOcrError(it.last_error).bucket]++;
        }
        const order: FailureBucket[] = ["quota", "license", "consent", "network", "server", "image", "unknown"];
        const hasAny = order.some((b) => byBucket[b] > 0);
        if (!hasAny) return null;
        return (
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            <span className="text-foreground">原因別:</span>
            {order.map((b) => {
              const n = byBucket[b];
              if (n === 0) return null;
              const active = failureBucketFilter === b;
              return (
                <button
                  key={b}
                  type="button"
                  onClick={() => setFailureBucketFilter((prev) => (prev === b ? null : b))}
                  className="inline-flex"
                  aria-pressed={active}
                >
                  <Badge
                    variant={active ? "default" : "outline"}
                    className={`text-[10px] cursor-pointer ${active ? "" : "hover:bg-muted"}`}
                    title={active ? `${BUCKET_LABEL[b]}フィルタを解除` : `${BUCKET_LABEL[b]}だけ表示 (クリック)`}
                  >
                    {BUCKET_LABEL[b]} {n}
                  </Badge>
                </button>
              );
            })}
            {failureBucketFilter && (
              <button
                type="button"
                onClick={() => setFailureBucketFilter(null)}
                className="text-[10px] text-muted-foreground hover:text-foreground underline"
              >
                解除
              </button>
            )}
          </div>
        );
      })()}

      {/* Round 24 ⓖ: 破棄タブだけ「期限切れ自動破棄のみ」フィルタを出す
          Round 25 ⓑ: reason 別件数バッジ */}
      {filter === "dismissed" && (() => {
        // reason 別集計
        let expired = 0;
        let duplicate = 0;
        let pattern = 0;
        let manual = 0;
        for (const it of items) {
          if (!it.auto_dismissed_reason) {
            manual++;
            continue;
          }
          try {
            const r = JSON.parse(it.auto_dismissed_reason) as { reason?: string };
            if (r.reason === "expired_30d") expired++;
            else if (r.reason === "duplicate") duplicate++;
            else if (r.reason === "pattern" || r.reason === undefined) pattern++;
            else pattern++;
          } catch {
            manual++;
          }
        }
        return (
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={expiredOnly}
                onChange={(e) => setExpiredOnly(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              30 日経過で自動破棄されたもののみ表示
            </label>
            <span className="text-foreground">理由別:</span>
            {/* Round 26 ⓑ: クリックで個別フィルタ toggle (active 時は塗りつぶし) */}
            {([
              ["expired_30d", "期限切れ", expired],
              ["duplicate", "重複", duplicate],
              ["pattern", "過去類似", pattern],
              ["manual", "手動", manual],
            ] as const).map(([key, label, n]) => {
              if (n === 0) return null;
              const active = reasonFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() =>
                    setReasonFilter((prev) => (prev === key ? null : key))
                  }
                  className="inline-flex"
                  aria-pressed={active}
                >
                  <Badge
                    variant={active ? "default" : "outline"}
                    className={`text-[10px] cursor-pointer ${
                      active ? "" : "hover:bg-muted"
                    }`}
                    title={
                      active
                        ? `${label}フィルタを解除`
                        : `${label}だけ表示 (クリック)`
                    }
                  >
                    {label} {n}
                  </Badge>
                </button>
              );
            })}
            {reasonFilter && (
              <button
                type="button"
                onClick={() => setReasonFilter(null)}
                className="text-[10px] text-muted-foreground hover:text-foreground underline"
              >
                解除
              </button>
            )}
            {/* Round 27 ⓑ: フィルタ中のものを一括 candidate に戻す */}
            {(reasonFilter || expiredOnly) && (
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  // 現在 visible な dismissed (= フィルタ後) の id を集める
                  const matchReason = (it: InboxRow, want: string): boolean => {
                    if (!it.auto_dismissed_reason) return want === "manual";
                    try {
                      const p = JSON.parse(it.auto_dismissed_reason) as { reason?: string };
                      const r = p.reason ?? "pattern";
                      if (want === "manual") return false;
                      if (want === "pattern") return r !== "expired_30d" && r !== "duplicate";
                      return r === want;
                    } catch {
                      return want === "manual";
                    }
                  };
                  const want = expiredOnly ? "expired_30d" : (reasonFilter ?? "");
                  const targets = items.filter((it) => matchReason(it, want));
                  if (targets.length === 0) return;
                  if (
                    !confirm(
                      `${targets.length} 件を「未判定」に戻します。よろしいですか?`,
                    )
                  )
                    return;
                  let restored = 0;
                  for (const it of targets) {
                    try {
                      await db
                        .from("photo_inbox")
                        .update({ state: "candidate", auto_dismissed_reason: null })
                        .eq("id", it.id);
                      restored++;
                    } catch {
                      /* silent */
                    }
                  }
                  toast.success(`${restored} 件を未判定に戻しました`);
                  await refresh();
                }}
                className="h-7 text-xs"
              >
                フィルタ中をすべて未判定に戻す
              </Button>
            )}
            {/* Round 26 ⓕ: 最終 purge 日時 (90 日経過 dismissed の物理削除) */}
            {lastPurgeUnix && (
              <span className="ml-auto text-[10px] text-muted-foreground">
                最終物理削除: {new Date(lastPurgeUnix * 1000).toLocaleString("ja-JP")}
              </span>
            )}
          </div>
        );
      })()}

      {(() => {
        // Round 24 ⓖ + Round 26 ⓑ: dismissed タブで reason 別フィルタを適用
        const matchReason = (it: InboxRow, want: string): boolean => {
          if (!it.auto_dismissed_reason) {
            return want === "manual";
          }
          try {
            const parsed = JSON.parse(it.auto_dismissed_reason) as {
              reason?: string;
            };
            const r = parsed.reason ?? "pattern";
            if (want === "manual") return false;
            if (want === "pattern") return r !== "expired_30d" && r !== "duplicate";
            return r === want;
          } catch {
            return want === "manual";
          }
        };
        let visible =
          filter === "dismissed" && (expiredOnly || reasonFilter)
            ? items.filter((it) => {
                if (expiredOnly) return matchReason(it, "expired_30d");
                if (reasonFilter) return matchReason(it, reasonFilter);
                return true;
              })
            : items;
        // Round 28 ⓒ: 失敗タブの bucket フィルタ
        if (filter === "receipt_failed" && failureBucketFilter) {
          visible = visible.filter(
            (it) => classifyOcrError(it.last_error).bucket === failureBucketFilter,
          );
        }
        return visible.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            <Camera className="h-10 w-10 mx-auto mb-3 opacity-30" />
            {filter === "candidate"
              ? "未判定の写真はありません。「今すぐスキャン」を押すと最近の写真を取り込みます。"
              : filter === "dismissed" && expiredOnly
                ? "30 日経過で自動破棄された写真はありません。"
                : "該当する写真はありません。"}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {visible.map((it, idx) => (
            <InboxCard
              key={it.id}
              row={it}
              quickConfirming={quickConfirming === it.id}
              reocring={reocrInProgress === it.id}
              isSelected={selected.has(it.id)}
              isFocused={focusIdx === idx}
              onToggleSelected={() => toggleSelected(it.id)}
              onHoverEnter={(e) => {
                handleHoverEnter(it, e);
                // Round 21 ⓑ: hover で last_viewed_at を更新 (未確認バッジを消す)
                if (!it.last_viewed_at) {
                  void markInboxViewed(it.id);
                  // ローカル状態にも即反映 (UI のバッジが即消える)
                  setItems((prev) =>
                    prev.map((p) =>
                      p.id === it.id ? { ...p, last_viewed_at: new Date().toISOString() } : p,
                    ),
                  );
                }
              }}
              onHoverLeave={handleHoverLeave}
              onMarkReceipt={() => markReceipt(it.id)}
              onMarkNotReceipt={() => markNotReceipt(it.id)}
              onDismiss={() => dismiss(it.id)}
              onRestore={() => restoreToCandidate(it.id)}
              onRetryFailed={() => retryFailed(it.id)}
              onQuickConfirm={() => quickConfirm(it.id)}
              onReocr={(twoPass) => {
                if (twoPass) {
                  // ショートカット: Shift+クリックで two-pass 即発火
                  void reocrOne(it.id, "two-pass");
                } else {
                  setReocrModalFor(it.id);
                }
              }}
              onOpenForReceipt={() => {
                router.push(`/receipts/new?inbox=${it.id}`);
              }}
            />
          ))}
        </div>
        );
      })()}
    </div>
  );
}

