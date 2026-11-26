import { describe, it, expect } from "vitest";
import { selectSnapshotsToRemove } from "@/lib/auto-backup";

describe("selectSnapshotsToRemove — 日次スナップショットの世代管理", () => {
  const snap = (d: string) => `kaikei-${d}.db`;

  it("7 個以下なら何も消さない", () => {
    const names = ["2026-11-20", "2026-11-21", "2026-11-22"].map(snap);
    expect(selectSnapshotsToRemove(names)).toEqual([]);
  });

  it("8 個以上なら古い方から消して 7 個残す", () => {
    const names = [
      "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22",
      "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26",
    ].map(snap);
    expect(selectSnapshotsToRemove(names)).toEqual([snap("2026-11-18"), snap("2026-11-19")]);
  });

  it("久しぶりに起動しても、過去のスナップショットを当日分だけにしない", () => {
    // 旧実装は「7 日より古いものを削除」だったので、3 週間ぶりに起動すると
    // 当日分しか残らなかった (いちばん欲しい「前の状態」が消える)
    const names = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-11-26"].map(snap);
    expect(selectSnapshotsToRemove(names)).toEqual([]);
  });

  it("並び順に依存せず、関係ないファイルには触らない", () => {
    const names = [
      snap("2026-11-26"), "notes.txt", snap("2026-01-01"), "kaikei.db", snap("2026-06-15"),
    ];
    expect(selectSnapshotsToRemove(names, 2)).toEqual([snap("2026-01-01")]);
  });
});
