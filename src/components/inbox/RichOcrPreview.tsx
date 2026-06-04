"use client";

import { classifyReceiptLines, type LineKind } from "@/lib/receipt-classifier";

/**
 * OCR テキストを行単位で色分けして表示する.
 * 凡例 (presentKinds) は出現したカテゴリだけに絞る。
 *
 * (旧 src/app/(app)/inbox/page.tsx から切り出し)
 */
export function RichOcrPreview({ text }: { text: string }) {
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
  const kindDesc: Record<LineKind, { label: string; help: string }> = {
    amount: {
      label: "金額",
      help: "¥ 記号 / 円 / カンマ区切り数字を含む行 — AI OCR で「明細金額」になる候補",
    },
    total: {
      label: "合計",
      help: "金額 + 合計/小計/total キーワード — AI OCR で「合計金額」になる候補",
    },
    date: { label: "日付", help: "YYYY/MM/DD 等を含む行 — AI OCR で「取引日」になる候補" },
    time: { label: "時刻", help: "HH:MM 等を含む行 — レシート発行時刻として補助情報になる" },
    invoice: {
      label: "インボイス番号",
      help: "T+13桁の登録番号 — 適格請求書として認識される",
    },
    vendor: {
      label: "店名候補",
      help: "「店」「会社」等のヒント語 / 最初の有意行 — AI OCR で「店名」になる候補",
    },
    other: { label: "その他", help: "上記いずれにも当てはまらない行" },
  };
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
