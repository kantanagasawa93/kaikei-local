import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installTestDb, type TestDb } from "@/test-stubs/test-db";

// 受信箱の画像読み込み (Rust の read_image_file) を固定バイト列に差し替える
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "read_image_file") return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    throw new Error(`unexpected invoke: ${cmd}`);
  }),
}));

import {
  AlreadyJournalizedError,
  NotFromInboxError,
  autoJournalizeAllReceipts,
  autoJournalizeOne,
  bulkDeleteJournals,
  normalizeOcrDate,
  quickConfirmOne,
  rejournalize,
  reverseJournalToInbox,
  undoBulkDelete,
  undoLastReverse,
  getReverseUndoCount,
} from "@/lib/auto-journal";
import { setAiOcrConsent } from "@/lib/ai-ocr";

let t: TestDb;
let fetchSpy: ReturnType<typeof vi.fn>;

function ocrResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function addInbox(id: string, state = "receipt", takenAt = "2026-03-10T01:00:00Z") {
  t.raw
    .prepare(
      `INSERT INTO photo_inbox (id, source_asset_id, file_path, state, ocr_text, taken_at)
       VALUES (?, ?, ?, ?, 'セブン-イレブン 合計 1,100', ?)`,
    )
    .run(id, `asset-${id}`, `/tmp/inbox/${id}.jpg`, state, takenAt);
}

const count = (table: string, where = "1=1") =>
  t.scalar<number>(`SELECT COUNT(*) FROM ${table} WHERE ${where}`);
const inboxState = (id: string) =>
  t.scalar<string>("SELECT state FROM photo_inbox WHERE id = ?", id);

beforeEach(async () => {
  t = installTestDb();
  t.raw.exec("INSERT INTO app_settings (id, value) VALUES ('license_key', 'KL-TEST')");
  await setAiOcrConsent(true);
  fetchSpy = vi.fn(async () =>
    ocrResponse({ vendor_name: "セブン-イレブン", amount: 1100, date: "2026-03-09", items: [] }),
  );
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  t.close();
});

describe("normalizeOcrDate", () => {
  it("区切りの違いを吸収して YYYY-MM-DD にする", () => {
    expect(normalizeOcrDate("2026-03-09")).toBe("2026-03-09");
    expect(normalizeOcrDate("2026/3/9")).toBe("2026-03-09");
    expect(normalizeOcrDate("2026年3月9日")).toBe("2026-03-09");
    expect(normalizeOcrDate("20260309")).toBe("2026-03-09");
    expect(normalizeOcrDate("２０２６／３／９")).toBe("2026-03-09");
  });
  it("あり得ない日付・読めない文字列は null (期間集計から消える仕訳を作らない)", () => {
    expect(normalizeOcrDate("2026-02-30")).toBeNull();
    expect(normalizeOcrDate("2026-13-01")).toBeNull();
    expect(normalizeOcrDate("R8.3.9")).toBeNull();
    expect(normalizeOcrDate("不明")).toBeNull();
    expect(normalizeOcrDate("")).toBeNull();
    expect(normalizeOcrDate(null)).toBeNull();
  });
});

