"use client";

/**
 * ㊗ Round 8: 自動破棄ルールで dismissed になった理由を 1 行で表示する。
 * "学習で消したけど、間違いなら『未判定に戻す』で復活できる" という導線を
 * 視覚的に示す目的。中身は scanNow が JSON で書いた reason オブジェクト。
 *
 * (旧 src/app/(app)/inbox/page.tsx から切り出し)
 */
export function AutoDismissReasonView({ reasonJson }: { reasonJson: string }) {
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
        <span className="ml-1 font-mono text-amber-700">
          ({(sim * 100).toFixed(0)}%)
        </span>
      )}
      {kws.length > 0 && (
        <span className="block text-[10px] text-amber-700 mt-0.5">
          共通: {kws.join(" / ")}
        </span>
      )}
    </div>
  );
}
