/** vitest 用スタブ。 */
export async function invoke(): Promise<never> {
  throw new Error("unit テストから invoke は呼べません (スタブ)");
}
