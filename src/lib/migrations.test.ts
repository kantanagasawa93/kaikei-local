import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { installTestDb, loadMigrations, type TestDb } from "@/test-stubs/test-db";
import { TAX_CLASSES } from "@/lib/tax-classes";

/**
 * 新規インストール (空の DB) からマイグレーションを順に適用できることの回帰テスト。
 *
 * 開発機の DB は v1 から順に育ってきたので、途中のマイグレーションが
 * 「既に何か入っている DB」でしか通らない書き方になっても気付けない。
 * 別の Mac に初めて入れた時にだけ壊れる、という事故をここで止める。
 */
describe("DB マイグレーション (新規インストール)", () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.close();
    t = null;
  });

  it("lib.rs の sql_migrations は 1 から欠番・重複なく並んでいる", () => {
    const versions = loadMigrations().map((m) => m.version);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions).toEqual(versions.map((_, i) => i + 1));
  });

  it("空の DB に全マイグレーションを適用できる", () => {
    t = installTestDb();
    const tables = t
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .map((r) => r.name);
    // アプリが読み書きする主要テーブルが揃っていること
    for (const name of [
      "accounts",
      "app_settings",
      "auto_rules",
      "bank_accounts",
      "bank_transactions",
      "biz_allocations",
      "fixed_asset_depreciations",
      "fixed_assets",
      "invoice_items",
      "invoices",
      "issuer_settings",
      "journal_lines",
      "journals",
      "partners",
      "photo_inbox",
      "photo_scan_log",
      "receipts",
      "tax_classes",
      "tax_return_expenses",
      "tax_returns",
      "withholding_slips",
    ]) {
      expect(tables, `テーブル ${name}`).toContain(name);
    }
    expect(t.scalar<string>("PRAGMA integrity_check")).toBe("ok");
    expect(t.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("税区分マスタが投入され、コード内の TAX_CLASSES と一致する", () => {
    t = installTestDb();
    const rows = t.all<{ code: string; rate: number }>(
      "SELECT code, rate FROM tax_classes ORDER BY code",
    );
    const fromCode = TAX_CLASSES.map((c) => ({ code: c.code, rate: c.rate })).sort((a, b) =>
      a.code.localeCompare(b.code),
    );
    expect(rows.map((r) => ({ code: r.code, rate: r.rate }))).toEqual(fromCode);
  });

  it("新規インストール直後は勘定科目テーブルが空 (既定科目はコード側が正)", () => {
    // ここが空であることを前提に、科目の解決は DEFAULT_ACCOUNTS を土台にしている。
    // 将来シードを入れる場合は journal-commit / 集計側の前提も合わせて見直すこと。
    t = installTestDb();
    expect(t.scalar("SELECT COUNT(*) FROM accounts")).toBe(0);
  });
});

describe("v14: photo_inbox.state_changed_at はトリガで維持される", () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.close();
    t = null;
  });
  const changedAt = (id: string) =>
    t!.scalar<string | null>("SELECT state_changed_at FROM photo_inbox WHERE id = ?", id);

  it("追加した時と、state が変わった時だけ更新される", () => {
    t = installTestDb();
    t.raw.exec(
      "INSERT INTO photo_inbox (id, source_asset_id, taken_at) VALUES ('a', 'asset-a', '2020-01-01T00:00:00Z')",
    );
    const inserted = changedAt("a");
    expect(inserted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    // state 以外の列を更新しても変わらない
    t.raw.exec("UPDATE photo_inbox SET state_changed_at = '2001-01-01T00:00:00Z' WHERE id = 'a'");
    t.raw.exec("UPDATE photo_inbox SET ocr_text = 'x', last_viewed_at = 'y' WHERE id = 'a'");
    expect(changedAt("a")).toBe("2001-01-01T00:00:00Z");
    // 同じ state を書いても変わらない
    t.raw.exec("UPDATE photo_inbox SET state = 'candidate' WHERE id = 'a'");
    expect(changedAt("a")).toBe("2001-01-01T00:00:00Z");
    // state が変わったら「いま」になる
    t.raw.exec("UPDATE photo_inbox SET state = 'dismissed' WHERE id = 'a'");
    expect(changedAt("a")).not.toBe("2001-01-01T00:00:00Z");
    expect(changedAt("a")).toMatch(/^20\d{2}-/);
  });

  it("明示的に指定して追加した値は尊重する (復元・取り消しで元の時刻を戻せる)", () => {
    t = installTestDb();
    t.raw.exec(
      `INSERT INTO photo_inbox (id, source_asset_id, taken_at, state, state_changed_at)
       VALUES ('b', 'asset-b', '2020-01-01T00:00:00Z', 'dismissed', '2024-05-05T00:00:00Z')`,
    );
    expect(changedAt("b")).toBe("2024-05-05T00:00:00Z");
  });

  it("既存データの移行: 破棄済みは『いま』から数え直し、それ以外は受信箱に入った時刻", () => {
    // v13 までを適用した DB に既存行を入れてから v14 を適用する
    const raw = new DatabaseSync(":memory:");
    const migs = loadMigrations();
    for (const m of migs.filter((x) => x.version <= 13)) raw.exec(m.sql);
    raw.exec(`
      INSERT INTO photo_inbox (id, source_asset_id, taken_at, detected_at, state) VALUES
        ('old-dismissed', 'a1', '2020-01-01T00:00:00Z', '2020-01-02 00:00:00', 'dismissed'),
        ('old-candidate', 'a2', '2020-01-01T00:00:00Z', '2020-01-03 00:00:00', 'candidate');
      INSERT INTO receipts (id, image_url) VALUES ('r', 'local://receipts/x.jpg');
      INSERT INTO photo_inbox (id, source_asset_id, taken_at, detected_at, state, imported_receipt_id, imported_at) VALUES
        ('old-imported', 'a3', '2020-01-01T00:00:00Z', '2020-01-04 00:00:00', 'imported', 'r', '2020-02-02T00:00:00Z');
    `);
    raw.exec(migs.find((x) => x.version === 14)!.sql);
    const get = (id: string) =>
      (raw.prepare("SELECT state_changed_at AS v FROM photo_inbox WHERE id = ?").get(id) as { v: string }).v;
    expect(get("old-dismissed").slice(0, 4)).not.toBe("2020"); // 物理削除までの猶予を数え直す
    expect(get("old-candidate")).toBe("2020-01-03 00:00:00");
    expect(get("old-imported")).toBe("2020-02-02T00:00:00Z");
    raw.close();
  });
});
