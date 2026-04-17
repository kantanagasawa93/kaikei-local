import { NextRequest, NextResponse } from "next/server";
import {
  getLicense,
  incrementUsage,
  isLicenseValid,
  getCurrentUsage,
} from "@/lib/license";

// 約30秒タイムアウト
export const maxDuration = 30;
export const runtime = "nodejs";

const SYSTEM_PROMPT = `あなたは日本の領収書・レシートの読み取りアシスタントです。
画像から以下の情報を正確に抽出してJSON形式で返してください。

{
  "vendor_name": "店名・取引先名",
  "amount": 金額（税込の合計金額、数値のみ。円マークやカンマは不要）,
  "date": "YYYY-MM-DD形式の日付",
  "items": ["品目1", "品目2"],
  "tax_amount": 消費税額（わかる場合、数値のみ）,
  "raw_text": "画像内の主要なテキストをそのまま書き起こし"
}

注意:
- 金額が読み取れない場合は null
- 日付が読み取れない場合は null
- 品目は主要なもののみ（最大5つ）
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

export async function POST(req: NextRequest) {
  const licenseKey = req.headers.get("x-license-key");
  if (!licenseKey) {
    return NextResponse.json(
      { error: "X-License-Key ヘッダが必要です" },
      { status: 401, headers: corsHeaders() }
    );
  }

  // ライセンスキー検証
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

  // 使用量制限
  const usage = await incrementUsage(licenseKey);
  if (!usage.ok) {
    return NextResponse.json(
      {
        error: `今月の利用上限 ${usage.limit} 枚に達しました。来月までお待ちいただくか、上位プランをご検討ください。`,
      },
      { status: 429, headers: corsHeaders() }
    );
  }

  // リクエストボディ読み込み
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

  // Claude API 呼び出し
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "サーバ設定エラー（APIキー未設定）" },
      { status: 500, headers: corsHeaders() }
    );
  }

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: body.media_type,
                  data: body.image,
                },
              },
              { type: "text", text: "この領収書の内容を読み取ってください。" },
            ],
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Claude API error:", errText);
      return NextResponse.json(
        { error: "AI 読み取りに失敗しました" },
        { status: 502, headers: corsHeaders() }
      );
    }

    const data = await anthropicRes.json();
    const text = data.content?.[0]?.text || "";

    // JSON抽出
    let parsed: any = {};
    try {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : {};
    } catch {}

    return NextResponse.json(
      {
        ...parsed,
        usage: { used: usage.used, limit: usage.limit },
      },
      { headers: corsHeaders() }
    );
  } catch (e) {
    console.error("OCR error:", e);
    return NextResponse.json(
      { error: "サーバエラー" },
      { status: 500, headers: corsHeaders() }
    );
  }
}
