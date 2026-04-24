/**
 * localDb.ts
 *
 * Supabaseのクライアント(@supabase/supabase-js)が提供する
 *   supabase.from("table").select("*").eq("col", val).order(...).single()
 * のようなクエリビルダーAPIを、Tauri の tauri-plugin-sql が扱う SQLite に対して
 * 同じ呼び出しで動くようにするための互換レイヤー。
 *
 * これにより、既存のページからは `supabase.from(...)` を `db.from(...)` に
 * 置き換えるだけで動作する。
 */

import Database from "@tauri-apps/plugin-sql";

/**
 * DB 関連エラーのうち「.single() でレコードが無かった」等の想定内エラーは
 * UI 側で 0 件扱いになるので toast は出さない。接続不能・テーブル不在・
 * SQL 構文エラーなどの「ユーザーが原因を知りたい」致命系のみ toast する。
 */
function notifyDbError(e: unknown): void {
  const msg = (e as Error)?.message || String(e);
  // 「1件だけ欲しかったが 0 件返ってきた」系は routine なので silent
  if (
    /no rows returned|expected one row|not found|returned no rows/i.test(msg)
  ) {
    return;
  }
  // toast 発火 (ブラウザ環境でない or Toaster 未マウント時は no-op)
  void import("@/lib/toast")
    .then(({ toast }) => {
      toast.error(
        `データベースエラー: ${msg.length > 160 ? msg.slice(0, 160) + "…" : msg}`
      );
    })
    .catch(() => {});
}

let _db: Database | null = null;

async function getDb(): Promise<Database> {
  if (_db) return _db;
  _db = await Database.load("sqlite:kaikei.db");
  return _db;
}

type Row = Record<string, unknown>;

// ------------------------------------------------------------
// クエリビルダー
// ------------------------------------------------------------

type Op =
  | { kind: "eq"; col: string; val: unknown }
  | { kind: "neq"; col: string; val: unknown }
  | { kind: "in"; col: string; val: unknown[] }
  | { kind: "gte"; col: string; val: unknown }
  | { kind: "lte"; col: string; val: unknown }
  | { kind: "gt"; col: string; val: unknown }
  | { kind: "lt"; col: string; val: unknown }
  | { kind: "like"; col: string; val: unknown };

type OrderBy = { col: string; ascending: boolean };

interface QueryState {
  table: string;
  action: "select" | "insert" | "update" | "delete";
  columns: string;
  filters: Op[];
  order: OrderBy | null;
  limitN: number | null;
  singleMode: boolean;
  headMode: boolean;
  countMode: "exact" | null;
  values: Row | Row[] | null;
  // insert/update/delete 後に .select() が呼ばれた場合、書き込みは実行しつつ
  // 書き込み結果を返すために action を固定する必要がある
  actionLocked: boolean;
}

// 既存コードはSupabaseの緩い型( data: any )前提なので、dataは any として返す
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Result<_T> = { data: any; error: Error | null; count?: number };

class QueryBuilder<T = Row> implements PromiseLike<Result<T>> {
  private state: QueryState;

  constructor(table: string) {
    this.state = {
      table,
      action: "select",
      columns: "*",
      filters: [],
      order: null,
      limitN: null,
      singleMode: false,
      headMode: false,
      countMode: null,
      values: null,
      actionLocked: false,
    };
  }

  select(columns: string = "*", opts?: { count?: "exact"; head?: boolean }): this {
    // insert/update/delete 後の .select() は action を上書きしない
    if (!this.state.actionLocked) {
      this.state.action = "select";
    }
    this.state.columns = columns;
    if (opts?.count) this.state.countMode = opts.count;
    if (opts?.head) this.state.headMode = true;
    return this;
  }

  insert(values: Row | Row[]): QueryBuilder<T> {
    this.state.action = "insert";
    this.state.values = values;
    this.state.actionLocked = true;
    return this;
  }

  update(values: Row): QueryBuilder<T> {
    this.state.action = "update";
    this.state.values = values;
    this.state.actionLocked = true;
    return this;
  }

  delete(): QueryBuilder<T> {
    this.state.action = "delete";
    this.state.actionLocked = true;
    return this;
  }

