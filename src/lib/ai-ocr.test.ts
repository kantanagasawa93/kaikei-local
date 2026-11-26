import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installTestDb, type TestDb } from "@/test-stubs/test-db";
import {
  AiOcrConsentRequiredError,
  hasAiOcrConsent,
  ocrWithClaude,
  ocrWithClaudeStream,
  setAiOcrConsent,
} from "@/lib/ai-ocr";
import { ocrPurchaseOrder } from "@/lib/po-ocr";
import { classifyOcrError } from "@/lib/auto-journal";

/**
 * 「領収書画像は、利用者の明示同意がある時だけ外部へ送る」の回帰テスト。
 * 画面側の分岐に関わらず、送信を行う関数そのものが同意なしでは fetch しないこと。
 */
describe("AI OCR — 同意なしでは画像を送信しない", () => {
  let t: TestDb;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    t = installTestDb();
    fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ vendor_name: "テスト商店", amount: "1,280", date: "2026-11-26", items: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    // ライセンスキーは設定済み (= 以前はこれだけで送信に進めた)
    t.raw.exec("INSERT INTO app_settings (id, value) VALUES ('license_key', 'KL-TEST')");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    t.close();
  });

  it("同意が未設定なら ocrWithClaude は fetch せずにエラーにする", async () => {
    expect(await hasAiOcrConsent()).toBe(false);
    await expect(ocrWithClaude("aGVsbG8=", "image/jpeg", "KL-TEST")).rejects.toBeInstanceOf(
      AiOcrConsentRequiredError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ストリーミング版・発注書 OCR も同じく送信しない", async () => {
    await expect(
      ocrWithClaudeStream("aGVsbG8=", "image/jpeg", "KL-TEST"),
    ).rejects.toBeInstanceOf(AiOcrConsentRequiredError);
    await expect(ocrPurchaseOrder("aGVsbG8=", "image/jpeg")).rejects.toBeInstanceOf(
      AiOcrConsentRequiredError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("同意を取り消した後 ('0') も送信しない", async () => {
    await setAiOcrConsent(true);
    await setAiOcrConsent(false);
    await expect(ocrWithClaude("aGVsbG8=", "image/jpeg", "KL-TEST")).rejects.toBeInstanceOf(
      AiOcrConsentRequiredError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("同意エラーは受信箱の失敗分類で『同意』バケットになる", () => {
    expect(classifyOcrError(new AiOcrConsentRequiredError().message).bucket).toBe("consent");
  });

  it("同意済みなら送信し、カンマ付きの金額も数値として受け取る", async () => {
    await setAiOcrConsent(true);
    const r = await ocrWithClaude("aGVsbG8=", "image/jpeg", "KL-TEST");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r.vendor_name).toBe("テスト商店");
    expect(r.amount).toBe(1280); // 旧実装は Number("1,280") = NaN だった
  });

  it("AI が空の結果を返した時は成功扱いにしない (¥0 の仕訳を作らせない)", async () => {
    await setAiOcrConsent(true);
    fetchSpy.mockImplementation(
      async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await expect(ocrWithClaude("aGVsbG8=", "image/jpeg", "KL-TEST")).rejects.toThrow(/読み取れません/);
  });

  it("月次上限の 429 は『本日の枠切れ』バナーを立てない / 上流の枠切れは立てる", async () => {
    await setAiOcrConsent(true);
    const quotaFlag = () =>
      t.scalar<number>("SELECT COUNT(*) FROM app_settings WHERE id LIKE '%quota%'");

    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: "今月の利用上限 500 枚に達しました。" }), { status: 429 }),
    );
    await expect(ocrWithClaude("aGVsbG8=", "image/jpeg", "KL-TEST")).rejects.toThrow(/今月の利用上限/);
    expect(quotaFlag()).toBe(0);

    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: "AI OCR の本日利用枠を超えました。" }), { status: 429 }),
    );
    await expect(ocrWithClaude("aGVsbG8=", "image/jpeg", "KL-TEST")).rejects.toThrow(/本日利用枠/);
    expect(quotaFlag()).toBeGreaterThan(0);
  });
});
