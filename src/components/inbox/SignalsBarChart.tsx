"use client";

/**
 * ㊁ Round 14: signals[] を 横棒バーグラフで表示。
 * 各 signal を「絶対値で正規化した幅%」で並べ、+ は emerald、- は red で。
 * 上位 8 件まで表示。
 *
 * (旧 src/app/(app)/inbox/page.tsx から切り出し)
 */
export function SignalsBarChart({ json }: { json: string }) {
  let parsed:
    | { score?: number; signals?: { score?: number; reason?: string }[] }
    | null = null;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const sigs = (parsed?.signals ?? []).slice(0, 8);
  if (sigs.length === 0) return null;
  const maxAbs = Math.max(...sigs.map((s) => Math.abs(s.score ?? 0)), 0.01);
  return (
    <div className="my-2 p-2 bg-muted rounded text-[10px]">
      <div className="text-muted-foreground mb-1 font-mono">
        score 内訳 (上位 {sigs.length})
      </div>
      <ul className="space-y-0.5">
        {sigs.map((s, i) => {
          const v = s.score ?? 0;
          const w = Math.max(2, Math.round((Math.abs(v) / maxAbs) * 100));
          const positive = v >= 0;
          return (
            <li key={i} className="flex items-center gap-1.5">
              <span className="font-mono tabular-nums w-12 text-right">
                {positive ? "+" : ""}
                {v.toFixed(2)}
              </span>
              <div className="flex-1 h-3 bg-background rounded overflow-hidden relative">
                <div
                  className={positive ? "bg-emerald-400/70" : "bg-red-400/70"}
                  style={{ width: `${w}%`, height: "100%" }}
                />
              </div>
              <span className="flex-shrink min-w-0 truncate" title={s.reason}>
                {s.reason}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
