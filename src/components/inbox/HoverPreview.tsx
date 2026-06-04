"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { InboxRow } from "@/lib/photo-scanner";
import { SignalsBarChart } from "./SignalsBarChart";
import { RichOcrPreview } from "./RichOcrPreview";

/**
 * ㊌ Round 6: 受信箱カードを hover した時に出る大きめプレビュー。
 * Round 28: side prop でカード位置に応じて左右切替 (操作ボタン被り防止)。
 *
 * (旧 src/app/(app)/inbox/page.tsx から切り出し)
 */
export function HoverPreview({
  row,
  side = "right",
  onMouseEnter,
  onMouseLeave,
}: {
  row: InboxRow;
  side?: "left" | "right";
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

  // side="right" → 画面右上 / side="left" → 画面左上 (sidebar の右隣)
  const positionCls = side === "left" ? "left-[240px]" : "right-6";
  return (
    <div
      className={`fixed top-20 ${positionCls} w-[28rem] max-h-[80vh] overflow-y-auto z-50
                  bg-card border-2 border-primary/30 rounded-lg shadow-2xl p-3
                  pointer-events-auto`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="aspect-[4/3] bg-muted rounded mb-2 overflow-hidden">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
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
      {row.score_signals_json && <SignalsBarChart json={row.score_signals_json} />}
      {row.ocr_text ? (
        <RichOcrPreview text={row.ocr_text} />
      ) : (
        <div className="text-[11px] text-muted-foreground italic">
          (OCR テキストなし)
        </div>
      )}
    </div>
  );
}
