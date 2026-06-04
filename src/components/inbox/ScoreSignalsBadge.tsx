"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";

/**
 * Round 22 ⓖ: score badge + hover で内訳 popover を表示。
 * Round 25 ⓖ: click でも sticky で開閉可能 (touch / keyboard)。
 * Round 27 ⓖ: ESC で sticky popover を閉じる。
 * Round 28: hover 中は pointer-events: none で操作ボタンを邪魔しない。
 *
 * (旧 src/app/(app)/inbox/page.tsx から切り出し)
 */
export function ScoreSignalsBadge({
  score,
  signalsJson,
}: {
  score: number;
  signalsJson: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [stickyOpen, setStickyOpen] = useState(false);
  const visible = open || stickyOpen;

  let parsed:
    | {
        score?: number;
        signals?: { score?: number; reason?: string }[];
      }
    | null = null;
  if (signalsJson) {
    try {
      parsed = JSON.parse(signalsJson);
    } catch {
      parsed = null;
    }
  }
  const signals = parsed?.signals ?? [];

  // ESC キーで sticky popover を閉じる (a11y)
  useEffect(() => {
    if (!stickyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setStickyOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [stickyOpen]);

  return (
    <div
      className="absolute top-2 right-2"
      onMouseEnter={() => signalsJson && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => signalsJson && setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (signalsJson) setStickyOpen((v) => !v);
        }}
        className={`block ${signalsJson ? "cursor-pointer" : "cursor-default"}`}
        aria-expanded={visible}
        aria-label={
          signalsJson ? "スコア内訳を開閉" : `score ${score.toFixed(2)}`
        }
      >
        <Badge
          variant="secondary"
          className="text-[10px] font-mono"
          tabIndex={signalsJson ? 0 : -1}
        >
          score {score.toFixed(2)}
        </Badge>
      </button>
      {visible && signals.length > 0 && (
        <div
          className={`absolute top-full right-0 mt-1 z-30 w-64 p-3
                     bg-popover text-popover-foreground rounded-md shadow-xl
                     border text-xs leading-snug
                     ${stickyOpen ? "" : "pointer-events-none"}`}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <div className="font-bold pb-1 mb-2 border-b">
            score {(parsed?.score ?? score).toFixed(2)} の内訳
          </div>
          <div className="max-h-56 overflow-y-auto space-y-1">
            {signals.map((s, idx) => {
              const v = s.score ?? 0;
              const sign = v > 0 ? "+" : v < 0 ? "" : "±";
              const cls =
                v > 0
                  ? "text-green-700"
                  : v < 0
                  ? "text-red-700"
                  : "text-muted-foreground";
              return (
                <div
                  key={idx}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="flex-1 truncate" title={s.reason ?? ""}>
                    {s.reason}
                  </span>
                  <span className={`font-mono ${cls}`}>
                    {sign}
                    {v.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="text-[10px] text-muted-foreground pt-2 mt-2 border-t">
            合計が 0.40 以上なら自動で receipt 判定
          </div>
        </div>
      )}
    </div>
  );
}
