import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installTestDb, type TestDb } from "@/test-stubs/test-db";
import {
  deleteImportedOriginals,
  describeDeleteResult,
  getAutoDeleteOriginals,
  listDeletableOriginals,
  reconcileDeletedOriginals,
  setAutoDeleteOriginals,
  type DeleteAssetsOutcome,
  type PhotoOriginalsDeps,
} from "@/lib/photo-originals";

describe("取り込み済みの写真を写真アプリから削除する", () => {
  let t: TestDb;
  beforeEach(() => {
    t = installTestDb();
  });
  afterEach(() => t.close());

  const receipt = (id: string, image: string) =>
    t.raw.prepare("INSERT INTO receipts (id, image_url) VALUES (?, ?)").run(id, image);
  function inbox(
    id: string,
    state: string,
    opts: { file?: string | null; receipt?: string | null; deletedAt?: string | null; importedAt?: string } = {},
  ) {
    t.raw
      .prepare(
        `INSERT INTO photo_inbox (id, source_asset_id, taken_at, state, file_path, imported_receipt_id, imported_at, source_deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `asset-${id}`,
        "2026-11-01T00:00:00Z",
        state,
        opts.file === undefined ? `/data/inbox/${id}.jpg` : opts.file,
        opts.receipt ?? null,
        opts.importedAt ?? "2026-11-02T00:00:00Z",
        opts.deletedAt ?? null,
      );
  }
  /** 取り込み済み + 領収書がその画像を参照している、消してよい写真 */
  function imported(id: string, importedAt?: string) {
    receipt(`r-${id}`, `file:///data/inbox/${id}.jpg`);
    inbox(id, "imported", { receipt: `r-${id}`, importedAt });
  }
  const deletedAt = (id: string) =>
    t.scalar<string | null>("SELECT source_deleted_at FROM photo_inbox WHERE id = ?", id);

  /** OS のダイアログで「削除」を選んだ時の動きをまねる */
  function deps(
    answer: (items: { asset_id: string; file_path: string }[]) => Partial<DeleteAssetsOutcome>,
    existing: string[] = [],
  ): PhotoOriginalsDeps & { calls: { asset_id: string; file_path: string }[][] } {
    const calls: { asset_id: string; file_path: string }[][] = [];
    return {
      calls,
      deleteAssets: async (items) => {
        calls.push(items);
        return {
          requested: items.length,
          deleted: [],
          missing: [],
          cancelled: false,
          error: null,
          ...answer(items),
        };
      },
      existingAssetIds: async (ids) => ids.filter((i) => existing.includes(i)),
    };
  }

  describe("対象の選び方 — 消してよいのは「取り込み済みで、領収書がその画像を持っている」写真だけ", () => {
    it("取り込み済みで、領収書がアプリ側の画像を参照しているものだけが対象", async () => {
      imported("ok");
      const list = await listDeletableOriginals();
      expect(list).toEqual([
        { inboxId: "ok", assetId: "asset-ok", receiptId: "r-ok", filePath: "/data/inbox/ok.jpg" },
      ]);
    });

    it("未判定・領収書 (未取り込み)・違う・破棄・失敗の写真は対象にしない", async () => {
      for (const state of ["candidate", "receipt", "not_receipt", "dismissed", "receipt_failed"]) {
        inbox(`s-${state}`, state);
      }
      expect(await listDeletableOriginals()).toEqual([]);
    });

    it("領収書が無い・領収書が別の画像を指している・アプリ側の画像の記録が無い写真は対象にしない", async () => {
      // 領収書が消されている (imported_receipt_id は ON DELETE SET NULL で空になる)
      inbox("no-receipt", "imported", { receipt: null });
      // 領収書の画像が差し替えられている
      receipt("r-other", "file:///data/receipts/replaced.jpg");
      inbox("other-image", "imported", { receipt: "r-other" });
      // 領収書の画像が空
      receipt("r-empty", "");
      inbox("empty-image", "imported", { receipt: "r-empty" });
      // 受信箱側にファイルの記録が無い
      receipt("r-nofile", "file:///data/inbox/nofile.jpg");
      inbox("nofile", "imported", { receipt: "r-nofile", file: null });
      expect(await listDeletableOriginals()).toEqual([]);
    });

    it("既に削除を記録した写真は、もう一度は対象にしない", async () => {
      imported("done");
      t.raw.exec("UPDATE photo_inbox SET source_deleted_at = '2026-11-10T00:00:00Z' WHERE id = 'done'");
      expect(await listDeletableOriginals()).toEqual([]);
    });

    it("取り込みの古い順に並ぶ", async () => {
      imported("new", "2026-11-20T00:00:00Z");
      imported("old", "2026-11-05T00:00:00Z");
      expect((await listDeletableOriginals()).map((x) => x.inboxId)).toEqual(["old", "new"]);
    });
  });

  describe("削除の実行", () => {
    it("OS が消したと報告した写真だけに、削除の記録を付ける", async () => {
      imported("a");
      imported("b");
      inbox("cand", "candidate");
      const d = deps((items) => ({ deleted: [items[0].asset_id] }));
      const r = await deleteImportedOriginals(d);
      // 依頼したのは対象の 2 枚だけ (未判定の写真は渡していない)。アプリ側の画像の場所も一緒に渡す
      expect(d.calls).toHaveLength(1);
      expect(d.calls[0].map((i) => i.asset_id).sort()).toEqual(["asset-a", "asset-b"]);
      expect(d.calls[0].every((i) => i.file_path.startsWith("/data/inbox/"))).toBe(true);
      expect(r).toMatchObject({ requested: 2, deleted: 1, alreadyGone: 0, cancelled: false, remaining: 1 });
      expect([deletedAt("a"), deletedAt("b")].filter(Boolean)).toHaveLength(1);
      expect(deletedAt("cand")).toBeNull();
    });

    it("利用者が確認ダイアログで取り消したら、何も記録しない (あとでやり直せる)", async () => {
      imported("a");
      const r = await deleteImportedOriginals(deps(() => ({ cancelled: true })));
      expect(r).toMatchObject({ requested: 1, deleted: 0, cancelled: true, remaining: 1 });
      expect(deletedAt("a")).toBeNull();
      expect(await listDeletableOriginals()).toHaveLength(1);
    });

    it("依頼の時点で既に写真アプリに無かった写真は、記録だけ更新する", async () => {
      imported("gone");
      const r = await deleteImportedOriginals(deps((items) => ({ missing: [items[0].asset_id] })));
      expect(r).toMatchObject({ requested: 1, deleted: 0, alreadyGone: 1, remaining: 0 });
      expect(deletedAt("gone")).toBeTruthy();
    });

    it("アプリ側の画像が見つからず Rust 側が見送った写真は、消していないので記録しない", async () => {
      imported("nocopy");
      const r = await deleteImportedOriginals(
        deps((items) => ({ skipped_no_copy: [items[0].asset_id] })),
      );
      expect(r).toMatchObject({ requested: 1, deleted: 0, skippedNoCopy: 1, remaining: 1 });
      expect(deletedAt("nocopy")).toBeNull();
    });

    it("戻り値に依頼していない ID が混ざっていても、その写真には触れない", async () => {
      imported("a");
      inbox("cand", "candidate");
      const r = await deleteImportedOriginals(deps(() => ({ deleted: ["asset-cand", "asset-unknown"] })));
      expect(r.deleted).toBe(0);
      expect(deletedAt("cand")).toBeNull();
      expect(deletedAt("a")).toBeNull();
    });

    it("対象が無い時は、OS に何も依頼しない", async () => {
      inbox("cand", "candidate");
      const d = deps(() => ({}));
      const r = await deleteImportedOriginals(d);
      expect(d.calls).toHaveLength(0);
      expect(r.requested).toBe(0);
    });

    it("失敗しても、次の実行を妨げない (実行中の印が残らない)", async () => {
      imported("a");
      const failing: PhotoOriginalsDeps = {
        deleteAssets: async () => {
          throw new Error("not_authorized:denied");
        },
        existingAssetIds: async () => [],
      };
      await expect(deleteImportedOriginals(failing)).rejects.toThrow(/not_authorized/);
      const r = await deleteImportedOriginals(deps((items) => ({ deleted: [items[0].asset_id] })));
      expect(r.deleted).toBe(1);
    });
  });

  describe("写真アプリ側で利用者が自分で消した分の反映", () => {
    it("ライブラリに無くなっていた写真にだけ、削除の記録を付ける", async () => {
      imported("kept");
      imported("removed");
      const n = await reconcileDeletedOriginals(deps(() => ({}), ["asset-kept"]));
      expect(n).toBe(1);
      expect(deletedAt("removed")).toBeTruthy();
      expect(deletedAt("kept")).toBeNull();
    });

    it("1 枚も見つからない時は、読めていないだけかもしれないので何も変えない", async () => {
      imported("a");
      imported("b");
      expect(await reconcileDeletedOriginals(deps(() => ({}), []))).toBe(0);
      expect(deletedAt("a")).toBeNull();
      expect(deletedAt("b")).toBeNull();
    });
  });

  it("自動で削除を確認する設定は、既定でオフ。保存して読み直せる", async () => {
    expect(await getAutoDeleteOriginals()).toBe(false);
    await setAutoDeleteOriginals(true);
    expect(await getAutoDeleteOriginals()).toBe(true);
    await setAutoDeleteOriginals(false);
    expect(await getAutoDeleteOriginals()).toBe(false);
  });
});

describe("describeDeleteResult — 結果の説明", () => {
  const base = {
    requested: 3,
    deleted: 0,
    alreadyGone: 0,
    skippedNoCopy: 0,
    cancelled: false,
    remaining: 0,
    error: null,
  };
  it("消した枚数と、30 日は戻せることを伝える", () => {
    expect(describeDeleteResult({ ...base, deleted: 3 })).toContain("3 枚を写真アプリから削除しました");
    expect(describeDeleteResult({ ...base, deleted: 3 })).toContain("30 日");
  });
  it("取り消した時は、消していないと分かる", () => {
    expect(describeDeleteResult({ ...base, cancelled: true, remaining: 3 })).toBe(
      "削除を取り消しました / 残り 3 枚",
    );
  });
  it("対象が無い時", () => {
    expect(describeDeleteResult({ ...base, requested: 0 })).toContain("ありません");
  });
  it("見送り・エラーも隠さない", () => {
    const s = describeDeleteResult({ ...base, deleted: 1, skippedNoCopy: 1, error: "timeout", remaining: 2 });
    expect(s).toContain("1 枚はアプリ側の画像が見つからない");
    expect(s).toContain("エラー: timeout");
    expect(s).toContain("残り 2 枚");
  });
});
