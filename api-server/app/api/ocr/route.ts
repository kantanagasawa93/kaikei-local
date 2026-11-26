import { NextRequest, NextResponse } from "next/server";
import {
  getLicense,
  incrementUsage,
  isLicenseValid,
  refundUsage,
} from "@/lib/license";
import { classifyGeminiFailure, type GeminiFailureCode } from "@/lib/gemini-errors";

// 約30秒タイムアウト
export const maxDuration = 30;
export const runtime = "nodejs";

// Gemini モデル. Tier 1 (有料) 課金されていれば 2.5-flash の方が高精度。
// thinking は構造化抽出には不要なので thinkingBudget=0 で OFF にする。
const GEMINI_MODEL = "gemini-2.5-flash";

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

/** Gemini API 呼び出しが上流エラーになった時に投げる (返すステータスと文言は gemini-errors.ts が決める) */
class GeminiUpstreamError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly code: GeminiFailureCode,
  ) {
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
        // 2.5-flash は既定で thinking を行うが、構造化抽出には不要なので OFF
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("Gemini API error:", res.status, errText);
    // 当日枠切れ (429) と前払いクレジット切れ (402) は、原因が分かる文言で返す。
    const failure = classifyGeminiFailure(res.status, errText);
    throw new GeminiUpstreamError(failure.error, failure.status, failure.code);
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

  // ライセンス台帳 (Upstash Redis) に到達できない時は例外になる。未処理のまま
  // 500 を返すと利用者には原因が分からないので、503 で明示する。
  let license: Awaited<ReturnType<typeof getLicense>>;
  try {
    license = await getLicense(licenseKey);
  } catch (e) {
    console.error("license lookup failed:", e);
    return NextResponse.json(
      { error: "ライセンスを確認できませんでした。時間をおいて再試行してください。" },
      { status: 503, headers: corsHeaders() }
    );
  }
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

  // リクエスト自体が不正・サーバ設定不備の場合に月次枠を消費しないよう、
  // 枠のカウントアップは「これから実際に Gemini を呼ぶ」直前まで遅らせる。
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

  const usage = await incrementUsage(licenseKey);
  if (!usage.ok) {
    return NextResponse.json(
      {
        error: `今月の利用上限 ${usage.limit} 枚に達しました。来月までお待ちいただくか、上位プランをご検討ください。`,
      },
      { status: 429, headers: corsHeaders() }
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
    // 結果を返せなかったので、消費した 1 枚分を戻す
    await refundUsage(licenseKey);
    if (e instanceof GeminiUpstreamError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
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
