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
  ArrowRight,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { db } from "@/lib/localDb";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  scanNow,
  listInbox,
  setInboxState,
  getAuthStatus,
  type AuthStatus,
  type InboxRow,
} from "@/lib/photo-scanner";
import { classifyReceiptLines, type LineKind } from "@/lib/receipt-classifier";
import {
  autoJournalizeAllReceipts,
  getAutoJournalMode,
  quickConfirmOne,
  resetFailedToReceipt,
  resetAllFailedToReceipt,
  getFailureStats,
  BlockedByPattern,
  type FailureStats,
} from "@/lib/auto-journal";
import { Sparkles } from "lucide-react";
import { toast } from "@/lib/toast";

type InboxState = InboxRow["state"];

export default function InboxPage() {
  const router = useRouter();
  const [items, setItems] = useState<InboxRow[]>([]);
  const [auth, setAuth] = useState<AuthStatus>("unknown");
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState<InboxState | "all">("candidate");
  const [, setAutoMode] = useState(false);
  const [journalizing, setJournalizing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // ⓓ クイック確定中の inbox.id を持っておく (カード単位の押下中表示)
  const [quickConfirming, setQuickConfirming] = useState<string | null>(null);

  // ㊌ hover preview ハンドラ: enter で 250ms 後に表示、leave で 100ms 後に消す
  const handleHoverEnter = (row: InboxRow) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
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
  // ㊁ 失敗パターン集計 (top バケットを「失敗」タブの近くにヒント表示)
  const [failureStats, setFailureStats] = useState<FailureStats | null>(null);
  // ㊌ Round 6: hover プレビュー対象 (右側 pane に拡大画像 + OCR を表示)
  const [hovered, setHovered] = useState<InboxRow | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    setItems(await listInbox(filter === "all" ? undefined : filter));
    setAutoMode(await getAutoJournalMode());
    // 件数バッジ: 状態ごとに件数を取得
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
  }, [filter]);

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
      `${count} 枚の領収書を Claude OCR にかけて自動仕訳します。\n\n` +
        `Claude API への画像送信が ${count} 回発生します (ライセンスキーの月次使用量を消費)。${warnMsg}\n\n` +
        `続行しますか?`
    );
    if (!ok) return;

    setJournalizing(true);
    setProgress({ done: 0, total: 0 });
    try {
      const result = await autoJournalizeAllReceipts((done, total) =>
        setProgress({ done, total })
      );
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
    try {
      const result = await scanNow("manual");
      if (result.newPhotos > 0) {
        const receiptMsg = result.receiptCount > 0
          ? ` (うち領収書 ${result.receiptCount} 枚)`
          : "";
        // Round 7 ㊑: 自動破棄件数があれば併記 (学習効果を見える化)
        const autoMsg = result.autoDismissed && result.autoDismissed > 0
          ? ` / 過去パターンと類似で ${result.autoDismissed} 枚を自動破棄`
          : "";
        toast.success(`新規 ${result.newPhotos} 枚を取り込みました${receiptMsg}${autoMsg}`);
      } else if (result.scanned === 0) {
        toast.info("新規の写真はありませんでした");
      } else {
        toast.info(`${result.scanned} 枚スキャン (新規はありません)`);
      }
      await refresh();
    } catch (e) {
      toast.error(`スキャン失敗: ${(e as Error).message}`);
    } finally {
      setScanning(false);
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

  // ⓓ クイック確定: 1 クリックで Claude OCR → receipt + journal 作成
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
      {/* ㊌ Round 6: hover preview pane — 右上に固定。マウスがカード外に出ても
          少し残り、その間に preview 自体に hover すれば消えない。 */}
      {hovered && (
        <HoverPreview
          row={hovered}
          onMouseEnter={() => {
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
          }}
          onMouseLeave={handleHoverLeave}
        />
      )}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <InboxIcon className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">写真受信箱</h1>
            <p className="text-sm text-muted-foreground">
              iCloud 写真から文書検出 + キーワード判定で抽出した領収書候補
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
            title="state=領収書 の写真を Claude OCR にかけて、receipts/journals を自動生成"
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

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            <Camera className="h-10 w-10 mx-auto mb-3 opacity-30" />
            {filter === "candidate"
              ? "未判定の写真はありません。「今すぐスキャン」を押すと最近の写真を取り込みます。"
              : "該当する写真はありません。"}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {items.map((it) => (
            <InboxCard
              key={it.id}
              row={it}
              quickConfirming={quickConfirming === it.id}
              onHoverEnter={() => handleHoverEnter(it)}
              onHoverLeave={handleHoverLeave}
              onMarkReceipt={() => markReceipt(it.id)}
              onMarkNotReceipt={() => markNotReceipt(it.id)}
              onDismiss={() => dismiss(it.id)}
              onRestore={() => restoreToCandidate(it.id)}
              onRetryFailed={() => retryFailed(it.id)}
              onQuickConfirm={() => quickConfirm(it.id)}
              onOpenForReceipt={() => {
                router.push(`/receipts/new?inbox=${it.id}`);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function InboxCard({
  row,
  quickConfirming,
  onHoverEnter,
  onHoverLeave,
  onMarkReceipt,
  onMarkNotReceipt,
  onDismiss,
  onRestore,
  onRetryFailed,
  onQuickConfirm,
  onOpenForReceipt,
}: {
  row: InboxRow;
  quickConfirming: boolean;
  onHoverEnter: () => void;
  onHoverLeave: () => void;
  onMarkReceipt: () => void;
  onMarkNotReceipt: () => void;
  onDismiss: () => void;
  onRestore: () => void;
  onRetryFailed: () => void;
  onQuickConfirm: () => void;
  onOpenForReceipt: () => void;
}) {
  // 画像表示は plugin-fs で生バイトを読んで Blob URL 化する。
  // asset:// 経由だとパスのスペース展開や HEIC の MIME 判定で
  // 詰まるケースが多いので、file 直読み + MIME 検出で確実にする。
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!row.file_path) return;
    let cancelled = false;
    let createdUrl: string | null = null;
    void (async () => {
      try {
        const { resolveLocalImageUrl } = await import("@/lib/localDb");
        const url = await resolveLocalImageUrl(row.file_path);
        if (cancelled) {
          if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
          return;
        }
        createdUrl = url;
        setSrc(url);
      } catch {
        // 失敗してもグリッド全体を壊さないよう静かに ?
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl && createdUrl.startsWith("blob:")) URL.revokeObjectURL(createdUrl);
    };
  }, [row.file_path]);

  return (
    <Card
      className="overflow-hidden flex flex-col"
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
    >
      <div className="aspect-[4/3] bg-muted relative">
        {src ? (
          <img src={src} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
            画像読み込み中...
          </div>
        )}
        {row.receipt_score !== null && (
          <Badge
            variant="secondary"
            className="absolute top-2 right-2 text-[10px] font-mono"
          >
            score {row.receipt_score.toFixed(2)}
          </Badge>
        )}
        <Badge variant="outline" className="absolute top-2 left-2 text-[10px] bg-background/80 backdrop-blur-sm">
          {row.state}
        </Badge>
      </div>
      <CardContent className="p-3 space-y-2 flex-1 flex flex-col">
        <div className="text-xs text-muted-foreground">
          {row.taken_at ? new Date(row.taken_at).toLocaleString("ja-JP") : "-"}
        </div>
        {row.ocr_text ? (
          <details className="text-[11px] text-muted-foreground leading-tight">
            <summary className="line-clamp-2 cursor-pointer hover:text-foreground">
              {row.ocr_text.slice(0, 60)}
            </summary>
            {/* ⓔ rich preview: 行単位で色分け (金額・合計・日付・時刻・インボイス番号・店名) */}
            <RichOcrPreview text={row.ocr_text} />
          </details>
        ) : (
          <div className="text-[11px] text-muted-foreground italic">
            (OCR テキストなし)
          </div>
        )}
        {row.state === "receipt_failed" && row.last_error && (
          // 失敗理由は受信箱でその場で見せる (設定 → ログまで掘らせない)
          <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded p-1.5 leading-tight">
            <span className="font-medium">エラー:</span> {row.last_error}
            {typeof row.attempts === "number" && row.attempts > 0 && (
              <span className="ml-1 text-red-500/80">({row.attempts}回失敗)</span>
            )}
          </div>
        )}
        {row.state === "dismissed" && row.auto_dismissed_reason && (
          // ㊗ Round 8: 自動破棄なら「なぜ消えたか」を見せる
          <AutoDismissReasonView reasonJson={row.auto_dismissed_reason} />
        )}
        {row.state === "imported" && row.imported_receipt_id && (
          // 取り込み済の場合: 関連する受領書 / 仕訳に飛べるリンクを軽く出す
          <div className="text-[11px] text-emerald-700">
            <Link
              href={`/receipts`}
              className="underline hover:text-emerald-900"
              title="領収書一覧で確認"
            >
              → 領収書として登録済
            </Link>
          </div>
        )}
        <div className="flex flex-wrap gap-1 mt-auto pt-2">
          {row.state === "candidate" && (
            <>
              <Button size="sm" variant="default" onClick={onMarkReceipt} className="text-xs px-2 h-7">
                <Check className="h-3 w-3 mr-1" />
                領収書
              </Button>
              <Button size="sm" variant="outline" onClick={onMarkNotReceipt} className="text-xs px-2 h-7">
                <XIcon className="h-3 w-3 mr-1" />
                違う
              </Button>
            </>
          )}
          {row.state === "receipt" && (
            <Button size="sm" onClick={onOpenForReceipt} className="text-xs px-2 h-7 flex-1">
              <ArrowRight className="h-3 w-3 mr-1" />
              登録に進む
            </Button>
          )}
          {/* ⓓ クイック確定: candidate / receipt から 1 クリックで Claude OCR + 仕訳作成 */}
          {(row.state === "candidate" || row.state === "receipt") && (
            <Button
              size="sm"
              variant={row.state === "receipt" ? "outline" : "secondary"}
              onClick={onQuickConfirm}
              disabled={quickConfirming}
              className="text-xs px-2 h-7"
              title="このまま 1 クリックで AI OCR → 領収書 → 仕訳まで作成 (要ライセンスキー)"
            >
              <Sparkles className={`h-3 w-3 mr-1 ${quickConfirming ? "animate-pulse" : ""}`} />
              {quickConfirming ? "仕訳化中..." : "いますぐ仕訳化"}
            </Button>
          )}
          {row.state === "receipt_failed" && (
            <Button size="sm" variant="default" onClick={onRetryFailed} className="text-xs px-2 h-7">
              <RotateCcw className="h-3 w-3 mr-1" />
              再試行
            </Button>
          )}
          {(row.state === "not_receipt" || row.state === "candidate") && (
            <Button size="sm" variant="ghost" onClick={onDismiss} className="text-xs px-2 h-7">
              破棄
            </Button>
          )}
          {/* ③ 逆操作: 違う / 破棄 / 失敗 から「未判定」に戻すボタン (ワンクリック) */}
          {(row.state === "dismissed" ||
            row.state === "not_receipt" ||
            row.state === "receipt_failed") && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onRestore}
              className="text-xs px-2 h-7 text-muted-foreground hover:text-foreground"
              title="「未判定」に戻して、もう一度判定できるようにする"
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              未判定に戻す
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * ㊗ Round 8: 自動破棄ルールで dismissed になった理由を 1 行で表示する。
 * "学習で消したけど、間違いなら『未判定に戻す』で復活できる" という導線を
 * 視覚的に示す目的。中身は scanNow が JSON で書いた reason オブジェクト。
 */
function AutoDismissReasonView({ reasonJson }: { reasonJson: string }) {
  let parsed:
    | { similarity?: number; matched_keywords?: string[]; matched_past_snippet?: string }
    | null = null;
  try {
    parsed = JSON.parse(reasonJson);
  } catch {
    return null;
  }
  if (!parsed) return null;
  const sim = typeof parsed.similarity === "number" ? parsed.similarity : null;
  const kws = (parsed.matched_keywords ?? []).slice(0, 4);
  return (
    <div
      className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded p-1.5 leading-tight"
      title={parsed.matched_past_snippet ?? ""}
    >
      <span className="font-medium">自動破棄:</span> 過去パターンと類似
      {sim !== null && (
        <span className="ml-1 font-mono text-amber-700">({(sim * 100).toFixed(0)}%)</span>
      )}
      {kws.length > 0 && (
        <span className="block text-[10px] text-amber-700 mt-0.5">
          共通: {kws.join(" / ")}
        </span>
      )}
    </div>
  );
}

/**
 * ㊌ Round 6: 受信箱カードを hover した時に右上に出る大きめプレビュー。
 *
 * - 画像を 800x600 以下にフィットさせて拡大表示
 * - メタ (撮影日 / state / score) をその下に
 * - rich preview (色分け OCR) を更にその下に
 *
 * Pane 自体にも hover を効かせるため、onMouseEnter/Leave を上に bubble させて
 * 親側の hide タイマーをキャンセル/再開できるようにしている (狭いカードから
 * 移動しても消えない)。
 */
function HoverPreview({
  row,
  onMouseEnter,
  onMouseLeave,
}: {
  row: InboxRow;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!row.file_path) return;
    let cancelled = false;
    let createdUrl: string | null = null;
    void (async () => {
      try {
        const { resolveLocalImageUrl } = await import("@/lib/localDb");
        const url = await resolveLocalImageUrl(row.file_path);
        if (cancelled) {
          if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
          return;
        }
        createdUrl = url;
        setSrc(url);
      } catch {
        /* silent */
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl && createdUrl.startsWith("blob:")) URL.revokeObjectURL(createdUrl);
    };
  }, [row.file_path]);

  return (
    <div
      className="fixed top-20 right-6 w-[28rem] max-h-[80vh] overflow-y-auto z-50
                 bg-card border-2 border-primary/30 rounded-lg shadow-2xl p-3
                 pointer-events-auto"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="aspect-[4/3] bg-muted rounded mb-2 overflow-hidden">
        {src ? (
          <img src={src} alt="" className="w-full h-full object-contain" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
            読み込み中...
          </div>
        )}
      </div>
      <div className="text-xs flex items-center gap-2 mb-1">
        <Badge variant="outline">{row.state}</Badge>
        {row.receipt_score !== null && (
          <span className="font-mono text-muted-foreground">
            score {row.receipt_score.toFixed(2)}
          </span>
        )}
        <span className="text-muted-foreground ml-auto">
          {row.taken_at ? new Date(row.taken_at).toLocaleString("ja-JP") : "-"}
        </span>
      </div>
      {row.ocr_text ? (
        <RichOcrPreview text={row.ocr_text} />
      ) : (
        <div className="text-[11px] text-muted-foreground italic">(OCR テキストなし)</div>
      )}
    </div>
  );
}

/**
 * OCR テキストを行種別ごとに色分け表示する小コンポーネント (Round 3 ⓔ)。
 * 金額/合計/日付/時刻/インボイス番号/店名 候補をそれぞれ違う色で出すことで、
 * "AI OCR を回す前から、Vision OCR がここまで読めてる" のがひと目で分かる。
 *
 * Round 4 ㊃: hover ツールチップで行種別の意味を補足し、凡例を上部に追加。
 */
function RichOcrPreview({ text }: { text: string }) {
  const lines = classifyReceiptLines(text);
  // tailwind に動的クラスを使うとパージで消えるので静的マッピング
  const kindClass: Record<LineKind, string> = {
    amount: "text-emerald-700 font-semibold",
    total: "text-emerald-900 font-bold bg-emerald-50",
    date: "text-blue-700",
    time: "text-blue-500",
    invoice: "text-purple-700 font-mono",
    vendor: "text-amber-800 font-medium",
    other: "text-muted-foreground",
  };
  // ㊃ 行種別の日本語説明 (hover で見える)
  const kindDesc: Record<LineKind, { label: string; help: string }> = {
    amount: { label: "金額", help: "¥ 記号 / 円 / カンマ区切り数字を含む行 — AI OCR で「明細金額」になる候補" },
    total: { label: "合計", help: "金額 + 合計/小計/total キーワード — AI OCR で「合計金額」になる候補" },
    date: { label: "日付", help: "YYYY/MM/DD 等を含む行 — AI OCR で「取引日」になる候補" },
    time: { label: "時刻", help: "HH:MM 等を含む行 — レシート発行時刻として補助情報になる" },
    invoice: { label: "インボイス番号", help: "T+13桁の登録番号 — 適格請求書として認識される" },
    vendor: { label: "店名候補", help: "「店」「会社」等のヒント語 / 最初の有意行 — AI OCR で「店名」になる候補" },
    other: { label: "その他", help: "上記いずれにも当てはまらない行" },
  };
  // どの種別がこの OCR テキストに含まれているか — 凡例には登場するものだけ出す
  const presentKinds = Array.from(new Set(lines.map((l) => l.kind))).filter(
    (k) => k !== "other",
  ) as LineKind[];

  return (
    <div className="mt-1">
      {presentKinds.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1 text-[9px]">
          {presentKinds.map((k) => (
            <span
              key={k}
              className={`px-1.5 py-0.5 rounded border ${kindClass[k]} bg-background`}
              title={kindDesc[k].help}
            >
              ●{kindDesc[k].label}
            </span>
          ))}
        </div>
      )}
      <pre className="p-2 bg-muted rounded text-[10px] max-h-32 overflow-y-auto whitespace-pre-wrap font-mono leading-snug">
        {lines.map((l, i) => (
          <div
            key={i}
            className={kindClass[l.kind]}
            title={`${kindDesc[l.kind].label}: ${kindDesc[l.kind].help}`}
          >
            {l.line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
