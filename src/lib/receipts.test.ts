import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installTestDb, type TestDb } from "@/test-stubs/test-db";
import {
  findRegisteredReceiptFiles,
  originalPdfPathFor,
  selectOrphanReceiptFiles,
} from "@/lib/receipts";
import { planPdfRender } from "@/lib/pdf-to-image";

describe("originalPdfPathFor — 原本 PDF はプレビューと同じ base 名で隣に置く", () => {
  it("拡張子だけ pdf に差し替える", () => {
    expect(originalPdfPathFor("receipts/1700-abc.jpg")).toBe("receipts/1700-abc.pdf");
    expect(originalPdfPathFor("receipts/phone-1700-abc.jpg")).toBe("receipts/phone-1700-abc.pdf");
    expect(originalPdfPathFor("receipts/sub.dir/x.jpeg")).toBe("receipts/sub.dir/x.pdf");
    expect(originalPdfPathFor("receipts/noext")).toBe("receipts/noext.pdf");
  });
});

describe("selectOrphanReceiptFiles — 孤児ファイル整理で消してよいものだけを選ぶ", () => {
  const known = ["receipts/a.jpg", "receipts/b.jpg"];

  it("参照されている画像・その原本 PDF・トリミング前バックアップは残す", () => {
    const r = selectOrphanReceiptFiles(
      ["a.jpg", "a.pdf", "a.orig.jpg", "b.jpg", "junk.jpg"],
      known,
    );
    expect(r.orphans).toEqual(["receipts/junk.jpg"]);
    expect(r.kept).toBe(4);
  });

  it("スマホから受信して未登録のファイルは消さない (スマホ取込ページで扱う)", () => {
    const r = selectOrphanReceiptFiles(
      ["a.jpg", "phone-1700000000-x.jpg", "phone-1700000001-y.pdf", "junk.png"],
      known,
    );
    expect(r.orphans).toEqual(["receipts/junk.png"]);
    expect(r.pendingPhone).toBe(2);
  });

  it("登録済みのスマホ受信ファイルは通常の参照として数える", () => {
    const r = selectOrphanReceiptFiles(
      ["phone-1700000000-x.jpg", "phone-1700000000-x.pdf"],
      ["receipts/phone-1700000000-x.jpg"],
    );
    expect(r).toEqual({ orphans: [], kept: 2, pendingPhone: 0 });
  });

  it("参照がゼロなら、スマホ受信分以外は全部が孤児候補になる (呼び出し側が中止判断に使う)", () => {
    const r = selectOrphanReceiptFiles(["x.jpg", "y.jpg"], []);
    expect(r.orphans).toEqual(["receipts/x.jpg", "receipts/y.jpg"]);
    expect(r.kept).toBe(0);
  });
});

describe("findRegisteredReceiptFiles — 受信ファイルが領収書として登録済みか", () => {
  let t: TestDb;
  beforeEach(() => {
    t = installTestDb();
  });
  afterEach(() => t.close());

  it("image_url が指すファイルと、その原本 PDF を登録済みとして返す", async () => {
    t.raw.exec(
      `INSERT INTO receipts (id, image_url, status) VALUES
         ('r1', 'local://receipts/phone-1-a.jpg', 'pending'),
         ('r2', 'local://receipts/phone-2-b.jpg', 'pending')`,
    );
    const registered = await findRegisteredReceiptFiles([
      "receipts/phone-1-a.jpg",
      "receipts/phone-2-b.pdf", // r2 の原本 (プレビューは phone-2-b.jpg)
      "receipts/phone-3-c.jpg", // 未登録
    ]);
    expect([...registered].sort()).toEqual(["receipts/phone-1-a.jpg", "receipts/phone-2-b.pdf"]);
  });

  it("空の入力では DB を読まずに空を返す", async () => {
    expect((await findRegisteredReceiptFiles([])).size).toBe(0);
  });
});

describe("planPdfRender — PDF の描画倍率", () => {
  const a4 = { width: 595, height: 842 };

  it("1 ページは既定 2 倍、幅が上限を超えるなら幅に合わせて縮める", () => {
    expect(planPdfRender([a4])).toEqual({ scale: 2, width: 1190, height: 1684 });
    const wide = planPdfRender([{ width: 2000, height: 1000 }]);
    expect(wide.width).toBe(2200);
    expect(wide.scale).toBeCloseTo(1.1);
  });

  it("複数ページは縦に連結した高さが canvas の上限を超えないよう全体を縮める", () => {
    const six = planPdfRender(Array(6).fill(a4));
    expect(six.height).toBeLessThanOrEqual(15000);
    expect(six.scale).toBeGreaterThan(1.9); // 6 ページなら 2 倍のまま収まる (842*6*2 = 10104)
    const many = planPdfRender(Array(12).fill(a4));
    expect(many.height).toBeLessThanOrEqual(15000);
    expect(many.scale).toBeLessThan(2);
  });

  it("ページ幅が違う時は一番広いページに合わせる", () => {
    const plan = planPdfRender([a4, { width: 842, height: 595 }]);
    expect(plan.width).toBe(1684);
    expect(plan.height).toBe((842 + 595) * 2);
  });

  it("ページが無ければ 0x0", () => {
    expect(planPdfRender([])).toEqual({ scale: 2, width: 0, height: 0 });
  });
});
