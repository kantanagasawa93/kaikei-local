/**
 * 領収書スコアリング (Phase 2)
 *
 * Vision OCR で得たテキストから「これは領収書か?」を 0.0〜1.0 で評価する。
 * 完全ローカル、ネット送信なし。閾値超のものを receipt 状態にする。
 *
 * 設計:
 *   - キーワード辞書 (日英) で +score
 *   - 数値・日付パターンで +score
 *   - 自撮り / スクリーンショット / SNS 系のキーワードで -score
 *   - 縦横比 (受信箱には必須でないが Phase 2.x で利用予定)
 *
 * 閾値:
 *   - >= 0.6: receipt
 *   - 0.3〜0.6: candidate (人間判断)
 *   - < 0.3: not_receipt
 */

interface Signal {
  score: number;
  reason: string;
}

const POSITIVE_KEYWORDS_JA = [
  ["領収書", 0.4],
  ["レシート", 0.4],
  ["お買い上げ", 0.25],
  ["お買上げ", 0.25],
  ["合計", 0.15],
  ["小計", 0.15],
  ["税込", 0.15],
  ["税抜", 0.1],
  ["消費税", 0.15],
  ["内税", 0.1],
  ["外税", 0.1],
  ["お預り", 0.1],
  ["お釣り", 0.1],
  ["釣銭", 0.1],
  ["ご来店", 0.1],
  ["ありがとう", 0.05],
  ["登録番号", 0.2], // インボイス登録番号
  ["T", 0.0], // T+13桁の登録番号は別ロジックで
  ["店", 0.05],
  ["様", 0.05],
] as const;

const POSITIVE_KEYWORDS_EN = [
  ["receipt", 0.35],
  ["thank you", 0.15],
  ["total", 0.2],
  ["subtotal", 0.15],
  ["tax", 0.1],
  ["vat", 0.1],
  ["change", 0.05],
  ["cash", 0.05],
  ["card", 0.05],
  ["invoice", 0.2],
] as const;

const NEGATIVE_KEYWORDS = [
  ["スクリーンショット", -0.3],
  ["screenshot", -0.3],
  ["instagram", -0.3],
  ["twitter", -0.3],
  ["facebook", -0.2],
  ["line", -0.1],
  ["メッセージ", -0.1],
  ["selfie", -0.4],
  ["自撮り", -0.4],
] as const;

/** インボイス登録番号: T + 13桁 */
const INVOICE_NUM_RE = /T\d{13}/;

/** 金額っぽいパターン: ¥1,234 or ￥1,234 or 1,234円 or 1234 円 */
const AMOUNT_RE = /[¥￥]\s*\d{1,3}(,\d{3})*|\d{1,3}(,\d{3})*\s*円/g;

/** 日付っぽいパターン: 2025/01/02, 2025-01-02, 2025年1月2日, 令和7年1月2日 */
const DATE_RE = /\d{4}[-\/年]\s?\d{1,2}[-\/月]\s?\d{1,2}|令和\s?\d+年\s?\d{1,2}月\s?\d{1,2}日/;

/** 時刻っぽいパターン: 14:23, 14時23分 */
const TIME_RE = /\d{1,2}:\d{2}|\d{1,2}時\d{1,2}分/;

export interface ClassifyResult {
  score: number; // 0.0〜1.0 にクランプ済み
  state: "receipt" | "candidate" | "not_receipt";
  signals: Signal[];
}

export function classifyReceipt(text: string): ClassifyResult {
  if (!text || text.trim().length === 0) {
    return { score: 0, state: "not_receipt", signals: [{ score: 0, reason: "空テキスト" }] };
  }

  const lower = text.toLowerCase();
  const signals: Signal[] = [];
  let score = 0;

  for (const [kw, w] of POSITIVE_KEYWORDS_JA) {
    if (text.includes(kw as string)) {
      score += w as number;
      signals.push({ score: w as number, reason: `+ "${kw}"` });
    }
  }
  for (const [kw, w] of POSITIVE_KEYWORDS_EN) {
    if (lower.includes(kw as string)) {
      score += w as number;
      signals.push({ score: w as number, reason: `+ "${kw}"` });
    }
  }
  for (const [kw, w] of NEGATIVE_KEYWORDS) {
    if (lower.includes(kw as string)) {
      score += w as number;
      signals.push({ score: w as number, reason: `- "${kw}"` });
    }
  }

  // 金額パターンが 2回以上見つかれば領収書濃厚
  const amounts = text.match(AMOUNT_RE) ?? [];
  if (amounts.length >= 2) {
    score += 0.25;
    signals.push({ score: 0.25, reason: `+ 金額パターン x${amounts.length}` });
  } else if (amounts.length === 1) {
    score += 0.1;
    signals.push({ score: 0.1, reason: "+ 金額パターン x1" });
  }

  // 日付があれば +
  if (DATE_RE.test(text)) {
    score += 0.1;
    signals.push({ score: 0.1, reason: "+ 日付パターン" });
  }
  // 時刻もあれば領収書らしさが増す (= レシートの会計時刻)
  if (TIME_RE.test(text)) {
    score += 0.05;
    signals.push({ score: 0.05, reason: "+ 時刻パターン" });
  }

  // インボイス登録番号があれば確実
  if (INVOICE_NUM_RE.test(text)) {
    score += 0.3;
    signals.push({ score: 0.3, reason: "+ インボイス登録番号 (T+13桁)" });
  }

  // 短すぎ / 長すぎは減点 (短文 = ステッカー / 長文 = 文書スクショ)
  const len = text.length;
  if (len < 20) {
    score -= 0.2;
    signals.push({ score: -0.2, reason: `- テキスト短すぎ (${len}文字)` });
  } else if (len > 2000) {
    score -= 0.2;
    signals.push({ score: -0.2, reason: `- テキスト長すぎ (${len}文字)` });
  }

  score = Math.max(0, Math.min(1, score));

  let state: ClassifyResult["state"];
  if (score >= 0.6) state = "receipt";
  else if (score >= 0.3) state = "candidate";
  else state = "not_receipt";

  return { score, state, signals };
}