describe("autoJournalizeOne — 受信箱の写真 1 枚を仕訳化", () => {
  it("領収書・仕訳・明細を作り、受信箱を取り込み済みにする", async () => {
    addInbox("p1");
    const receiptId = await autoJournalizeOne({ id: "p1", file_path: "/tmp/inbox/p1.jpg", ocr_text: null });
    expect(receiptId).toBeTruthy();
    expect(count("receipts")).toBe(1);
    expect(count("journals")).toBe(1);
    expect(inboxState("p1")).toBe("imported");
    expect(t.scalar("SELECT imported_receipt_id FROM photo_inbox WHERE id='p1'")).toBe(receiptId);

    const lines = t.all<{ account_code: string; debit_amount: number; credit_amount: number; tax_code: string; tax_amount: number }>(
      "SELECT account_code, debit_amount, credit_amount, tax_code, tax_amount FROM journal_lines ORDER BY debit_amount DESC",
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ debit_amount: 1100, credit_amount: 0, tax_code: "P10", tax_amount: 100 });
    expect(lines[1]).toMatchObject({ account_code: "100", debit_amount: 0, credit_amount: 1100, tax_code: "OUT" });
    expect(t.scalar("SELECT date FROM journals")).toBe("2026-03-09");
  });

  it("同じ写真を 2 回仕訳化しない (領収書登録ページ・一括仕訳・カードのボタンが重なっても)", async () => {
    addInbox("p1");
    const row = { id: "p1", file_path: "/tmp/inbox/p1.jpg", ocr_text: null };
    await autoJournalizeOne(row);
    await expect(autoJournalizeOne(row)).rejects.toBeInstanceOf(AlreadyJournalizedError);
    await expect(quickConfirmOne("p1")).rejects.toBeInstanceOf(AlreadyJournalizedError);
    expect(count("receipts")).toBe(1);
    expect(count("journals")).toBe(1);
    expect(inboxState("p1")).toBe("imported"); // 「失敗」に落とさない
    expect(fetchSpy).toHaveBeenCalledTimes(1); // 2 回目以降は OCR も呼ばない
  });

  it("同時に 2 本走らせても 1 組しか作らない (Enter 連打・一括仕訳中のクリック)", async () => {
    addInbox("p1");
    const row = { id: "p1", file_path: "/tmp/inbox/p1.jpg", ocr_text: null };
    const results = await Promise.allSettled([autoJournalizeOne(row), autoJournalizeOne(row)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(count("receipts")).toBe(1);
    expect(count("journals")).toBe(1);
  });

  it("日付が読めない時は『今日』ではなく写真の撮影日を使い、要確認として残す", async () => {
    addInbox("p1", "receipt", "2026-01-15T03:00:00Z");
    fetchSpy.mockImplementation(async () =>
      ocrResponse({ vendor_name: "不明な店", amount: 500, date: "読み取り不可", items: [] }),
    );
    await autoJournalizeOne({ id: "p1", file_path: "/tmp/inbox/p1.jpg", ocr_text: null });
    expect(t.scalar("SELECT date FROM journals")).toBe("2026-01-15");
    expect(t.scalar("SELECT status FROM receipts")).toBe("pending");
    expect(t.scalar("SELECT date FROM receipts")).toBeNull();
  });

  it("消費税がかからない科目には仕入税額を立てない", async () => {
    addInbox("p1");
    // 取引先の既定科目 = 租税公課 (利用者が決めたもの。キーワード推測より優先される)
    t.raw.exec(
      "INSERT INTO partners (id, name, default_account_code) VALUES ('pt', '福岡市役所', '601')",
    );
    fetchSpy.mockImplementation(async () =>
      ocrResponse({ vendor_name: "福岡市役所", amount: 3000, date: "2026-03-09", items: [] }),
    );
    await autoJournalizeOne({ id: "p1", file_path: "/tmp/inbox/p1.jpg", ocr_text: null });
    const debit = t.all<{ account_code: string; tax_code: string; tax_amount: number }>(
      "SELECT account_code, tax_code, tax_amount FROM journal_lines WHERE debit_amount > 0",
    )[0];
    expect(debit).toEqual({ account_code: "601", tax_code: "OUT", tax_amount: 0 });
  });

  it("途中で失敗したら、作りかけの領収書・仕訳を残さない", async () => {
    addInbox("p1");
    // 明細の書き込みだけ失敗させる
    t.raw.exec("ALTER TABLE journal_lines RENAME TO journal_lines_hidden");
    await expect(
      autoJournalizeOne({ id: "p1", file_path: "/tmp/inbox/p1.jpg", ocr_text: null }),
    ).rejects.toThrow();
    t.raw.exec("ALTER TABLE journal_lines_hidden RENAME TO journal_lines");
    expect(count("receipts")).toBe(0);
    expect(count("journals")).toBe(0);
    expect(inboxState("p1")).toBe("receipt");
  });

  it("一括仕訳: 一覧取得後に仕訳化済みになった写真は失敗扱いにしない", async () => {
    addInbox("p1");
    addInbox("p2");
    let first = true;
    fetchSpy.mockImplementation(async () => {
      if (first) {
        first = false;
        // p1 の OCR 中に、p2 が別の経路 (領収書登録ページ) で取り込み済みになった想定
        t.raw.exec("INSERT INTO receipts (id, image_url) VALUES ('manual', 'local://receipts/x.jpg')");
        t.raw.exec("UPDATE photo_inbox SET state='imported', imported_receipt_id='manual' WHERE id='p2'");
      }
      return ocrResponse({ vendor_name: "店", amount: 100, date: "2026-03-09", items: [] });
    });
    const r = await autoJournalizeAllReceipts();
    expect(r.imported).toBe(1);
    expect(r.failed).toBe(0);
    expect(inboxState("p2")).toBe("imported");
    expect(count("journals")).toBe(1);
  });
});

describe("rejournalize / 差し戻し", () => {
  async function journalized(id = "p1") {
    addInbox(id);
    await autoJournalizeOne({ id, file_path: `/tmp/inbox/${id}.jpg`, ocr_text: null });
    return t.scalar<string>("SELECT id FROM journals LIMIT 1");
  }

  it("OCR に失敗しても元の仕訳・領収書は消えない (旧実装は先に消していた)", async () => {
    const journalId = await journalized();
    fetchSpy.mockImplementation(async () => ocrResponse({ error: "Internal Server Error" }, 500));
    await expect(rejournalize(journalId)).rejects.toThrow();
    expect(count("journals")).toBe(1);
    expect(count("receipts")).toBe(1);
    expect(count("journal_lines")).toBe(2);
    expect(inboxState("p1")).toBe("imported");
    expect(await getReverseUndoCount()).toBe(0);
  });

  it("同意を取り消した後も、元の仕訳は消えない", async () => {
    const journalId = await journalized();
    await setAiOcrConsent(false);
    await expect(rejournalize(journalId)).rejects.toThrow(/同意/);
    expect(count("journals")).toBe(1);
    expect(count("receipts")).toBe(1);
  });

  it("成功したら仕訳は 1 本のまま。取り消しで古い仕訳が復活して 2 本にならない", async () => {
    const journalId = await journalized();
    fetchSpy.mockImplementation(async () =>
      ocrResponse({ vendor_name: "セブン-イレブン", amount: 1980, date: "2026-03-09", items: [] }),
    );
    await rejournalize(journalId);
    expect(count("journals")).toBe(1);
    expect(t.scalar("SELECT SUM(debit_amount) FROM journal_lines")).toBe(1980);
    expect(await getReverseUndoCount()).toBe(0);
    expect(await undoLastReverse()).toEqual({ restored: false });
    expect(count("journals")).toBe(1);
  });

  it("利用者が直した値 (presetOcr) で作り直し、AI OCR は呼ばない", async () => {
    const journalId = await journalized();
    fetchSpy.mockClear();
    await rejournalize(journalId, {
      presetOcr: {
        raw_text: "",
        vendor_name: "セブン-イレブン",
        amount: 1980,
        date: "2026-03-08",
        suggested_account_code: null,
        suggested_account_name: null,
        items: [],
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(count("journals")).toBe(1);
    expect(t.scalar("SELECT SUM(debit_amount) FROM journal_lines")).toBe(1980);
    expect(t.scalar("SELECT date FROM journals")).toBe("2026-03-08");
  });

  it("受信箱由来でない仕訳は、何も消さずに断る", async () => {
    t.raw.exec("INSERT INTO receipts (id, image_url, status) VALUES ('r1', 'local://receipts/a.jpg', 'confirmed')");
    t.raw.exec("INSERT INTO journals (id, date, description, receipt_id) VALUES ('j1', '2026-03-01', '手入力', 'r1')");
    t.raw.exec("INSERT INTO journal_lines (id, journal_id, account_code, account_name, debit_amount) VALUES ('l1', 'j1', '610', '消耗品費', 500)");
    await expect(reverseJournalToInbox("j1")).rejects.toBeInstanceOf(NotFromInboxError);
    await expect(rejournalize("j1")).rejects.toBeInstanceOf(NotFromInboxError);
    expect(count("journals")).toBe(1);
    expect(count("receipts")).toBe(1);
    expect(count("journal_lines")).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("差し戻し → 取り消しで元通り", async () => {
    const journalId = await journalized();
    await reverseJournalToInbox(journalId);
    expect(count("journals")).toBe(0);
    expect(count("receipts")).toBe(0);
    expect(inboxState("p1")).toBe("candidate");
    const r = await undoLastReverse();
    expect(r).toEqual({ restored: true, journalId });
    expect(count("journals")).toBe(1);
    expect(count("journal_lines")).toBe(2);
    expect(count("receipts")).toBe(1);
    expect(inboxState("p1")).toBe("imported");
  });

  it("差し戻した写真を仕訳化し直した後は、取り消しを断る (同じ写真の仕訳が 2 本になるため)", async () => {
    const journalId = await journalized();
    await reverseJournalToInbox(journalId);
    await quickConfirmOne("p1"); // 受信箱からもう一度仕訳化
    expect(count("journals")).toBe(1);
    await expect(undoLastReverse()).rejects.toThrow(/もう一度仕訳化/);
    expect(count("journals")).toBe(1);
    expect(await getReverseUndoCount()).toBe(1); // スナップショットは消費しない
  });
});

describe("bulkDeleteJournals / undoBulkDelete — 仕訳削除と関連データの整合", () => {
  it("受信箱由来の仕訳を消すと写真は未判定に戻り、取り消しで全部元に戻る", async () => {
    addInbox("p1");
    await autoJournalizeOne({ id: "p1", file_path: "/tmp/inbox/p1.jpg", ocr_text: null });
    const journalId = t.scalar<string>("SELECT id FROM journals");

    expect(await bulkDeleteJournals([journalId])).toBe(1);
    expect(count("journals")).toBe(0);
    expect(count("journal_lines")).toBe(0);
    expect(count("receipts")).toBe(0);
    expect(inboxState("p1")).toBe("candidate"); // 「取り込み済み」のまま取り残さない

    expect(await undoBulkDelete()).toEqual({ restored: 1 });
    expect(count("journals")).toBe(1);
    expect(count("journal_lines")).toBe(2);
    expect(count("receipts")).toBe(1);
    expect(inboxState("p1")).toBe("imported");
  });

  it("明細取込の行は未仕訳に戻り、減価償却の記録は消える。取り消しで戻る", async () => {
    t.raw.exec(`
      INSERT INTO journals (id, date, description) VALUES ('jb', '2026-04-01', '振込'), ('jd', '2026-12-31', '減価償却');
      INSERT INTO journal_lines (id, journal_id, account_code, account_name, debit_amount) VALUES
        ('lb', 'jb', '604', '旅費交通費', 1000), ('ld', 'jd', '611', '減価償却費', 50000);
      INSERT INTO bank_accounts (id, name, bank_name) VALUES ('ba', '事業用口座', '銀行');
      INSERT INTO bank_transactions (id, bank_account_id, date, description, amount, journal_id, status)
        VALUES ('tx', 'ba', '2026-04-01', 'フリコミ', 1000, 'jb', 'matched');
      INSERT INTO fixed_assets (id, name, asset_account_code, acquisition_date, acquisition_cost, useful_life_years)
        VALUES ('fa', 'PC', '163', '2026-01-10', 300000, 4);
      INSERT INTO fixed_asset_depreciations (id, fixed_asset_id, fiscal_year, depreciation_amount, book_value_after, posted_journal_id)
        VALUES ('dep', 'fa', 2026, 50000, 250000, 'jd');
    `);

    expect(await bulkDeleteJournals(["jb", "jd"])).toBe(2);
    expect(t.all("SELECT status, journal_id FROM bank_transactions")).toEqual([
      { status: "unmatched", journal_id: null },
    ]);
    // 残っていると「その年は仕訳化済み」と判定され、二度と計上できなくなる
    expect(count("fixed_asset_depreciations")).toBe(0);

    expect(await undoBulkDelete()).toEqual({ restored: 2 });
    expect(t.all("SELECT status, journal_id FROM bank_transactions")).toEqual([
      { status: "matched", journal_id: "jb" },
    ]);
    expect(t.all("SELECT posted_journal_id FROM fixed_asset_depreciations")).toEqual([
      { posted_journal_id: "jd" },
    ]);
  });

  it("手動登録の領収書は残し、状態だけ『確認済』から戻す", async () => {
    t.raw.exec(`
      INSERT INTO receipts (id, image_url, status) VALUES ('r1', 'local://receipts/a.jpg', 'confirmed');
      INSERT INTO journals (id, date, description, receipt_id) VALUES ('j1', '2026-03-01', '手入力', 'r1');
      INSERT INTO journal_lines (id, journal_id, account_code, account_name, debit_amount) VALUES ('l1', 'j1', '610', '消耗品費', 500);
    `);
    await bulkDeleteJournals(["j1"]);
    expect(t.scalar("SELECT status FROM receipts WHERE id='r1'")).toBe("processed");
    await undoBulkDelete();
    expect(t.scalar("SELECT status FROM receipts WHERE id='r1'")).toBe("confirmed");
    expect(t.scalar("SELECT receipt_id FROM journals WHERE id='j1'")).toBe("r1");
  });

  it("別の仕訳も参照している領収書は消さない", async () => {
    addInbox("p1");
    await autoJournalizeOne({ id: "p1", file_path: "/tmp/inbox/p1.jpg", ocr_text: null });
    const receiptId = t.scalar<string>("SELECT id FROM receipts");
    const first = t.scalar<string>("SELECT id FROM journals");
    t.raw
      .prepare("INSERT INTO journals (id, date, description, receipt_id) VALUES ('j2', '2026-03-09', '同じ証憑', ?)")
      .run(receiptId);
    await bulkDeleteJournals([first]);
    expect(count("receipts")).toBe(1);
    expect(t.scalar("SELECT receipt_id FROM journals WHERE id='j2'")).toBe(receiptId);
    expect(inboxState("p1")).toBe("imported");
  });
});
