/**
 * vitest 用スタブ。unit テストは DB に触らない前提 (触ったら throw で気付ける)。
 * vitest.config.ts の alias でのみ使われ、実行時の型チェックはされないので
 * 引数は受け取らない形にしてある (esbuild は型を見ない)。
 */
export default class Database {
  static async load(): Promise<Database> {
    throw new Error("unit テストから Database.load は呼べません (スタブ)");
  }
  async select<T>(): Promise<T> {
    throw new Error("unit テストから db.select は呼べません (スタブ)");
  }
  async execute(): Promise<unknown> {
    throw new Error("unit テストから db.execute は呼べません (スタブ)");
  }
}