  eq(col: string, val: unknown): this {
    if (col === "user_id") return this; // ローカル版では無視
    this.state.filters.push({ kind: "eq", col, val });
    return this;
  }
  neq(col: string, val: unknown): this {
    if (col === "user_id") return this;
    this.state.filters.push({ kind: "neq", col, val });
    return this;
  }
  in(col: string, val: unknown[]): this {
    if (col === "user_id") return this;
    this.state.filters.push({ kind: "in", col, val });
    return this;
  }
  gte(col: string, val: unknown): this {
    if (col === "user_id") return this;
    this.state.filters.push({ kind: "gte", col, val });
    return this;
  }
  lte(col: string, val: unknown): this {
    if (col === "user_id") return this;
    this.state.filters.push({ kind: "lte", col, val });
    return this;
  }
  gt(col: string, val: unknown): this {
    if (col === "user_id") return this;
    this.state.filters.push({ kind: "gt", col, val });
    return this;
  }
  lt(col: string, val: unknown): this {
    if (col === "user_id") return this;
    this.state.filters.push({ kind: "lt", col, val });
    return this;
  }
  like(col: string, val: unknown): this {
    if (col === "user_id") return this;
    this.state.filters.push({ kind: "like", col, val });
    return this;
  }

  order(col: string, opts: { ascending?: boolean } = {}): this {
    this.state.order = { col, ascending: opts.ascending !== false };
    return this;
  }

  limit(n: number): this {
    this.state.limitN = n;
    return this;
  }

  single(): QueryBuilder<T> {
    this.state.singleMode = true;
    return this;
  }

