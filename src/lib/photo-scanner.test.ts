import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installTestDb, type TestDb } from "@/test-stubs/test-db";
import {
  cursorAfterScan,
  expireOldCandidates,
  localDayBoundaryIso,
  nextScanCursor,
  normalizeOcrForDedupe,
  purgeOldDismissed,
  resolveScanPeriod,
  setInboxState,
  setInboxStates,
  splitScanWindows,
} from "@/lib/photo-scanner";

describe("期間を指定したスキャン", () => {
  const DAY = 24 * 3600;

  describe("splitScanWindows — 期間を区間に分ける", () => {
    it("古い順に、隙間も重なりも無く並ぶ", () => {
      const w = splitScanWindows(0, 30 * DAY, 14 * DAY);
      expect(w).toEqual([
        { sinceUnix: 0, untilUnix: 14 * DAY },
        { sinceUnix: 14 * DAY, untilUnix: 28 * DAY },
        { sinceUnix: 28 * DAY, untilUnix: 30 * DAY },
      ]);
      // 前の区間の終わり = 次の区間の始まり (Rust 側の条件は since < 撮影時刻 <= until)
      for (let i = 1; i < w.length; i++) expect(w[i].sinceUnix).toBe(w[i - 1].untilUnix);
    });
    it("区間より短い期間は 1 つだけ", () => {
      expect(splitScanWindows(100, 100 + 7 * DAY)).toEqual([{ sinceUnix: 100, untilUnix: 100 + 7 * DAY }]);
    });
    it("1 年分でも区間の数は現実的 (2 週間ごと)", () => {
      expect(splitScanWindows(0, 365 * DAY)).toHaveLength(27);
    });
    it("開始が終了以降・不正な値の時は空 (何もスキャンしない)", () => {
      expect(splitScanWindows(200, 100)).toEqual([]);
      expect(splitScanWindows(100, 100)).toEqual([]);
      expect(splitScanWindows(NaN, 100)).toEqual([]);
      expect(splitScanWindows(0, 100, 0)).toEqual([]);
    });
  });

  describe("resolveScanPeriod — 画面の指定をスキャンの範囲に直す", () => {
    const now = new Date(2026, 10, 26, 19, 0, 0).getTime(); // 2026-11-26 19:00 (ローカル)
    const unix = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0) =>
      Math.floor(new Date(y, m - 1, d, hh, mm, ss).getTime() / 1000);

    it("プリセットは「いまから N 日前」〜現在", () => {
      expect(resolveScanPeriod("7d", { from: "", to: "" }, now)).toEqual({ fromUnix: unix(2026, 11, 19, 19) });
      expect(resolveScanPeriod("1y", { from: "", to: "" }, now)).toEqual({
        fromUnix: Math.floor(now / 1000) - 365 * DAY,
      });
    });
    it("日付指定は、開始日の 0:00 から終了日の 23:59:59 まで (どちらの日も含む)", () => {
      const r = resolveScanPeriod("custom", { from: "2026-08-01", to: "2026-08-31" }, now)!;
      // 条件は since < 撮影時刻 <= until。8/1 0:00:00 ちょうどの写真も入る
      expect(r.fromUnix).toBe(unix(2026, 8, 1) - 1);
      expect(r.toUnix).toBe(unix(2026, 8, 31, 23, 59, 59));
    });
    it("終了日が今日以降なら「現在まで」になる (次回スキャンの起点も進められる)", () => {
      expect(resolveScanPeriod("custom", { from: "2026-11-01", to: "2026-11-26" }, now)).toEqual({
        fromUnix: unix(2026, 11, 1) - 1,
      });
      expect(resolveScanPeriod("custom", { from: "2026-11-01", to: "2027-01-01" }, now)).toEqual({
        fromUnix: unix(2026, 11, 1) - 1,
      });
    });
    it("開始日が終了日より後・未来だけの期間・日付の形式違いは受け付けない", () => {
      expect(resolveScanPeriod("custom", { from: "2026-09-01", to: "2026-08-01" }, now)).toBeNull();
      expect(resolveScanPeriod("custom", { from: "2026-12-01", to: "2026-12-31" }, now)).toBeNull();
      expect(resolveScanPeriod("custom", { from: "", to: "2026-08-31" }, now)).toBeNull();
      expect(resolveScanPeriod("custom", { from: "2026/08/01", to: "2026-08-31" }, now)).toBeNull();
    });
    it("同じ日を開始・終了にすると、その 1 日だけ", () => {
      const r = resolveScanPeriod("custom", { from: "2026-08-15", to: "2026-08-15" }, now)!;
      expect(r.toUnix! - r.fromUnix).toBe(DAY);
    });
  });

  describe("cursorAfterScan — 次回スキャンの起点を動かすか", () => {
    it("通常のスキャン (期間指定なし) は、これまでどおり進める", () => {
      expect(cursorAfterScan({ lastScan: 100, since: 100, cursor: 250 })).toBe(250);
      expect(cursorAfterScan({ lastScan: 100, since: 100, cursor: 100 })).toBeNull();
      // 初回 (前回スキャンなし)
      expect(cursorAfterScan({ lastScan: 0, since: 50, cursor: 80 })).toBe(80);
    });
    it("終わりを区切った期間 (過去の一部分) では動かさない", () => {
      expect(
        cursorAfterScan({ lastScan: 1000, since: 100, cursor: 400, range: { sinceUnix: 100, untilUnix: 500 } }),
      ).toBeNull();
      // 前回スキャンより後まで含む期間でも、終わりを区切っていれば動かさない
      expect(
        cursorAfterScan({ lastScan: 1000, since: 100, cursor: 1500, range: { sinceUnix: 100, untilUnix: 2000 } }),
      ).toBeNull();
    });
    it("「現在まで」の期間でも、起点を過去へは戻さない", () => {
      // 古い側を処理している途中で中断した (cursor が前回スキャンより前)
      expect(cursorAfterScan({ lastScan: 1000, since: 100, cursor: 400, range: { sinceUnix: 100 } })).toBeNull();
      // 最後まで処理できたら、最新の写真まで進める
      expect(cursorAfterScan({ lastScan: 1000, since: 100, cursor: 1500, range: { sinceUnix: 100 } })).toBe(1500);
    });
    it("初めてのスキャンを期間指定で行った時も、起点ができる", () => {
      expect(cursorAfterScan({ lastScan: 0, since: 100, cursor: 900, range: { sinceUnix: 100 } })).toBe(900);
    });
  });
});

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
