/**
 * テスト用のインメモリ SQLite。
 *
 * 本番と同じマイグレーション (src-tauri/src/migrations.rs の SQL を、
 * src-tauri/src/lib.rs の sql_migrations に並んでいる順で) を空の DB に適用する。
 * = 「新しい Mac にインストールした直後の DB」と同じ状態から各テストが始まる。
 *
 * 使い方:
 *   import { installTestDb } from "@/test-stubs/test-db";
 *   let t: TestDb;
 *   beforeEach(() => { t = installTestDb(); });
 *   afterEach(() => t.close());
 *
 * 本番 (tauri-plugin-sql / sqlx) との差を埋めている点:
 *   - プレースホルダは $1, $2 … (sqlx の番号付き) → ?1, ?2 … に読み替え
 *   - foreign_keys = ON (sqlx-sqlite の既定)
 *   - undefined は null として束縛 (IPC の JSON 直列化と同じ)
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { __setTestSqlBackend } from "./tauri-plugin-sql";

const RUST_DIR = path.resolve(__dirname, "../../src-tauri/src");

export interface MigrationDef {
  version: number;
  description: string;
  constName: string;
  sql: string;
}

/** migrations.rs / lib.rs を読んで、本番と同じ順のマイグレーション一覧を返す。 */
export function loadMigrations(): MigrationDef[] {
  const migrationsRs = fs.readFileSync(path.join(RUST_DIR, "migrations.rs"), "utf-8");
  const libRs = fs.readFileSync(path.join(RUST_DIR, "lib.rs"), "utf-8");

  const sqlByConst = new Map<string, string>();
  const constRe = /pub const (\w+): &str = r#"([\s\S]*?)"#;/g;
  for (let m = constRe.exec(migrationsRs); m; m = constRe.exec(migrationsRs)) {
    sqlByConst.set(m[1], m[2]);
  }

  const defs: MigrationDef[] = [];
  const migRe =
    /Migration\s*\{\s*version:\s*(\d+),\s*description:\s*"([^"]+)",\s*sql:\s*migrations::(\w+),/g;
  for (let m = migRe.exec(libRs); m; m = migRe.exec(libRs)) {
    const sql = sqlByConst.get(m[3]);
    if (sql === undefined) {
      throw new Error(`lib.rs が参照する migrations::${m[3]} が migrations.rs に無い`);
    }
    defs.push({ version: Number(m[1]), description: m[2], constName: m[3], sql });
  }
  return defs;
}

export interface TestDb {
  /** 生の node:sqlite ハンドル (テストから直接 SQL を叩きたい時用) */
  raw: DatabaseSync;
  /** 行を配列で取る */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  /** 1 行目の 1 列目を取る (COUNT 等) */
  scalar<T = number>(sql: string, ...params: unknown[]): T;
  close(): void;
}

function toBindable(v: unknown): null | number | bigint | string | Uint8Array {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

/** sqlx 流の $1 を SQLite の ?1 に読み替える (文字列リテラル内の $ は対象外にする)。 */
function rewritePlaceholders(sql: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inString = !inString;
      out += ch;
    } else if (!inString && ch === "$" && /\d/.test(sql[i + 1] ?? "")) {
      out += "?";
    } else {
      out += ch;
    }
  }
  return out;
}

/** マイグレーション適用済みのインメモリ DB を作り、localDb から使えるように差し込む。 */
export function installTestDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;");
  for (const m of loadMigrations()) {
    try {
      raw.exec(m.sql);
    } catch (e) {
      throw new Error(
        `migration v${m.version} (${m.description}) の適用に失敗: ${(e as Error).message}`,
      );
    }
  }

  __setTestSqlBackend({
    select(sql, params) {
      return raw.prepare(rewritePlaceholders(sql)).all(...params.map(toBindable)) as unknown[];
    },
    execute(sql, params) {
      const r = raw.prepare(rewritePlaceholders(sql)).run(...params.map(toBindable));
      return {
        rowsAffected: Number(r.changes),
        lastInsertId: Number(r.lastInsertRowid),
      };
    },
  });

  return {
    raw,
    all<T>(sql: string, ...params: unknown[]) {
      return raw.prepare(sql).all(...params.map(toBindable)) as T[];
    },
    scalar<T>(sql: string, ...params: unknown[]) {
      const row = raw.prepare(sql).get(...params.map(toBindable)) as
        | Record<string, unknown>
        | undefined;
      return (row ? Object.values(row)[0] : undefined) as T;
    },
    close() {
      __setTestSqlBackend(null);
      raw.close();
    },
  };
}
