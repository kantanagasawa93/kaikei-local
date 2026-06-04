"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Check,
  X as XIcon,
  ArrowRight,
  RotateCcw,
  CheckSquare,
  Square,
  ScanText,
  Pencil,
  Save as SaveIcon,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { updateInboxClaudeResult, type InboxRow } from "@/lib/photo-scanner";
import { toast } from "@/lib/toast";
import { ScoreSignalsBadge } from "./ScoreSignalsBadge";
import { AutoDismissReasonView } from "./AutoDismissReasonView";
import { RichOcrPreview } from "./RichOcrPreview";
import { parseClaudeResult } from "./shared";

/**
 * 受信箱 1 枚分のカード.
 * - 画像 + score + state badge
 * - AI OCR 結果 (vendor / amount / date) の inline 編集
 * - 状態別の操作ボタン (領収書 / 違う / 破棄 / いますぐ仕訳化 / 再試行 / 再 OCR / 復元)
 *
 * (旧 src/app/(app)/inbox/page.tsx から切り出し)
 */
export function InboxCard({
  row,
  quickConfirming,
  reocring,
  isSelected,
  isFocused,
  onToggleSelected,
  onHoverEnter,
  onHoverLeave,
  onMarkReceipt,
  onMarkNotReceipt,
  onDismiss,
  onRestore,
  onRetryFailed,
  onQuickConfirm,
  onReocr,
  onOpenForReceipt,
}: {
  row: InboxRow;
  quickConfirming: boolean;
  reocring: boolean;
  isSelected: boolean;
  isFocused: boolean;
  onToggleSelected: () => void;
  onHoverEnter: (e: React.MouseEvent) => void;
  onHoverLeave: () => void;
  onMarkReceipt: () => void;
  onMarkNotReceipt: () => void;
  onDismiss: () => void;
  onRestore: () => void;
  onRetryFailed: () => void;
  onQuickConfirm: () => void;
  onReocr: (twoPass: boolean) => void;
  onOpenForReceipt: () => void;
}) {
  // 画像表示は plugin-fs で生バイトを読んで Blob URL 化する。
  // asset:// 経由だとパスのスペース展開や HEIC の MIME 判定で
  // 詰まるケースが多いので、file 直読み + MIME 検出で確実にする。
  const [src, setSrc] = useState<string | null>(null);
  // ㉿ Round 16: claude_result_json の inline 編集モード
  // ㊄ Round 17: 「保存して再仕訳化」も同時に
  const initialClaude = parseClaudeResult(row.claude_result_json);
  const [editing, setEditing] = useState(false);
  const [editVendor, setEditVendor] = useState(initialClaude.vendor_name);
  const [editAmount, setEditAmount] = useState(initialClaude.amount);
  const [editDate, setEditDate] = useState(initialClaude.date);
  const [saving, setSaving] = useState(false);
  const hasClaudeJson = !!row.claude_result_json;

  const handleSaveEdit = async (alsoRejournalize: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      await updateInboxClaudeResult(row.id, {
        vendor_name: editVendor || null,
        amount: editAmount ? parseInt(editAmount, 10) : null,
        date: editDate || null,
      });
      if (alsoRejournalize) {
        // photo_inbox.state が imported なら、receipts/journals を消して
        // 再仕訳化する。`rejournalize` は journal_id を引数に取るので、
        // imported_receipt_id から逆引き → journal_id を探す
        const { db } = await import("@/lib/localDb");
        const { rejournalize } = await import("@/lib/auto-journal");
        const { data: rec } = await db
          .from("receipts")
          .select("id")
          .eq("id", row.imported_receipt_id ?? "")
          .single();
        if (rec) {
          const { data: jr } = await db
            .from("journals")
            .select("id")
            .eq("receipt_id", (rec as { id: string }).id)
            .single();
          const journalId = (jr as { id: string } | null)?.id;
          if (journalId) {
            await rejournalize(journalId);
            toast.success("編集内容を保存して再仕訳化しました");
          } else {
            toast.success("編集を保存しました (再仕訳化対象の journal なし)");
          }
        } else {
          toast.success("編集を保存しました (まだ仕訳化されていないので保存のみ)");
        }
      } else {
        toast.success("AI OCR 結果を更新しました");
      }
      setEditing(false);
    } catch (e) {
      toast.error(`更新失敗: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

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
        // 失敗してもグリッド全体を壊さないよう静かに
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl && createdUrl.startsWith("blob:")) URL.revokeObjectURL(createdUrl);
    };
  }, [row.file_path]);

  return (
    <Card
      className={`overflow-hidden flex flex-col transition-shadow ${
        isSelected ? "ring-2 ring-primary shadow-md" : ""
      } ${isFocused ? "ring-2 ring-amber-400 shadow-lg" : ""}`}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
    >
      <div className="aspect-[4/3] bg-muted relative">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
            画像読み込み中...
          </div>
        )}
        {/* ㉜ Round 9: 左下にマルチ選択チェックボックス */}
        <button
          type="button"
          onClick={onToggleSelected}
          className={`absolute bottom-2 left-2 h-6 w-6 rounded
                      flex items-center justify-center transition-colors
                      ${
                        isSelected
                          ? "bg-primary text-primary-foreground"
                          : "bg-background/80 backdrop-blur-sm hover:bg-background"
                      }`}
          title={isSelected ? "選択解除" : "選択"}
          aria-label={isSelected ? "選択解除" : "選択"}
        >
          {isSelected ? (
            <CheckSquare className="h-4 w-4" />
          ) : (
            <Square className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
        {row.receipt_score !== null && (
          <ScoreSignalsBadge
            score={row.receipt_score}
            signalsJson={row.score_signals_json}
          />
        )}
        <Badge
          variant="outline"
          className="absolute top-2 left-2 text-[10px] bg-background/80 backdrop-blur-sm"
        >
          {row.state}
        </Badge>
        {/* Round 21 ⓑ: 未確認バッジ (まだ hover/open していない candidate のみ) */}
        {row.state === "candidate" && !row.last_viewed_at && (
          <Badge
            variant="default"
            className="absolute bottom-2 right-2 text-[10px] bg-amber-500 text-white"
            title="まだ確認していない candidate"
          >
            未確認
          </Badge>
        )}
      </div>
      <CardContent className="p-3 space-y-2 flex-1 flex flex-col">
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <span className="flex-1">
            {row.taken_at ? new Date(row.taken_at).toLocaleString("ja-JP") : "-"}
          </span>
          {hasClaudeJson && !editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
              title="AI OCR の vendor / amount / date を編集"
            >
              <Pencil className="h-3 w-3" /> 編集
            </button>
          )}
        </div>
        {/* ㉿ Round 16: claude_result_json があれば、inline 編集モード対応 */}
        {hasClaudeJson && editing ? (
          <div className="space-y-1.5 text-[11px]">
            <input
              type="text"
              value={editVendor}
              onChange={(e) => setEditVendor(e.target.value)}
              placeholder="店名"
              className="w-full border rounded px-1.5 py-1 text-xs"
            />
            <input
              type="number"
              value={editAmount}
              onChange={(e) => setEditAmount(e.target.value)}
              placeholder="金額"
              className="w-full border rounded px-1.5 py-1 text-xs tabular-nums"
            />
            <input
              type="date"
              value={editDate}
              onChange={(e) => setEditDate(e.target.value)}
              className="w-full border rounded px-1.5 py-1 text-xs"
            />
            <div className="flex gap-1 flex-wrap">
              <Button
                size="sm"
                variant="default"
                disabled={saving}
                onClick={() => handleSaveEdit(false)}
                className="h-6 text-[10px] px-2"
              >
                <SaveIcon className="h-3 w-3 mr-0.5" />
                {saving ? "保存中..." : "保存"}
              </Button>
              {row.state === "imported" && row.imported_receipt_id && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={saving}
                  onClick={() => handleSaveEdit(true)}
                  className="h-6 text-[10px] px-2"
                  title="編集内容を保存し、現在の仕訳を破棄して AI OCR で再生成"
                >
                  <Sparkles className="h-3 w-3 mr-0.5" />
                  {saving ? "実行中..." : "保存して再仕訳化"}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setEditVendor(initialClaude.vendor_name);
                  setEditAmount(initialClaude.amount);
                  setEditDate(initialClaude.date);
                }}
                className="h-6 text-[10px] px-2"
              >
                キャンセル
              </Button>
            </div>
          </div>
        ) : hasClaudeJson ? (
          <div className="text-[11px] bg-emerald-50 border border-emerald-200 rounded p-1.5 leading-tight">
            <div className="font-medium text-emerald-900">
              {initialClaude.vendor_name || "(店名なし)"}
            </div>
            <div className="text-emerald-700 tabular-nums flex gap-2">
              <span>
                {initialClaude.amount
                  ? `¥${Number(initialClaude.amount).toLocaleString()}`
                  : "-"}
              </span>
              <span>{initialClaude.date || "-"}</span>
            </div>
          </div>
        ) : null}
        {row.ocr_text ? (
          <details className="text-[11px] text-muted-foreground leading-tight">
            <summary className="line-clamp-2 cursor-pointer hover:text-foreground">
              {row.ocr_text.slice(0, 60)}
            </summary>
            <RichOcrPreview text={row.ocr_text} />
          </details>
        ) : (
          <div className="text-[11px] text-muted-foreground italic">
            (OCR テキストなし)
          </div>
        )}
        {row.state === "receipt_failed" && row.last_error && (
          <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded p-1.5 leading-tight">
            <span className="font-medium">エラー:</span> {row.last_error}
            {typeof row.attempts === "number" && row.attempts > 0 && (
              <span className="ml-1 text-red-500/80">({row.attempts}回失敗)</span>
            )}
          </div>
        )}
        {row.state === "dismissed" && row.auto_dismissed_reason && (
          <AutoDismissReasonView reasonJson={row.auto_dismissed_reason} />
        )}
        {row.state === "imported" && row.imported_receipt_id && (
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
              <Button
                size="sm"
                variant="default"
                onClick={onMarkReceipt}
                className="text-xs px-2 h-7"
              >
                <Check className="h-3 w-3 mr-1" />
                領収書
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onMarkNotReceipt}
                className="text-xs px-2 h-7"
              >
                <XIcon className="h-3 w-3 mr-1" />
                違う
              </Button>
            </>
          )}
          {row.state === "receipt" && (
            <Button
              size="sm"
              onClick={onOpenForReceipt}
              className="text-xs px-2 h-7 flex-1"
            >
              <ArrowRight className="h-3 w-3 mr-1" />
              登録に進む
            </Button>
          )}
          {(row.state === "candidate" || row.state === "receipt") && (
            <Button
              size="sm"
              variant={row.state === "receipt" ? "outline" : "secondary"}
              onClick={onQuickConfirm}
              disabled={quickConfirming}
              className="text-xs px-2 h-7"
              title="このまま 1 クリックで AI OCR → 領収書 → 仕訳まで作成 (要ライセンスキー)"
            >
              <Sparkles
                className={`h-3 w-3 mr-1 ${quickConfirming ? "animate-pulse" : ""}`}
              />
              {quickConfirming ? "仕訳化中..." : "いますぐ仕訳化"}
            </Button>
          )}
          {row.state === "receipt_failed" && (
            <Button
              size="sm"
              variant="default"
              onClick={onRetryFailed}
              className="text-xs px-2 h-7"
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              再試行
            </Button>
          )}
          {(row.state === "not_receipt" || row.state === "candidate") && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onDismiss}
              className="text-xs px-2 h-7"
            >
              破棄
            </Button>
          )}
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
          {(row.state === "candidate" ||
            row.state === "receipt" ||
            row.state === "receipt_failed") && (
            <Button
              size="sm"
              variant="ghost"
              disabled={reocring}
              onClick={(e) => onReocr(e.shiftKey)}
              className="text-xs px-2 h-7 text-muted-foreground hover:text-foreground"
              title="Vision OCR を再実行 (Shift+クリックで日英両言語の two-pass)"
            >
              <ScanText
                className={`h-3 w-3 mr-1 ${reocring ? "animate-pulse" : ""}`}
              />
              {reocring ? "OCR中..." : "再 OCR"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
