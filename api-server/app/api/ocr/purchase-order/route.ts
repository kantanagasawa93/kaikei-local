/**
 * Round 28: 発注書 (Purchase Order) → 請求書自動生成のための OCR エンドポイント.
 *
 * Gemini Vision (gemini-2.5-flash) で発注書を読み、請求書の元データを抽出する。
 * 領収書用 /api/ocr とは抽出スキーマが違うので別ルート。
 *
 * 抽出フィールド:
 *   partner_name / partner_address / po_number / issue_date / due_date /
 *   subject / items[{description,quantity,unit,unit_price,amount}] /
 *   subtotal / tax_amount / total / raw_text
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getLicense,
  incrementUsage,
  isLicenseValid,
} from "@/lib/license";

export const maxDuration = 30;
export const runtime = "nodejs";

// gemini-2.0-flash は Free Tier 200 req/日 (2.5-flash は 20 req/日)。
// 発注書の構造化抽出は 2.0 でも十分なため切替えて quota を緩める。
const GEMINI_MODEL = "gemini-2.0-flash";

const SYSTEM_PROMPT = `あなたは日本の発注書 (Purchase Order) の読み取りアシスタントです。
画像から以下の情報を正確に抽出してJSON形式で返してください。
発注書は「これから仕事を発注します」という書類で、これを受けて受注側 (KAIKEI LOCAL のユーザ)
が「請求書」を発行します。

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
  "tax_amount": 消費税額 (数値。読めなければ null),
  "withholding_tax": 源泉徴収税額 (数値、正の値。書類に書かれていなければ null),
  "total": 請求金額 = 小計 + 消費税 − 源泉徴収 (実際にクライアントが振込む額、数値。読めなければ null),
  "raw_text": "画像内の主要なテキストをそのまま書き起こし"
}

注意:
- 発注先 (= 受注者、自分) の情報は無視。あくまで「発注元 = 請求先」を抽出
- 金額が読み取れない場合は null
- 日付は和暦 (令和) も西暦に変換 (令和7年 → 2025年)
- items は最大 20 件
- unit_price × quantity = amount になることが理想 (端数ずれ可)
- 源泉徴収税 (源泉所得税): 「源泉徴収」「源泉所得税」「源泉税」と書かれた額を正の値で抽出。
  個人事業主の報酬では税率 10.21% (100万円超部分は 20.42%) が一般的
- total は「お支払い金額」「ご請求額」「差引請求額」など、源泉徴収後の最終振込額を採用
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

  // 領収書 OCR と同じ月次枠を消費 (Gemini API を 1 回呼ぶため公平)
  const usage = await incrementUsage(licenseKey);
  if (!usage.ok) {
    return NextResponse.json(
      { error: `今月の利用上限 ${usage.limit} 枚に達しました。` },
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

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(
      apiKey,
    )}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: "この発注書を読み取って、請求書の元データを抽出してください。",
              },
              {
                inline_data: {
                  mime_type: body.media_type,
                  data: body.image,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          // gemini-2.0-flash は thinking が既定で無効。品目が多い発注書のため
          // maxOutputTokens は余裕を持たせる。
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Gemini API error (PO):", res.status, errText);
      if (res.status === 429) {
        return NextResponse.json(
          {
            error:
              "AI OCR の本日利用枠を超えました。明日以降に再試行してください (api-server の Gemini 課金を有効にすると恒久的に解決します)",
          },
          { status: 429, headers: corsHeaders() }
        );
      }
      return NextResponse.json(
        { error: "AI 読み取りに失敗しました" },
        { status: 502, headers: corsHeaders() }
      );
    }

    const data = await res.json();
    const text: string =
      data?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text || "")
        .join("") || "";
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          /* fall through */
        }
      }
    }

    return NextResponse.json(
      { ...parsed, usage: { used: usage.used, limit: usage.limit } },
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
