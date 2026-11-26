import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installTestDb, type TestDb } from "@/test-stubs/test-db";
import {
  expireOldCandidates,
  localDayBoundaryIso,
  nextScanCursor,
  normalizeOcrForDedupe,
  purgeOldDismissed,
  setInboxState,
  setInboxStates,
} from "@/lib/photo-scanner";

describe("nextScanCursor — 次回スキャンの起点", () => {
  it("全部処理できたら、最新の写真の撮影時刻まで進める", () => {
    expect(nextScanCursor(100, [150, 120, 200], 3)).toBe(200);
  });
  it("新しい写真が無ければ動かさない (『現在時刻』へ飛ばして遅れて届く写真を取りこぼさない)", () => {
    expect(nextScanCursor(100, [], 0)).toBe(100);
  });
  it("途中でキャンセルしたら、未処理の最古の写真の手前まで", () => {
    // 古い順に 120, 150 を処理して 200, 300 が未処理
    expect(nextScanCursor(100, [300, 150, 120, 200], 2)).toBe(150);
    // 未処理の写真と同じ秒に処理済みがある時は、その 1 秒手前 (次回もう一度拾う)
    expect(nextScanCursor(100, [120, 200, 200], 2)).toBe(199);
  });
  it("取り込みに失敗した写真があれば、その手前で止める", () => {
    expect(nextScanCursor(100, [120, 150, 200], 3, [150])).toBe(149);
    expect(nextScanCursor(100, [120, 150, 200], 3, [120])).toBe(119);
  });
  it("起点より前には戻らない", () => {
    expect(nextScanCursor(100, [101, 102], 2, [101])).toBe(100);
  });
});

describe("重複判定の正規化 / 日付の境界", () => {
  it("空白・改行・全角半角の揺れだけが違うテキストは同じとみなす", () => {
    expect(normalizeOcrForDedupe("セブン-イレブン\n 合計 ¥1,100")).toBe(
      normalizeOcrForDedupe("セブン-イレブン 合計　¥１，１００"),
    );
  });
  it("同じ店でも金額や日付が違えば別物 (旧実装は先頭 60 文字だけで重複扱いだった)", () => {
    const head = "セブン-イレブン 千代田店 東京都千代田区… TEL 03-0000-0000 登録番号 T1234567890123 ";
    expect(normalizeOcrForDedupe(head + "2026/11/01 合計 ¥540")).not.toBe(
      normalizeOcrForDedupe(head + "2026/11/20 合計 ¥1,280"),
    );
  });
  it("ローカル日付の 1 日分を UTC の範囲に直す", () => {
    const start = localDayBoundaryIso("2026-11-26", "start")!;
    const end = localDayBoundaryIso("2026-11-26", "end")!;
    expect(new Date(start).getTime()).toBe(new Date(2026, 10, 26, 0, 0, 0, 0).getTime());
    expect(new Date(end).getTime()).toBe(new Date(2026, 10, 26, 23, 59, 59, 999).getTime());
    expect(localDayBoundaryIso("", "start")).toBeNull();
    expect(localDayBoundaryIso("2026/11/26", "start")).toBeNull();
  });
});

describe("受信箱の状態変更と自動整理", () => {
  let t: TestDb;
  beforeEach(() => {
    t = installTestDb();
  });
  afterEach(() => t.close());

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
  function add(id: string, state: string, opts: { changedDaysAgo?: number; takenDaysAgo?: number; viewed?: boolean; file?: string; receipt?: string } = {}) {
    t.raw
      .prepare(
        `INSERT INTO photo_inbox (id, source_asset_id, taken_at, detected_at, state, state_changed_at, last_viewed_at, file_path, imported_receipt_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `asset-${id}`,
        daysAgo(opts.takenDaysAgo ?? 0),
        daysAgo(opts.changedDaysAgo ?? 0),
        state,
        daysAgo(opts.changedDaysAgo ?? 0),
        opts.viewed ? daysAgo(1) : null,
        opts.file ?? null,
        opts.receipt ?? null,
      );
  }
  const state = (id: string) => t.scalar<string | undefined>("SELECT state FROM photo_inbox WHERE id = ?", id);

  it("取り込み済みの写真は、破棄にも領収書にも変えられない", async () => {
    t.raw.exec("INSERT INTO receipts (id, image_url) VALUES ('r', 'file:///x/inbox/a.jpg')");
    add("imp", "imported", { receipt: "r" });
    add("cand", "candidate");
    expect(await setInboxState("imp", "dismissed")).toBe(false);
    expect(await setInboxState("imp", "receipt")).toBe(false);
    expect(state("imp")).toBe("imported");
    const r = await setInboxStates(["imp", "cand"], "dismissed");
    expect(r).toEqual({ changed: 1, skippedImported: 1 });
    expect(state("cand")).toBe("dismissed");
  });

  it("未判定に戻した写真には既読が付き、直後の自動破棄の対象にならない", async () => {
    add("old", "dismissed", { changedDaysAgo: 40, takenDaysAgo: 200 });
    await setInboxState("old", "candidate");
    expect(t.scalar("SELECT last_viewed_at FROM photo_inbox WHERE id='old'")).toBeTruthy();
    await expireOldCandidates();
    expect(state("old")).toBe("candidate");
  });

  it("自動破棄は『未判定になってから 30 日』で数える (撮影日が古いだけでは破棄しない)", async () => {
    add("fresh-old-photo", "candidate", { changedDaysAgo: 1, takenDaysAgo: 200 }); // 久しぶりのスキャンで入った古い写真
    add("stale", "candidate", { changedDaysAgo: 45, takenDaysAgo: 45 });
    add("stale-viewed", "candidate", { changedDaysAgo: 45, takenDaysAgo: 45, viewed: true });
    const r = await expireOldCandidates();
    expect(r.swept).toBe(1);
    expect(state("fresh-old-photo")).toBe("candidate");
    expect(state("stale")).toBe("dismissed");
    expect(state("stale-viewed")).toBe("candidate");
  });

  it("物理削除は『破棄してから 90 日』。破棄したばかりの古い写真は消さない", async () => {
    add("just-dismissed", "dismissed", { changedDaysAgo: 2, takenDaysAgo: 400 });
    add("long-dismissed", "dismissed", { changedDaysAgo: 120, takenDaysAgo: 400 });
    const r = await purgeOldDismissed();
    expect(r.purged).toBe(1);
    expect(state("just-dismissed")).toBe("dismissed");
    expect(state("long-dismissed")).toBeUndefined();
  });

  it("領収書が参照している画像の写真は、どれだけ古くても物理削除しない", async () => {
    t.raw.exec("INSERT INTO receipts (id, image_url) VALUES ('r', 'file:///data/inbox/keep.jpg')");
    add("referenced", "dismissed", { changedDaysAgo: 200, file: "/data/inbox/keep.jpg" });
    add("linked", "dismissed", { changedDaysAgo: 200, receipt: "r" });
    const r = await purgeOldDismissed();
    expect(r.purged).toBe(0);
    expect(state("referenced")).toBe("dismissed");
    expect(state("linked")).toBe("dismissed");
  });
});
