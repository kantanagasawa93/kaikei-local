/**
 * node:sqlite (Node 22.5+ 同梱) の最小限の型宣言。
 *
 * プロジェクトの @types/node は 20 系で node:sqlite の型を含まないため、
 * テスト用インメモリ DB (test-db.ts) が使う範囲だけをここで宣言する。
 * @types/node を 22.5 以上に上げたらこのファイルは削除してよい。
 */
declare module "node:sqlite" {
  type SqlValue = null | number | bigint | string | Uint8Array;

  export class StatementSync {
    all(...params: SqlValue[]): unknown[];
    get(...params: SqlValue[]): unknown;
    run(...params: SqlValue[]): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
