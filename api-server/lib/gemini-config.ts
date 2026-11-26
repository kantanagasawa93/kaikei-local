/**
 * Gemini の呼び出し設定 (領収書 OCR / 発注書 OCR で共用)。
 *
 * 2026-12-01 から、gemini-2.5-flash へのリクエストは gemini-3.5-flash-lite へ自動で回される
 * (Google の deprecations 表)。Gemini 3.x は generationConfig.thinkingConfig.thinkingBudget を
 * 受け付けず 400 (invalid argument) を返すので、2.5 用の設定のままだと切り替えの日から
 * 全リクエストが失敗する。モデル ID を明示的に新しい方へ切り替え、thinking は thinkingLevel で最小にする。
 * (逆に gemini-2.5-flash は thinkingLevel を受け付けない。モデル ID と thinking の指定は必ず組で変える)
 *
 * モデルを変える時は、架空の領収書画像で実際に 1 回通してから本番に出す。
 * thinking の指定方法はモデル世代ごとに違い、間違えると 400 か「読めたが中身が空」の結果になる。
 */
export const GEMINI_MODEL = "gemini-3.5-flash-lite";

/** 構造化抽出用の generationConfig。JSON だけを返させ、thinking は最小にする。 */
export function extractionGenerationConfig(maxOutputTokens: number) {
  return {
    // temperature / top_p / top_k は Gemini 3.x では無視される (将来の世代では 400 になる) ので送らない
    thinkingConfig: { thinkingLevel: "minimal" },
    maxOutputTokens,
    responseMimeType: "application/json",
  };
}
