/**
 * vitest 用スタブ (vitest.config.ts の alias でのみ使われる)。
 *
 * 既定では「unit テストは DB に触らない」前提で、触ったら throw して気付けるようにする。
 * DB を使う処理 (取込の重複判定・按分の再計算 等) を検証したいテストは
 * src/test-stubs/test-db.ts の installTestDb() で、実マイグレーションを適用した
 * インメモリ SQLite を差し込む。
 *
 * localDb.ts は Database.load() の結果をモジュール内にキャッシュするので、
 * ここでは「いま差し込まれているバックエンド」に委譲するだけの薄いハンドルを返す。
 * こうしておくと、テストごとに DB を作り直しても localDb 側のキャッシュは有効なまま。
 */
export interface TestSqlBackend {
  select(sql: string, params: unknown[]): unknown[];
  execute(sql: string, params: unknown[]): { rowsAffected: number; lastInsertId: number };
}

let backend: TestSqlBackend | null = null;

/** テスト用バックエンドを差し込む (null で解除)。test-db.ts から呼ぶ。 */
export function __setTestSqlBackend(next: TestSqlBackend | null): void {
  backend = next;
}

function requireBackend(what: string): TestSqlBackend {
  if (!backend) {
    throw new Error(
      `unit テストから ${what} は呼べません (スタブ)。DB が要るテストは installTestDb() を使ってください`,
    );
  }
  return backend;
}

export default class Database {
  static async load(): Promise<Database> {
    requireBackend("Database.load");
    return new Database();
  }
  async select<T>(sql: string, params: unknown[] = []): Promise<T> {
    return requireBackend("db.select").select(sql, params) as T;
  }
  async execute(sql: string, params: unknown[] = []): Promise<unknown> {
    return requireBackend("db.execute").execute(sql, params);
  }
}
