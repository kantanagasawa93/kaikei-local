import { NextRequest, NextResponse } from "next/server";
import {
  getLicense,
  incrementUsage,
  isLicenseValid,
} from "@/lib/license";

// 約30秒タイムアウト
export const maxDuration = 30;
export const runtime = "nodejs";

// Gemini モデル (multimodal, 安価, OCR には十分).
// gemini-2.0-flash は Free Tier 200 req/日 (2.5-flash は 20 req/日)。
// 個人事業主向けの実用レベルでは 2.0 でも十分高精度。
const GEMINI_MODEL = "gemini-2.0-flash";

const SYSTEM_PROMPT = `あなたは日本の領収書・レシートの読み取りアシスタントです。
画像から以下の情報を正確に抽出してJSON形式で返してください。

{
  "vendor_name": "店名・取引先名",
  "amount": 金額（税込の合計金額、数値のみ。円マークやカンマは不要）,
  "date": "YYYY-MM-DD形式の日付",
  "items": [
    { "name": "品目名", "price": 価格（税込、数値のみ。読めなければ null） }
  ],
  "tax_amount": 消費税額（わかる場合、数値のみ）,
  "raw_text": "画像内の主要なテキストをそのまま書き起こし"
}

注意:
- 金額が読み取れない場合は null
- 日付が読み取れない場合は null（和暦は西暦に変換）
- 品目は主要なもののみ（最大8つ）。明細単位に金額が読めるなら必ず price も埋める
- 全品目の price 合計が amount と一致することが理想（端数で1〜2円ずれても可）
- JSONのみ出力。説明文は不要`;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-License-Key",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

/** Gemini API 呼び出しが上流エラーになった時に投げる (HTTP 502 にマップ) */
class GeminiUpstreamError extends Error {
  constructor(message: string, public readonly httpStatus = 502) {
    super(message);
  }
}

/**
 * Gemini generateContent を呼んで JSON テキストを返す共通ヘルパ.
 * responseMimeType: application/json を指定して JSON だけ返させる。
 * 上流エラー時は GeminiUpstreamError を throw する。
 */
async function callGemini(
  apiKey: string,
  systemPrompt: string,
  userText: string,
  imageBase64: string,
  mediaType: string,
  maxTokens: number,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(
    apiKey,
  )}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [
        {
          role: "user",
          parts: [
            { text: userText },
            { inline_data: { mime_type: mediaType, data: imageBase64 } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        // gemini-2.0-flash は thinking が既定で無効なので thinkingConfig 不要
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("Gemini API error:", res.status, errText);
    // 429 RESOURCE_EXHAUSTED は Free Tier 上限超過。ユーザに正確に伝える。
    if (res.status === 429) {
      throw new GeminiUpstreamError(
        "AI OCR の本日利用枠を超えました。明日以降に再試行してください (api-server の Gemini 課金を有効にすると恒久的に解決します)",
        429,
      );
    }
    throw new GeminiUpstreamError("AI 読み取りに失敗しました");
  }
  const data = await res.json();
  const text: string =
    data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("") || "";
  return text;
}

function parseJsonLoose(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}

export async function POST(req: NextRequest) {
  const licenseKey = req.headers.get("x-license-key");
  if (!licenseKey) {
    return NextResponse.json(
      { error: "X-License-Key ヘッダが必要です" },
      { status: 401, headers: corsHeaders() }
    );
  }

  const license = await getLicense(licenseKey);
  if (!license) {
    return NextResponse.json(
      { error: "ライセンスキーが無効です" },
      { status: 401, headers: corsHeaders() }
    );
  }
  if (!isLicenseValid(license)) {
    return NextResponse.json(
      { error: `ライセンスが失効しています（status: ${license.status}）` },
      { status: 403, headers: corsHeaders() }
    );
  }

  const usage = await incrementUsage(licenseKey);
  if (!usage.ok) {
    return NextResponse.json(
      {
        error: `今月の利用上限 ${usage.limit} 枚に達しました。来月までお待ちいただくか、上位プランをご検討ください。`,
      },
      { status: 429, headers: corsHeaders() }
    );
  }

  let body: { image?: string; media_type?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "JSON の形式が不正です" },
      { status: 400, headers: corsHeaders() }
    );
  }
  if (!body.image || !body.media_type) {
    return NextResponse.json(
      { error: "image と media_type は必須です" },
      { status: 400, headers: corsHeaders() }
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "サーバ設定エラー（APIキー未設定）" },
      { status: 500, headers: corsHeaders() }
    );
  }

  // ?stream=1 が来てもサーバは非ストリーミングで Gemini を叩き、結果を
  // SSE 風に 1 chunk + done でエミットする (クライアント互換のため)。
  const isStream = req.nextUrl.searchParams.get("stream") === "1";

  try {
    const text = await callGemini(
      apiKey,
      SYSTEM_PROMPT,
      "この領収書の内容を読み取ってください。",
      body.image,
      body.media_type,
      4096,
    );
    const parsed = parseJsonLoose(text);

    if (!isStream) {
      return NextResponse.json(
        { ...parsed, usage: { used: usage.used, limit: usage.limit } },
        { headers: corsHeaders() }
      );
    }

    // SSE 互換: chunk(全文) → done(usage)
    const usageSnapshot = { used: usage.used, limit: usage.limit };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        };
        send("chunk", { text });
        send("done", { usage: usageSnapshot });
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        ...corsHeaders(),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    if (e instanceof GeminiUpstreamError) {
      return NextResponse.json(
        { error: e.message },
        { status: e.httpStatus, headers: corsHeaders() }
      );
    }
    console.error("OCR error:", e);
    return NextResponse.json(
      { error: "サーバエラー" },
      { status: 500, headers: corsHeaders() }
    );
  }
}
