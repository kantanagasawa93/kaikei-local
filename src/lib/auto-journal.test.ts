import { describe, it, expect } from "vitest";
import { classifyOcrError } from "@/lib/auto-journal";

// 受信箱「失敗」タブの bucket 集計・自動リトライ判定の土台。
// bucket が変わると UI のフィルタ/hint/リトライ対象が変わるので固定する。
describe("classifyOcrError", () => {
  it("空 / null は unknown", () => {
    expect(classifyOcrError(null).bucket).toBe("unknown");
    expect(classifyOcrError("").bucket).toBe("unknown");
    expect(classifyOcrError(undefined).bucket).toBe("unknown");
  });

  it("Gemini 本日利用枠系は quota", () => {
    expect(classifyOcrError("本日利用枠を超えました").bucket).toBe("quota");
    expect(classifyOcrError("HTTP 429 RESOURCE_EXHAUSTED").bucket).toBe("quota");
  });

  it("ライセンス上限は license", () => {
    expect(classifyOcrError("monthly_limit exceeded").bucket).toBe("license");
    expect(classifyOcrError("ライセンスが未設定です").bucket).toBe("license");
  });

  it("同意なしは consent", () => {
    expect(classifyOcrError("AI OCR の同意がありません").bucket).toBe("consent");
  });

  it("ネットワーク系は network (リトライ対象)", () => {
    expect(classifyOcrError("fetch failed").bucket).toBe("network");
    expect(classifyOcrError("ECONNREFUSED 127.0.0.1").bucket).toBe("network");
  });

  it("画像読込系は image", () => {
    expect(classifyOcrError("read_image_file: no such file").bucket).toBe("image");
  });

  it("サーバー 5xx は server (リトライ対象)", () => {
    expect(classifyOcrError("API error (503)").bucket).toBe("server");
    expect(classifyOcrError("Internal Server Error").bucket).toBe("server");
  });
});
