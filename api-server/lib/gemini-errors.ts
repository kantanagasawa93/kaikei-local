/**
 * Gemini (上流) がエラーを返した時に、利用者へ返す HTTP ステータスと文言を決める。
 *
 * 以前は 429 以外をすべて 502「AI 読み取りに失敗しました」にまとめていたため、
 * 前払いクレジットが切れた時 (上流は 402) に、利用者にも運営者にも原因が見えなかった
 * (アプリは端末内 OCR に切り替わるので、止まっていること自体に気付きにくい)。
 *
 * 文言を変える時の注意: 配布済みのアプリは、この文言を正規表現で分類している
 * (src/lib/auto-journal.ts classifyOcrError)。「上限」「超過」「ライセンス」「本日」
 * 「接続」などを含めると、別の原因として案内されてしまう。機械判定は `code` で行う。
 */

export type GeminiFailureCode =
  | "upstream_credits_depleted"
  | "upstream_daily_quota"
  | "upstream_error";

export interface GeminiFailure {
  /** 利用者 (アプリ) に返す HTTP ステータス */
  status: number;
  /** 機械判定用。文言が変わっても変えない */
  code: GeminiFailureCode;
  /** アプリにそのまま表示される文言 */
  error: string;
}

/**
 * 前払いクレジット切れ。待っても直らず、運営者がチャージするまで全員が使えない。
 * 配布済みのアプリは、この失敗では端末内 OCR に切り替えない (切り替えるのは当日枠切れの時だけ)
 * ので、「代わりに何かが動く」とは書かない。
 */
export const CREDITS_DEPLETED_MESSAGE =
  "AI 読み取りを利用できません: サービス側の AI 利用残高（Gemini の前払いクレジット）が切れています。" +
  "運営者がチャージすると復旧します。";

export const DAILY_QUOTA_MESSAGE =
  "AI OCR の本日利用枠を超えました。明日以降に再試行してください (api-server の Gemini 課金を有効にすると恒久的に解決します)";

export const GENERIC_UPSTREAM_MESSAGE = "AI 読み取りに失敗しました";

/**
 * @param httpStatus Gemini API の HTTP ステータス
 * @param bodyText   Gemini API のレスポンス本文 (そのまま)
 */
export function classifyGeminiFailure(httpStatus: number, bodyText: string): GeminiFailure {
  // Google は 402 + RESOURCE_EXHAUSTED で返す。同じ内容が 429 で返ってきた場合に
  // 「本日の枠切れ・明日には直る」と案内しないよう、本文でも判定する。
  if (httpStatus === 402 || /prepayment credits|credits are depleted/i.test(bodyText)) {
    return { status: 503, code: "upstream_credits_depleted", error: CREDITS_DEPLETED_MESSAGE };
  }
  if (httpStatus === 429) {
    return { status: 429, code: "upstream_daily_quota", error: DAILY_QUOTA_MESSAGE };
  }
  return { status: 502, code: "upstream_error", error: GENERIC_UPSTREAM_MESSAGE };
}