  // then() を実装することで await 可能
  then<TResult1 = Result<T>, TResult2 = never>(
    onfulfilled?: ((value: Result<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<Result<T>> {
    try {
      const db = await getDb();
      const { action } = this.state;

      if (action === "select") {
        return (await this.doSelect(db)) as Result<T>;
      }
      if (action === "insert") {
        return (await this.doInsert(db)) as Result<T>;
      }
      if (action === "update") {
        return (await this.doUpdate(db)) as Result<T>;
      }
      if (action === "delete") {
        return (await this.doDelete(db)) as Result<T>;
      }
      throw new Error(`Unknown action: ${action}`);
    } catch (e) {
      console.error("[localDb]", e);
      notifyDbError(e);
      return { data: null, error: e as Error };
    }
  }

  private whereClause(startIdx: number = 1): {
    clause: string;
    params: unknown[];
    nextIdx: number;
  } {
    const parts: string[] = [];
    const params: unknown[] = [];
    let idx = startIdx;
    for (const f of this.state.filters) {
      if (f.kind === "in") {
        if (f.val.length === 0) {
          parts.push("0");
          continue;
        }
        const placeholders = f.val.map(() => `$${idx++}`).join(",");
        parts.push(`${f.col} IN (${placeholders})`);
        params.push(...f.val);
      } else {
        const op =
          f.kind === "eq" ? "="
          : f.kind === "neq" ? "!="
          : f.kind === "gte" ? ">="
          : f.kind === "lte" ? "<="
          : f.kind === "gt" ? ">"
          : f.kind === "lt" ? "<"
          : f.kind === "like" ? "LIKE"
          : "=";
        if (f.val === null) {
          parts.push(f.kind === "neq" ? `${f.col} IS NOT NULL` : `${f.col} IS NULL`);
        } else {
          parts.push(`${f.col} ${op} $${idx++}`);
          params.push(f.val);
        }
      }
    }
    return {
      clause: parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "",
      params,
      nextIdx: idx,
    };
  }

  private async doSelect(db: Database): Promise<Result<Row | Row[]>> {
    const { clause, params } = this.whereClause();
    let sql: string;
    if (this.state.countMode === "exact" && this.state.headMode) {
      sql = `SELECT COUNT(*) as count FROM ${this.state.table} ${clause}`;
      const rows = (await db.select(sql, params)) as { count: number }[];
      return { data: null, error: null, count: rows[0]?.count ?? 0 };
    }

    // Supabase風のネスト select: "*, children_table(*)" をサポート
    // 例: "*, journal_lines(*)" → journals をselect後、各行の id で journal_lines を再取得
    const nestedMatch = this.state.columns.match(/^\*\s*,\s*(\w+)\s*\((.+)\)\s*$/);
    if (nestedMatch) {
      const childTable = nestedMatch[1];
      const childCols = nestedMatch[2];
      // 親側
      let parentSql = `SELECT * FROM ${this.state.table} ${clause}`;
      if (this.state.order) {
        parentSql += ` ORDER BY ${this.state.order.col} ${this.state.order.ascending ? "ASC" : "DESC"}`;
      }
      if (this.state.limitN != null) parentSql += ` LIMIT ${this.state.limitN}`;
      const parents = (await db.select(parentSql, params)) as Row[];
      if (parents.length === 0) return { data: [], error: null };

      // 子側: FK は親テーブル名の単数形 "_id" と推定（例: journals → journal_id）
      const fkCol = this.state.table.replace(/s$/, "") + "_id";
      const parentIds = parents.map((p) => p.id);
      const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(",");
      const childSql = `SELECT ${childCols} FROM ${childTable} WHERE ${fkCol} IN (${placeholders})`;
      const children = (await db.select(childSql, parentIds)) as Row[];

      // 親にぶら下げる
      const childMap = new Map<unknown, Row[]>();
      for (const c of children) {
        const key = c[fkCol];
        if (!childMap.has(key)) childMap.set(key, []);
        childMap.get(key)!.push(c);
      }
      for (const p of parents) {
        p[childTable] = childMap.get(p.id) || [];
      }
      if (this.state.singleMode) {
        return { data: parents[0] ?? null, error: null };
      }
      return { data: parents, error: null, count: parents.length };
    }

    sql = `SELECT ${this.state.columns} FROM ${this.state.table} ${clause}`;
    if (this.state.order) {
      sql += ` ORDER BY ${this.state.order.col} ${this.state.order.ascending ? "ASC" : "DESC"}`;
    }
    if (this.state.limitN != null) {
      sql += ` LIMIT ${this.state.limitN}`;
    } else if (this.state.singleMode) {
      sql += ` LIMIT 1`;
    }
    const rows = (await db.select(sql, params)) as Row[];
    if (this.state.singleMode) {
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null, count: rows.length };
  }

  private async doInsert(db: Database): Promise<Result<Row | Row[]>> {
    const raw = this.state.values;
    if (!raw) return { data: null, error: new Error("insert: no values") };
    const rows = Array.isArray(raw) ? raw : [raw];
    const inserted: Row[] = [];
    for (const rowIn of rows) {
      const row: Row = { ...rowIn };
      // kaikei はローカル1ユーザ構成。既存コードが user_id を渡してくるが、
      // SQLite 側のテーブルには user_id カラムがないので自動で落とす。
      delete row.user_id;
      // id は自動付与
      if (row.id === undefined) {
        row.id = crypto.randomUUID();
      }
      // boolean → 0/1 変換（SQLite互換）
      for (const k of Object.keys(row)) {
        if (typeof row[k] === "boolean") row[k] = row[k] ? 1 : 0;
      }
      const cols = Object.keys(row);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
      const values = cols.map((c) => row[c]);
      const sql = `INSERT INTO ${this.state.table} (${cols.join(",")}) VALUES (${placeholders})`;
      await db.execute(sql, values);
      inserted.push(row);
    }
    if (this.state.singleMode) {
      return { data: inserted[0] ?? null, error: null };
    }
    return { data: inserted, error: null };
  }

  private async doUpdate(db: Database): Promise<Result<Row>> {
    const raw = this.state.values;
    if (!raw || Array.isArray(raw)) return { data: null, error: new Error("update: values must be object") };
    const row: Row = { ...raw };
    delete row.user_id;
    for (const k of Object.keys(row)) {
      if (typeof row[k] === "boolean") row[k] = row[k] ? 1 : 0;
    }
    const cols = Object.keys(row);
    const setClauses = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
    const params: unknown[] = cols.map((c) => row[c]);
    const { clause, params: whereParams } = this.whereClause(cols.length + 1);
    const sql = `UPDATE ${this.state.table} SET ${setClauses} ${clause}`;
    await db.execute(sql, [...params, ...whereParams]);
    return { data: row, error: null };
  }

  private async doDelete(db: Database): Promise<Result<null>> {
    const { clause, params } = this.whereClause();
    const sql = `DELETE FROM ${this.state.table} ${clause}`;
    await db.execute(sql, params);
    return { data: null, error: null };
  }
}

// ------------------------------------------------------------
// ダミーauth（ローカル1ユーザ）
// ------------------------------------------------------------

const LOCAL_USER = {
  id: "local-user",
  email: "local@kaikei.app",
  app_metadata: {},
  user_metadata: {},
};

const authApi = {
  async getUser() {
    return { data: { user: LOCAL_USER }, error: null };
  },
  async signInWithPassword() {
    return { data: { user: LOCAL_USER, session: {} }, error: null };
  },
  async signUp() {
    return { data: { user: LOCAL_USER, session: {} }, error: null };
  },
  async signOut() {
    return { error: null };
  },
  onAuthStateChange(cb: (event: string, session: { user: typeof LOCAL_USER } | null) => void) {
    // ローカル版では常にサインイン済み
    setTimeout(() => cb("SIGNED_IN", { user: LOCAL_USER }), 0);
    return { data: { subscription: { unsubscribe: () => {} } } };
  },
};

// ------------------------------------------------------------
// ダミーstorage（ローカルファイルシステム経由）
// ------------------------------------------------------------

import { writeFile, BaseDirectory, mkdir } from "@tauri-apps/plugin-fs";
import { appDataDir } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";

type StorageBucket = {
  upload: (
    path: string,
    data: Blob | ArrayBuffer | File,
    opts?: { contentType?: string; upsert?: boolean }
  ) => Promise<{ data: { path: string } | null; error: Error | null }>;
  getPublicUrl: (path: string) => { data: { publicUrl: string } };
  remove: (paths: string[]) => Promise<{ data: null; error: Error | null }>;
};

const storageApi = {
  from(bucket: string): StorageBucket {
    return {
      async upload(path, data) {
        try {
          // path 例: "local-user/1234-abc.jpg"
          // AppData/{bucket}/local-user/1234-abc.jpg に保存する
          const dir = `${bucket}`;
          try {
            await mkdir(`${dir}`, { baseDir: BaseDirectory.AppData, recursive: true });
          } catch {}
          // ネストしたディレクトリの場合も作成する
          const nestedDir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : null;
          if (nestedDir) {
            try {
              await mkdir(`${dir}/${nestedDir}`, { baseDir: BaseDirectory.AppData, recursive: true });
            } catch {}
          }
          let bytes: Uint8Array;
          if (data instanceof Blob || data instanceof File) {
            bytes = new Uint8Array(await data.arrayBuffer());
          } else if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data);
          } else {
            throw new Error("unsupported upload data type");
          }
          await writeFile(`${dir}/${path}`, bytes, { baseDir: BaseDirectory.AppData });
          return { data: { path: `${dir}/${path}` }, error: null };
        } catch (e) {
          return { data: null, error: e as Error };
        }
      },
      getPublicUrl(path) {
        // bucket を含めた local:// URL を返す
        return { data: { publicUrl: `local://${bucket}/${path}` } };
      },
      async remove() {
        return { data: null, error: null };
      },
    };
  },
};

// Tauri環境で local:// を実ファイルパスに変換するヘルパー
export async function resolveLocalImageUrl(url: string | null): Promise<string | null> {
  if (!url) return null;
  if (!url.startsWith("local://")) return url;
  try {
    const relative = url.replace(/^local:\/\//, "");
    const dir = await appDataDir();
    const full = `${dir}${relative}`;
    return convertFileSrc(full);
  } catch (e) {
    console.warn("resolveLocalImageUrl failed:", e);
    return null;
  }
}

// ------------------------------------------------------------
// 公開API
// ------------------------------------------------------------

export const db = {
  from<T = Row>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(table);
  },
  auth: authApi,
  storage: storageApi,
};

// 互換エイリアス: 既存コードで `supabase` という名前を使っているため
export const supabase = db;
