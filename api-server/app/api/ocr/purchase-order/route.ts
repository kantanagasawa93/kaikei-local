/**
 * Round 28: 発注書 (Purchase Order) → 請求書自動生成のための専用 OCR エンドポイント.
 *
 * 領収書用 /api/ocr とほぼ同じ実装だが、Claude へのプロンプトを「発注書を
 * 読んで請求書の元データとして抽出する」用に書き換える。
 *
 * 抽出フィールド:
 *   - partner_name: 発注元の企業名 / 個人名 (= 請求先になる)
 *   - partner_address: 発注元の住所 (任意)
 *   - po_number: 発注番号 (請求書の notes に転記)
 *   - issue_date: 発注書発行日 (請求書の起算点)
 *   - due_date: 希望納期 (請求書の支払期限の候補)
 *   - items: [{ description, quantity, unit, unit_price, amount }]
 *   - subtotal: 小計
 *   - tax_amount: 消費税
 *   - total: 合計
 *   - subject: 件名 (案件名 / プロジェクト名)
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getLicense,
  incrementUsage,
  isLicenseValid,
} from "@/lib/license";

export const maxDuration = 30;
export const runtime = "nodejs";

const SYSTEM_PROMPT = `あなたは日本の発注書 (Purchase Order) の読み取りアシスタントです。
画像から以下の情報を正確に抽出してJSON形式で返してください。
発注書は「これから仕事を発注します」という書類で、これを受けて受注側 (KAIKEI LOCAL のユーザ)
が「請求書」を発行することになります。

{
  "partner_name": "発注元の企業名・個人名 (= 請求先)",
  "partner_address": "発注元の住所 (なければ null)",
  "po_number": "発注書番号・注文番号 (なければ null)",
  "issue_date": "発注書発行日 YYYY-MM-DD (なければ null)",
  "due_date": "希望納期・締日 YYYY-MM-DD (なければ null)",
  "subject": "件名・案件名・プロジェクト名 (なければ null)",
  "items": [
    {
      "description": "品名・サービス名",
      "quantity": 数量 (数値、なければ 1),
      "unit": "個 / 時間 / 式 など (なければ null)",
      "unit_price": 単価 (税抜、数値。読めなければ null),
      "amount": 金額 (税抜小計、数値。読めなければ null)
    }
  ],
  "subtotal": 小計 (税抜合計、数値。読めなければ null),
  "tax_amount": 消費税額 (10% / 8% / 軽減税率混在を考慮、数値。読めなければ null),
  "total": 合計 (税込、数値。読めなければ null),
  "raw_text": "画像内の主要なテキストをそのまま書き起こし"
}

注意:
- 発注先 (= 受注者、自分) の情報は無視する。あくまで「発注元 = 請求先」を抽出
- 金額が読み取れない場合は null
- 日付は和暦 (令和) も西暦に変換 (令和7年 → 2025年)
- items は最大 20 件まで
- unit_price × quantity = amount になることが理想 (端数ずれは許容)
- JSON のみ出力、説明文は不要`;

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

  // 領収書 OCR と同じ枠を消費する (PO も Claude API を 1 回呼ぶため公平)
  const usage = await incrementUsage(licenseKey);
  if (!usage.ok) {
    return NextResponse.json(
      {
        error: `今月の利用上限 ${usage.limit} 枚に達しました。`,
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "サーバ設定エラー（APIキー未設定）" },
      { status: 500, headers: corsHeaders() }
    );
  }

  const claudeBody = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048, // items が多めの PO もあるので領収書より大きめ
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
          {
            type: "text",
            text: "この発注書を読み取って、請求書の元データを抽出してください。",
          },
        ],
      },
    ],
  };

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(claudeBody),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Claude API error (PO):", errText);
      return NextResponse.json(
        { error: "AI 読み取りに失敗しました" },
        { status: 502, headers: corsHeaders() }
      );
    }

    const data = await anthropicRes.json();
    const text = data.content?.[0]?.text || "";
    let parsed: Record<string, unknown> = {};
    try {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : {};
    } catch {
      /* fall through with empty parsed */
    }
    return NextResponse.json(
      {
        ...parsed,
        usage: { used: usage.used, limit: usage.limit },
      },
      { headers: corsHeaders() }
    );
  } catch (e) {
    console.error("PO OCR error:", e);
    return NextResponse.json(
      { error: "サーバエラー" },
      { status: 500, headers: corsHeaders() }
    );
  }
}
