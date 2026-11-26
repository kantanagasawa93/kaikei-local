//! バックアップ ZIP の作成と復元。
//!
//! # なぜ Rust 側でやるのか
//!
//! kaikei.db は WAL モードで開かれている (sqlx-sqlite が新規 DB を WAL で作る)。
//! 以前は WebView 側から `kaikei.db` を 1 ファイルとして読み書きしていたため:
//!
//!   - **バックアップ**: まだ `kaikei.db-wal` にしか無いコミット (= 直近の入力) が
//!     ZIP に入らない。「入力してすぐバックアップ」が一番欠ける。
//!   - **復元**: 接続を開いたまま `kaikei.db` を上書きするので、終了時の
//!     チェックポイントで古い WAL が新しいファイルに書き戻され、空の DB に戻るか
//!     "database disk image is malformed" になる。
//!   - **画像**: `receipts/` 直下しか入らず、受信箱経由の領収書画像 (`inbox/`) が
//!     丸ごと抜ける。さらに DB には `/Users/<名前>/…` の絶対パスが入っているので、
//!     別の Mac / 別のユーザーに持っていくと画像が全部リンク切れになる。
//!
//! # ここでの方針
//!
//!   - バックアップは `VACUUM INTO` で作った一貫スナップショット + `receipts/`・
//!     `inbox/` を再帰的に ZIP へ (ストリーミング書き出し。数百 MB でもメモリに載せない)。
//!   - 復元は 2 段階。実行中はステージング領域に展開して検証するだけで、今のデータには
//!     一切触れない。差し替えは **次回起動時、DB を開く前** に行う (WAL/SHM ごと退避)。
//!   - 保存済みの絶対パスは、この Mac のデータフォルダ基準に付け替える。

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const DB_FILE: &str = "kaikei.db";
const STAGING_DIR: &str = ".restore-staging";
const READY_MARKER: &str = "READY.json";
const RESULT_FILE: &str = ".restore-result.json";
const KEEP_PREFIX: &str = "pre-restore-";
/// DB から参照される画像の置き場。バックアップ・復元の対象ディレクトリ。
const DATA_DIRS: [&str; 2] = ["receipts", "inbox"];
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
const BACKUP_FORMAT: u32 = 2;

fn err<E: std::fmt::Display>(ctx: &str) -> impl FnOnce(E) -> String + '_ {
    move |e| format!("{}: {}", ctx, e)
}

fn open_db(path: &Path) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open(path).map_err(err("DB を開けません"))?;
    conn.busy_timeout(Duration::from_secs(15))
        .map_err(err("busy_timeout"))?;
    Ok(conn)
}

fn table_exists(conn: &rusqlite::Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |row| row.get::<_, i64>(0),
    )
    .is_ok()
}

fn count_rows(conn: &rusqlite::Connection, table: &str) -> i64 {
    if !table_exists(conn, table) {
        return 0;
    }
    conn.query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0))
        .unwrap_or(0)
}

fn schema_version(conn: &rusqlite::Connection) -> i64 {
    if !table_exists(conn, "_sqlx_migrations") {
        return 0;
    }
    conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success = 1",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

// ────────────────────────────────────────────────────────────
// スナップショット
// ────────────────────────────────────────────────────────────

/// 稼働中の DB から、WAL の内容も含めた一貫スナップショットを `dest` に作る。
///
/// `kaikei.db` を単にコピーすると、まだチェックポイントされていないコミットが
/// 欠ける。`VACUUM INTO` は読み取りトランザクション内で完全な DB を書き出す。
pub fn snapshot_db(db_path: &Path, dest: &Path) -> Result<u64, String> {
    if !db_path.exists() {
        return Err("データベースが見つかりません".into());
    }
    if dest.exists() {
        // VACUUM INTO は出力先が存在すると失敗する
        fs::remove_file(dest).map_err(err("既存のスナップショットを消せません"))?;
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(err("出力先フォルダを作れません"))?;
    }
    let conn = open_db(db_path)?;
    conn.execute("VACUUM INTO ?1", [dest.to_string_lossy().as_ref()])
        .map_err(err("スナップショット作成 (VACUUM INTO)"))?;
    drop(conn);
    fs::metadata(dest)
        .map(|m| m.len())
        .map_err(err("スナップショットを確認できません"))
}

// ────────────────────────────────────────────────────────────
// バックアップ作成
// ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct BackupSummary {
    pub path: String,
    pub db_bytes: u64,
    pub file_count: u64,
    pub file_bytes: u64,
    pub journals: i64,
    pub receipts: i64,
}

/// 既に圧縮済みの形式は再圧縮しても縮まないので無圧縮で格納する (速度優先)。
fn is_precompressed(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        ".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".pdf", ".zip",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext))
}

/// `dir` 以下の通常ファイルを (ZIP 内の名前, 実パス) で列挙する。シンボリックリンクは辿らない。
fn collect_files(base: &Path, rel: &str, out: &mut Vec<(String, PathBuf)>) -> io::Result<()> {
    let dir = base.join(rel);
    if !dir.is_dir() {
        return Ok(());
    }
    let mut entries: Vec<_> = fs::read_dir(&dir)?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".DS_Store" {
            continue;
        }
        let child_rel = format!("{}/{}", rel, name);
        let ft = entry.file_type()?;
        if ft.is_dir() {
            collect_files(base, &child_rel, out)?;
        } else if ft.is_file() {
            out.push((child_rel, entry.path()));
        }
    }
    Ok(())
}

pub fn create_backup(
    app_data: &Path,
    dest_zip: &Path,
    app_version: &str,
) -> Result<BackupSummary, String> {
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    let db_path = app_data.join(DB_FILE);
    if !db_path.exists() {
        return Err("データベースが見つかりません".into());
    }

    // 1) 一貫スナップショット (同一ボリューム内の一時ファイル)
    let tmp_db = app_data.join(format!(".backup-snapshot-{}.db", std::process::id()));
    let db_bytes = snapshot_db(&db_path, &tmp_db)?;

    // 2) 書きかけの ZIP を完成品と誤認させないよう、一時名に書いてから rename
    let tmp_zip = PathBuf::from(format!("{}.partial", dest_zip.to_string_lossy()));

    let result = (|| -> Result<BackupSummary, String> {
        let (journals, receipts, schema) = {
            let conn = open_db(&tmp_db)?;
            (
                count_rows(&conn, "journals"),
                count_rows(&conn, "receipts"),
                schema_version(&conn),
            )
        };

        let mut files: Vec<(String, PathBuf)> = Vec::new();
        for dir in DATA_DIRS {
            collect_files(app_data, dir, &mut files).map_err(err("画像フォルダの走査"))?;
        }

        let out = File::create(&tmp_zip).map_err(err("ZIP を作成できません"))?;
        let mut zw = zip::ZipWriter::new(out);
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

        zw.start_file(DB_FILE, deflated).map_err(err("ZIP 書き込み (DB)"))?;
        let mut db_in = File::open(&tmp_db).map_err(err("スナップショットを開けません"))?;
        io::copy(&mut db_in, &mut zw).map_err(err("ZIP 書き込み (DB)"))?;

        let mut file_count = 0u64;
        let mut file_bytes = 0u64;
        for (name, path) in &files {
            let opts = if is_precompressed(name) { stored } else { deflated };
            let mut src = match File::open(path) {
                Ok(f) => f,
                Err(e) => {
                    // 走査後に消えたファイル等。1 枚読めないだけで全体を失敗にしない
                    log::warn!("backup: skip {} ({})", name, e);
                    continue;
                }
            };
            zw.start_file(name.as_str(), opts)
                .map_err(err("ZIP 書き込み (画像)"))?;
            file_bytes += io::copy(&mut src, &mut zw).map_err(err("ZIP 書き込み (画像)"))?;
            file_count += 1;
        }

        let meta = serde_json::json!({
            "app": "KAIKEI LOCAL",
            "format": BACKUP_FORMAT,
            "version": app_version,
            "schema_version": schema,
            "created_at": chrono::Local::now().to_rfc3339(),
            "journals": journals,
            "receipts": receipts,
            "file_count": file_count,
        });
        zw.start_file("meta.json", deflated)
            .map_err(err("ZIP 書き込み (meta)"))?;
        zw.write_all(serde_json::to_string_pretty(&meta).unwrap_or_default().as_bytes())
            .map_err(err("ZIP 書き込み (meta)"))?;

        let out = zw.finish().map_err(err("ZIP の確定"))?;
        out.sync_all().map_err(err("ZIP の書き出し"))?;

        Ok(BackupSummary {
            path: dest_zip.to_string_lossy().to_string(),
            db_bytes,
            file_count,
            file_bytes,
            journals,
            receipts,
        })
    })();

    let _ = fs::remove_file(&tmp_db);
    match result {
        Ok(summary) => {
            fs::rename(&tmp_zip, dest_zip).map_err(|e| {
                let _ = fs::remove_file(&tmp_zip);
                format!("ZIP を保存先に移せません: {}", e)
            })?;
            Ok(summary)
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp_zip);
            Err(e)
        }
    }
}

// ────────────────────────────────────────────────────────────
// 保存済み絶対パスの付け替え
// ────────────────────────────────────────────────────────────

/// DB に保存された絶対パスを、この Mac のデータフォルダ基準に付け替える。
///
/// `photo_inbox.file_path` と、受信箱経由の `receipts.image_url` (`file://…`) には
/// `/Users/<名前>/Library/Application Support/dev.kaikei.app/inbox/x.jpg` のような
/// 絶対パスが入る。別の Mac・別のユーザーにデータを持っていくとこの接頭辞が合わず、
/// 画像が全部読めなくなるので、`/<アプリ ID>/` より後ろを残して接頭辞を差し替える。
/// 既にこの Mac のパスになっている行は触らない (何度呼んでも安全)。
pub fn rebase_stored_paths(db_path: &Path, app_data: &Path) -> Result<usize, String> {
    if !db_path.exists() {
        return Ok(0);
    }
    let root = app_data.to_string_lossy().trim_end_matches('/').to_string();
    let Some(app_id) = app_data.file_name().map(|n| n.to_string_lossy().to_string()) else {
        return Ok(0);
    };
    // 例: "/dev.kaikei.app/"。これより後ろ ("/inbox/x.jpg") を残す。
    let marker = format!("/{}/", app_id);
    let keep_from = (marker.chars().count() - 1) as i64; // 末尾の "/" は残す側に含める

    let conn = open_db(db_path)?;
    let mut changed = 0usize;

    // (テーブル, 列, URL 接頭辞)
    let targets: [(&str, &str, &str); 5] = [
        ("photo_inbox", "file_path", ""),
        ("photo_inbox", "thumbnail_path", ""),
        ("receipts", "image_url", "file://"),
        ("withholding_slips", "image_url", "file://"),
        ("issuer_settings", "seal_image_url", "file://"),
    ];
    for (table, col, scheme) in targets {
        if !table_exists(&conn, table) {
            continue;
        }
        let has_col: bool = conn
            .prepare(&format!("SELECT 1 FROM pragma_table_info('{}') WHERE name = ?1", table))
            .and_then(|mut s| s.exists([col]))
            .unwrap_or(false);
        if !has_col {
            continue;
        }
        let new_prefix = format!("{}{}", scheme, root);
        let sql = format!(
            "UPDATE {t} SET {c} = ?1 || substr({c}, instr({c}, ?2) + ?3) \
             WHERE {c} IS NOT NULL \
               AND instr({c}, ?2) > 0 \
               AND {c} LIKE ?4 \
               AND substr({c}, 1, length(?1) + 1) <> ?1 || '/'",
            t = table,
            c = col
        );
        // scheme が空 (生の絶対パス) の時は "/" 始まりだけを対象にする
        let like = if scheme.is_empty() { "/%".to_string() } else { format!("{}%", scheme) };
        changed += conn
            .execute(&sql, rusqlite::params![new_prefix, marker, keep_from, like])
            .map_err(err("保存済みパスの付け替え"))?;
    }
    Ok(changed)
}

// ────────────────────────────────────────────────────────────
// 復元 (1) ステージング: 展開と検証だけ。今のデータには触れない
// ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StagedRestore {
    pub journals: i64,
    pub receipts: i64,
    pub file_count: u64,
    pub schema_version: i64,
    pub backup_app_version: Option<String>,
    pub backup_created_at: Option<String>,
    pub source: String,
}

fn staging_dir(app_data: &Path) -> PathBuf {
    app_data.join(STAGING_DIR)
}

/// ZIP 内の名前を「展開してよい相対パス」に解決する。対象外は None。
///
/// 受け付けるのは `kaikei.db` / `meta.json` と、`receipts/…`・`inbox/…` のみ。
/// `..` や絶対パスは zip クレートの `enclosed_name` が弾く (zip slip 対策)。
fn accepted_entry(enclosed: Option<PathBuf>) -> Option<PathBuf> {
    let p = enclosed?;
    let mut comps = p.components();
    let first = comps.next()?.as_os_str().to_string_lossy().to_string();
    let has_more = comps.next().is_some();
    if !has_more && (first == DB_FILE || first == "meta.json") {
        return Some(p);
    }
    if has_more && DATA_DIRS.contains(&first.as_str()) {
        return Some(p);
    }
    None
}

fn validate_staged_db(
    db: &Path,
    app_data: &Path,
    max_schema_version: i64,
) -> Result<(i64, i64, i64), String> {
    let mut head = [0u8; 16];
    File::open(db)
        .and_then(|mut f| f.read_exact(&mut head))
        .map_err(err("バックアップ内の kaikei.db を読めません"))?;
    if &head != SQLITE_MAGIC {
        return Err("バックアップ内の kaikei.db が SQLite データベースではありません".into());
    }

    let conn = open_db(db)?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(err("整合性チェック"))?;
    if integrity != "ok" {
        return Err(format!(
            "バックアップ内のデータベースが壊れています (integrity_check: {})",
            integrity
        ));
    }
    for table in ["journals", "journal_lines", "receipts"] {
        if !table_exists(&conn, table) {
            return Err(format!(
                "KAIKEI LOCAL のバックアップではないようです (テーブル {} がありません)",
                table
            ));
        }
    }
    let schema = schema_version(&conn);
    if schema > max_schema_version {
        return Err(format!(
            "このバックアップは新しいバージョンのアプリで作られています (データ形式 v{} / このアプリは v{} まで対応)。\
             先にアプリを最新版へアップデートしてから復元してください。",
            schema, max_schema_version
        ));
    }
    let journals = count_rows(&conn, "journals");
    let receipts = count_rows(&conn, "receipts");
    drop(conn);

    // 別の Mac で作られたバックアップでも画像を引けるよう、絶対パスを付け替えておく
    rebase_stored_paths(db, app_data)?;

    // VACUUM INTO で作った DB はロールバックジャーナルモードになる。普段と同じ WAL に
    // 戻しておく (クリーンに閉じるので -wal / -shm は残らない)。
    let conn = open_db(db)?;
    let _mode: String = conn
        .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
        .map_err(err("journal_mode"))?;
    drop(conn);
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{}", db.to_string_lossy(), suffix));
        let _ = fs::remove_file(side);
    }
    Ok((journals, receipts, schema))
}

/// バックアップ (`.zip`、または旧形式の `.db` 単体) をステージング領域に展開して検証する。
/// 成功すると READY マーカーを置く。実際の差し替えは次回起動時の
/// [`apply_pending_restore`] が行う。
pub fn stage_restore(
    app_data: &Path,
    src: &Path,
    max_schema_version: i64,
) -> Result<StagedRestore, String> {
    let staging = staging_dir(app_data);
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(err("前回の復元準備を片付けられません"))?;
    }
    fs::create_dir_all(&staging).map_err(err("復元用の作業フォルダを作れません"))?;

    let result = (|| -> Result<StagedRestore, String> {
        let mut file_count = 0u64;
        let mut backup_app_version = None;
        let mut backup_created_at = None;

        let is_zip = src
            .extension()
            .map(|e| e.to_string_lossy().eq_ignore_ascii_case("zip"))
            .unwrap_or(false);

        if is_zip {
            let f = File::open(src).map_err(err("バックアップを開けません"))?;
            let mut za = zip::ZipArchive::new(f)
                .map_err(err("ZIP として読めません (壊れているか、バックアップではありません)"))?;

            // 先に中身を確かめる。kaikei.db が無い ZIP では何も展開しない
            let has_db = (0..za.len()).any(|i| {
                za.by_index(i)
                    .ok()
                    .and_then(|e| e.enclosed_name())
                    .map(|p| p == Path::new(DB_FILE))
                    .unwrap_or(false)
            });
            if !has_db {
                return Err(
                    "バックアップ ZIP の直下に kaikei.db がありません。\
                     KAIKEI LOCAL の「バックアップ（ZIP）」で作ったファイルをそのまま選んでください \
                     (解凍して圧縮し直すとフォルダが 1 段増えて読めなくなります)。"
                        .into(),
                );
            }

            for i in 0..za.len() {
                let mut entry = za.by_index(i).map_err(err("ZIP の読み取り"))?;
                if entry.is_dir() {
                    continue;
                }
                let Some(rel) = accepted_entry(entry.enclosed_name()) else {
                    continue;
                };
                let dest = staging.join(&rel);
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(err("展開先フォルダ"))?;
                }
                if rel == Path::new("meta.json") {
                    let mut text = String::new();
                    if entry.read_to_string(&mut text).is_ok() {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                            backup_app_version =
                                v.get("version").and_then(|x| x.as_str()).map(String::from);
                            backup_created_at =
                                v.get("created_at").and_then(|x| x.as_str()).map(String::from);
                        }
                    }
                    continue;
                }
                let mut out = File::create(&dest).map_err(err("展開"))?;
                io::copy(&mut entry, &mut out).map_err(err("展開"))?;
                if rel != Path::new(DB_FILE) {
                    file_count += 1;
                }
            }
        } else {
            // 旧形式: .db 単体 (画像は含まれない)
            fs::copy(src, staging.join(DB_FILE)).map_err(err("バックアップを読めません"))?;
        }

        let (journals, receipts, schema) =
            validate_staged_db(&staging.join(DB_FILE), app_data, max_schema_version)?;

        let staged = StagedRestore {
            journals,
            receipts,
            file_count,
            schema_version: schema,
            backup_app_version,
            backup_created_at,
            source: src.to_string_lossy().to_string(),
        };
        // マーカーは最後に置く (途中で落ちたステージングを誤って適用しないため)
        fs::write(
            staging.join(READY_MARKER),
            serde_json::to_vec_pretty(&staged).unwrap_or_default(),
        )
        .map_err(err("復元準備の記録"))?;
        Ok(staged)
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

/// 復元の予約を取り消す (ステージングを捨てる)。
pub fn cancel_staged_restore(app_data: &Path) -> Result<(), String> {
    let staging = staging_dir(app_data);
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(err("復元準備を取り消せません"))?;
    }
    Ok(())
}

/// 復元が予約されているか (READY マーカーがあるか)。
pub fn pending_restore(app_data: &Path) -> Option<StagedRestore> {
    let text = fs::read(staging_dir(app_data).join(READY_MARKER)).ok()?;
    serde_json::from_slice(&text).ok()
}

// ────────────────────────────────────────────────────────────
// 復元 (2) 適用: 起動時、DB を開く前に差し替える
// ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreResult {
    pub ok: bool,
    pub error: Option<String>,
    /// 復元前のデータを退避したフォルダ
    pub kept_dir: Option<String>,
    pub journals: i64,
    pub receipts: i64,
    pub file_count: u64,
}

/// 予約済みの復元があれば適用する。**SQL プラグインが DB を開く前に** 呼ぶこと。
///
/// 今のデータ (`kaikei.db` と `-wal`/`-shm`、`receipts/`、`inbox/`) は
/// `pre-restore-<日時>/` に丸ごと退避してから、ステージングの中身を所定の位置へ移す。
/// WAL/SHM を一緒に退避するのが要点 (残すと復元した DB に古い WAL が適用される)。
/// 途中で失敗したら退避したものを元の場所へ戻す。
pub fn apply_pending_restore(app_data: &Path) -> Option<RestoreResult> {
    let staging = staging_dir(app_data);
    let Some(staged) = pending_restore(app_data) else {
        // マーカーの無いステージング = 途中で落ちた残骸。適用せず片付ける
        if staging.exists() {
            let _ = fs::remove_dir_all(&staging);
        }
        return None;
    };

    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let keep = app_data.join(format!("{}{}", KEEP_PREFIX, ts));

    let outcome = (|| -> Result<(), String> {
        if !staging.join(DB_FILE).exists() {
            return Err("復元用のデータベースが見つかりません".into());
        }
        fs::create_dir_all(&keep).map_err(err("退避フォルダを作れません"))?;

        let live_names = [DB_FILE, "kaikei.db-wal", "kaikei.db-shm", "receipts", "inbox"];
        let mut moved: Vec<&str> = Vec::new();
        let mut placed: Vec<PathBuf> = Vec::new();

        let step = (|| -> Result<(), String> {
            // 1) 今のデータを退避
            for name in live_names {
                let from = app_data.join(name);
                if from.exists() {
                    fs::rename(&from, keep.join(name))
                        .map_err(|e| format!("{} を退避できません: {}", name, e))?;
                    moved.push(name);
                }
            }
            // 2) ステージングの中身を所定の位置へ
            fs::rename(staging.join(DB_FILE), app_data.join(DB_FILE))
                .map_err(err("データベースを配置できません"))?;
            placed.push(app_data.join(DB_FILE));
            for dir in DATA_DIRS {
                let from = staging.join(dir);
                let to = app_data.join(dir);
                if from.is_dir() {
                    fs::rename(&from, &to)
                        .map_err(|e| format!("{} を配置できません: {}", dir, e))?;
                } else {
                    fs::create_dir_all(&to)
                        .map_err(|e| format!("{} を作れません: {}", dir, e))?;
                }
                placed.push(to);
            }
            Ok(())
        })();

        if let Err(e) = step {
            // 置いたものを除き、退避したものを戻す
            for p in &placed {
                if p.is_dir() {
                    let _ = fs::remove_dir_all(p);
                } else {
                    let _ = fs::remove_file(p);
                }
            }
            for name in &moved {
                let _ = fs::rename(keep.join(name), app_data.join(name));
            }
            let _ = fs::remove_dir(&keep);
            return Err(e);
        }
        Ok(())
    })();

    // 成否に関わらずステージングは片付ける (失敗した予約を毎回の起動で繰り返さない)
    let _ = fs::remove_dir_all(&staging);

    let result = match outcome {
        Ok(()) => {
            prune_old_keeps(app_data, &keep);
            RestoreResult {
                ok: true,
                error: None,
                kept_dir: Some(keep.to_string_lossy().to_string()),
                journals: staged.journals,
                receipts: staged.receipts,
                file_count: staged.file_count,
            }
        }
        Err(e) => RestoreResult {
            ok: false,
            error: Some(e),
            kept_dir: None,
            journals: 0,
            receipts: 0,
            file_count: 0,
        },
    };
    let _ = fs::write(
        app_data.join(RESULT_FILE),
        serde_json::to_vec_pretty(&result).unwrap_or_default(),
    );
    Some(result)
}

/// 退避フォルダは直近 1 世代だけ残す (画像込みで数百 MB になるため)。
fn prune_old_keeps(app_data: &Path, latest: &Path) {
    let Ok(read) = fs::read_dir(app_data) else {
        return;
    };
    for entry in read.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(KEEP_PREFIX) && path.is_dir() && path != latest {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

/// 直近の復元結果を 1 度だけ返す (起動後に UI が結果を表示するため)。
pub fn take_restore_result(app_data: &Path) -> Option<RestoreResult> {
    let path = app_data.join(RESULT_FILE);
    let bytes = fs::read(&path).ok()?;
    let _ = fs::remove_file(&path);
    serde_json::from_slice(&bytes).ok()
}

// ────────────────────────────────────────────────────────────
// テスト
// ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// `<tmp>/<ユーザー>/dev.kaikei.app` を作り、最小限のテーブルを持つ WAL DB を置く。
    fn make_app_data(root: &Path, user: &str) -> PathBuf {
        let app_data = root.join(user).join("dev.kaikei.app");
        fs::create_dir_all(app_data.join("receipts")).unwrap();
        fs::create_dir_all(app_data.join("inbox")).unwrap();
        let conn = rusqlite::Connection::open(app_data.join(DB_FILE)).unwrap();
        let _: String = conn
            .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
            .unwrap();
        conn.execute_batch(
            "CREATE TABLE _sqlx_migrations (version INTEGER PRIMARY KEY, success INTEGER);
             INSERT INTO _sqlx_migrations VALUES (1, 1), (2, 1);
             CREATE TABLE journals (id TEXT PRIMARY KEY, date TEXT, description TEXT);
             CREATE TABLE journal_lines (id TEXT PRIMARY KEY, journal_id TEXT);
             CREATE TABLE receipts (id TEXT PRIMARY KEY, image_url TEXT NOT NULL);
             CREATE TABLE photo_inbox (id TEXT PRIMARY KEY, file_path TEXT, thumbnail_path TEXT);",
        )
        .unwrap();
        app_data
    }

    fn insert_journals(app_data: &Path, n: usize, tag: &str) {
        let conn = rusqlite::Connection::open(app_data.join(DB_FILE)).unwrap();
        for i in 0..n {
            conn.execute(
                "INSERT INTO journals (id, date, description) VALUES (?1, '2026-01-01', ?2)",
                [format!("{}-{}", tag, i), tag.to_string()],
            )
            .unwrap();
        }
    }

    fn journal_count(app_data: &Path) -> i64 {
        let conn = rusqlite::Connection::open(app_data.join(DB_FILE)).unwrap();
        conn.query_row("SELECT COUNT(*) FROM journals", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn snapshot_includes_commits_that_are_only_in_the_wal() {
        let tmp = tempfile::tempdir().unwrap();
        let app_data = make_app_data(tmp.path(), "alice");

        // 接続を開いたまま書く = コミットは WAL にだけある状態 (アプリ稼働中と同じ)
        let live = rusqlite::Connection::open(app_data.join(DB_FILE)).unwrap();
        live.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        for i in 0..40 {
            live.execute(
                "INSERT INTO journals (id, date, description) VALUES (?1, '2026-01-01', 'wal')",
                [format!("w{}", i)],
            )
            .unwrap();
        }

        // メインファイルだけをコピーする旧方式では入力が欠ける (不具合の再現)
        let naive = tmp.path().join("naive.db");
        fs::copy(app_data.join(DB_FILE), &naive).unwrap();
        let naive_conn = rusqlite::Connection::open(&naive).unwrap();
        let naive_count: i64 = naive_conn
            .query_row("SELECT COUNT(*) FROM journals", [], |r| r.get(0))
            .unwrap_or(0);
        assert!(naive_count < 40, "前提: メインファイルの単純コピーは WAL 分が欠ける");

        // スナップショットは全件入る
        let snap = tmp.path().join("snap.db");
        snapshot_db(&app_data.join(DB_FILE), &snap).unwrap();
        let snap_conn = rusqlite::Connection::open(&snap).unwrap();
        let snap_count: i64 = snap_conn
            .query_row("SELECT COUNT(*) FROM journals", [], |r| r.get(0))
            .unwrap();
        assert_eq!(snap_count, 40);
        drop(live);
    }

    #[test]
    fn backup_then_restore_on_another_user_moves_everything() {
        let tmp = tempfile::tempdir().unwrap();

        // ── Mac A (alice): 仕訳 5 件、領収書画像はサブフォルダと inbox にもある ──
        let a = make_app_data(tmp.path(), "alice");
        insert_journals(&a, 5, "a");
        fs::write(a.join("receipts/top.jpg"), b"top").unwrap();
        fs::create_dir_all(a.join("receipts/local-user")).unwrap();
        fs::write(a.join("receipts/local-user/nested.jpg"), b"nested").unwrap();
        fs::write(a.join("inbox/photo1.jpg"), b"inbox-photo").unwrap();
        {
            let conn = rusqlite::Connection::open(a.join(DB_FILE)).unwrap();
            let abs = a.join("inbox/photo1.jpg").to_string_lossy().to_string();
            conn.execute(
                "INSERT INTO photo_inbox (id, file_path) VALUES ('p1', ?1)",
                [&abs],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO receipts (id, image_url) VALUES ('r1', ?1), ('r2', 'local://receipts/top.jpg')",
                [format!("file://{}", abs)],
            )
            .unwrap();
        }
        let zip_path = tmp.path().join("backup.zip");
        let summary = create_backup(&a, &zip_path, "0.3.3").unwrap();
        assert_eq!(summary.journals, 5);
        assert_eq!(summary.file_count, 3, "receipts 直下 + サブフォルダ + inbox の 3 枚");
        assert!(zip_path.exists());
        assert!(!PathBuf::from(format!("{}.partial", zip_path.to_string_lossy())).exists());

        // ── Mac B (bob): 別ユーザー。既に少しデータがあり、DB 接続も開いている ──
        let b = make_app_data(tmp.path(), "bob");
        insert_journals(&b, 2, "b");
        fs::write(b.join("receipts/old.jpg"), b"old").unwrap();
        let live = rusqlite::Connection::open(b.join(DB_FILE)).unwrap();
        live.execute(
            "INSERT INTO journals (id, date, description) VALUES ('live', '2026-02-02', 'still open')",
            [],
        )
        .unwrap();

        // ステージング: 今のデータには一切触れない
        let staged = stage_restore(&b, &zip_path, 13).unwrap();
        assert_eq!(staged.journals, 5);
        assert_eq!(staged.file_count, 3);
        assert_eq!(staged.backup_app_version.as_deref(), Some("0.3.3"));
        assert_eq!(journal_count(&b), 3, "ステージング中は今のデータがそのまま");
        assert!(b.join("receipts/old.jpg").exists());
        assert!(pending_restore(&b).is_some());

        // アプリ終了 (接続を閉じる) → 次回起動時に適用
        drop(live);
        let result = apply_pending_restore(&b).expect("予約があるので適用される");
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(journal_count(&b), 5, "復元後は Mac A の 5 件");
        assert!(b.join("receipts/top.jpg").exists());
        assert!(b.join("receipts/local-user/nested.jpg").exists());
        assert!(b.join("inbox/photo1.jpg").exists());
        assert!(!b.join("receipts/old.jpg").exists(), "古い画像は退避側へ");
        assert!(!staging_dir(&b).exists());
        assert!(pending_restore(&b).is_none());

        // 復元前のデータは丸ごと退避されている
        let kept = PathBuf::from(result.kept_dir.unwrap());
        assert!(kept.join(DB_FILE).exists());
        assert!(kept.join("receipts/old.jpg").exists());
        let kept_conn = rusqlite::Connection::open(kept.join(DB_FILE)).unwrap();
        let kept_count: i64 = kept_conn
            .query_row("SELECT COUNT(*) FROM journals", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept_count, 3);

        // 絶対パスは bob のデータフォルダ基準に付け替わっている
        let conn = rusqlite::Connection::open(b.join(DB_FILE)).unwrap();
        let file_path: String = conn
            .query_row("SELECT file_path FROM photo_inbox WHERE id='p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(file_path, b.join("inbox/photo1.jpg").to_string_lossy());
        assert!(Path::new(&file_path).exists(), "付け替えたパスに実ファイルがある");
        let url: String = conn
            .query_row("SELECT image_url FROM receipts WHERE id='r1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(url, format!("file://{}", b.join("inbox/photo1.jpg").to_string_lossy()));
        let rel: String = conn
            .query_row("SELECT image_url FROM receipts WHERE id='r2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rel, "local://receipts/top.jpg", "相対 URL は触らない");

        // 結果は 1 度だけ取り出せる
        assert!(take_restore_result(&b).map(|r| r.ok).unwrap_or(false));
        assert!(take_restore_result(&b).is_none());
    }

    #[test]
    fn restored_db_survives_reopen_and_integrity_check() {
        // 旧実装の不具合: 接続を開いたまま kaikei.db を上書き → 終了時に古い WAL が
        // 書き戻されて空 or 破損。新方式では起動時に WAL ごと差し替えるので起きない。
        let tmp = tempfile::tempdir().unwrap();
        let a = make_app_data(tmp.path(), "alice");
        insert_journals(&a, 200, "a");
        let zip_path = tmp.path().join("backup.zip");
        create_backup(&a, &zip_path, "0.3.3").unwrap();

        let b = make_app_data(tmp.path(), "bob");
        {
            // 未チェックポイントの WAL を残したまま「強制終了」した状況を作る
            let live = rusqlite::Connection::open(b.join(DB_FILE)).unwrap();
            live.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
            live.execute(
                "INSERT INTO journals (id, date, description) VALUES ('x', '2026-03-03', 'wal only')",
                [],
            )
            .unwrap();
            stage_restore(&b, &zip_path, 13).unwrap();
            // WAL ファイルを退避してから接続を落とす = クラッシュ相当 (WAL が残る)
            let wal = b.join("kaikei.db-wal");
            assert!(wal.exists());
            fs::copy(&wal, tmp.path().join("leftover-wal")).unwrap();
            drop(live);
            fs::copy(tmp.path().join("leftover-wal"), &wal).unwrap();
        }
        let result = apply_pending_restore(&b).unwrap();
        assert!(result.ok, "{:?}", result.error);
        assert!(!b.join("kaikei.db-wal").exists(), "古い WAL は退避されている");

        // 何度開き直しても 200 件・整合性 OK
        for _ in 0..3 {
            let conn = rusqlite::Connection::open(b.join(DB_FILE)).unwrap();
            let ok: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
            assert_eq!(ok, "ok");
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM journals", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 200);
        }
    }

    #[test]
    fn staging_rejects_bad_inputs_without_touching_live_data() {
        let tmp = tempfile::tempdir().unwrap();
        let b = make_app_data(tmp.path(), "bob");
        insert_journals(&b, 4, "b");
        fs::write(b.join("receipts/keep.jpg"), b"keep").unwrap();

        // (1) ZIP ではないファイル
        let junk = tmp.path().join("junk.zip");
        fs::write(&junk, b"this is not a zip").unwrap();
        assert!(stage_restore(&b, &junk, 13).is_err());

        // (2) kaikei.db が直下に無い ZIP (解凍→再圧縮でフォルダが 1 段増えたもの)
        let nested = tmp.path().join("nested.zip");
        {
            let mut zw = zip::ZipWriter::new(File::create(&nested).unwrap());
            let opts = zip::write::SimpleFileOptions::default();
            zw.start_file("backup/kaikei.db", opts).unwrap();
            zw.write_all(b"x").unwrap();
            zw.finish().unwrap();
        }
        let e = stage_restore(&b, &nested, 13).unwrap_err();
        assert!(e.contains("kaikei.db"), "{}", e);

        // (3) kaikei.db が SQLite ではない
        let fake = tmp.path().join("fake.zip");
        {
            let mut zw = zip::ZipWriter::new(File::create(&fake).unwrap());
            let opts = zip::write::SimpleFileOptions::default();
            zw.start_file("kaikei.db", opts).unwrap();
            zw.write_all(b"definitely not sqlite, just text").unwrap();
            zw.finish().unwrap();
        }
        assert!(stage_restore(&b, &fake, 13).is_err());

        // (4) このアプリより新しいデータ形式のバックアップ
        let a = make_app_data(tmp.path(), "alice");
        let newer = tmp.path().join("newer.zip");
        create_backup(&a, &newer, "9.9.9").unwrap();
        let e = stage_restore(&b, &newer, 1).unwrap_err(); // このアプリは v1 まで、という想定
        assert!(e.contains("新しいバージョン"), "{}", e);

        // どの失敗でも: 予約は残らず、今のデータは無傷
        assert!(pending_restore(&b).is_none());
        assert!(!staging_dir(&b).exists());
        assert!(apply_pending_restore(&b).is_none());
        assert_eq!(journal_count(&b), 4);
        assert!(b.join("receipts/keep.jpg").exists());
    }

    #[test]
    fn zip_entries_outside_the_data_dirs_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let a = make_app_data(tmp.path(), "alice");
        let good = tmp.path().join("good.zip");
        create_backup(&a, &good, "0.3.3").unwrap();

        // 正常なバックアップに「外へ書こうとするエントリ」を足した ZIP を作る
        let evil = tmp.path().join("evil.zip");
        {
            let mut src = zip::ZipArchive::new(File::open(&good).unwrap()).unwrap();
            let mut zw = zip::ZipWriter::new(File::create(&evil).unwrap());
            let opts = zip::write::SimpleFileOptions::default();
            for i in 0..src.len() {
                let mut e = src.by_index(i).unwrap();
                let name = e.name().to_string();
                let mut buf = Vec::new();
                e.read_to_end(&mut buf).unwrap();
                zw.start_file(name, opts).unwrap();
                zw.write_all(&buf).unwrap();
            }
            for name in ["../escaped.txt", "receipts/../../escaped2.txt", "other/file.txt", "kaikei.db-wal"] {
                zw.start_file(name, opts).unwrap();
                zw.write_all(b"evil").unwrap();
            }
            zw.finish().unwrap();
        }

        let b = make_app_data(tmp.path(), "bob");
        stage_restore(&b, &evil, 13).unwrap();
        let staging = staging_dir(&b);
        assert!(!tmp.path().join("bob").join("escaped.txt").exists());
        assert!(!b.join("escaped.txt").exists());
        assert!(!b.join("escaped2.txt").exists());
        assert!(!staging.join("other").exists(), "対象外フォルダは展開しない");
        assert!(!staging.join("kaikei.db-wal").exists(), "WAL を持ち込ませない");
    }

    #[test]
    fn rebase_is_idempotent_and_leaves_local_paths_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let b = make_app_data(tmp.path(), "bob");
        {
            let conn = rusqlite::Connection::open(b.join(DB_FILE)).unwrap();
            conn.execute_batch(
                "INSERT INTO photo_inbox (id, file_path) VALUES
                   ('old', '/Users/alice/Library/Application Support/dev.kaikei.app/inbox/a b.jpg'),
                   ('none', NULL);
                 INSERT INTO receipts (id, image_url) VALUES
                   ('f', 'file:///Users/alice/Library/Application Support/dev.kaikei.app/inbox/a b.jpg'),
                   ('l', 'local://receipts/x.jpg'),
                   ('h', 'https://example.invalid/dev.kaikei.app/x.jpg');",
            )
            .unwrap();
            let mine = b.join("inbox/mine.jpg").to_string_lossy().to_string();
            conn.execute("INSERT INTO photo_inbox (id, file_path) VALUES ('mine', ?1)", [&mine])
                .unwrap();
        }
        let first = rebase_stored_paths(&b.join(DB_FILE), &b).unwrap();
        assert_eq!(first, 2, "alice の 2 行だけが対象");
        let second = rebase_stored_paths(&b.join(DB_FILE), &b).unwrap();
        assert_eq!(second, 0, "2 回目は何も変えない");

        let conn = rusqlite::Connection::open(b.join(DB_FILE)).unwrap();
        let get = |sql: &str| -> Option<String> { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(
            get("SELECT file_path FROM photo_inbox WHERE id='old'").unwrap(),
            b.join("inbox/a b.jpg").to_string_lossy()
        );
        assert_eq!(
            get("SELECT file_path FROM photo_inbox WHERE id='mine'").unwrap(),
            b.join("inbox/mine.jpg").to_string_lossy()
        );
        assert_eq!(get("SELECT file_path FROM photo_inbox WHERE id='none'"), None);
        assert_eq!(
            get("SELECT image_url FROM receipts WHERE id='f'").unwrap(),
            format!("file://{}", b.join("inbox/a b.jpg").to_string_lossy())
        );
        assert_eq!(get("SELECT image_url FROM receipts WHERE id='l'").unwrap(), "local://receipts/x.jpg");
        assert_eq!(
            get("SELECT image_url FROM receipts WHERE id='h'").unwrap(),
            "https://example.invalid/dev.kaikei.app/x.jpg"
        );
    }

    #[test]
    fn legacy_db_only_backup_can_be_restored() {
        let tmp = tempfile::tempdir().unwrap();
        let a = make_app_data(tmp.path(), "alice");
        insert_journals(&a, 7, "a");
        let single = tmp.path().join("old-backup.db");
        snapshot_db(&a.join(DB_FILE), &single).unwrap();

        let b = make_app_data(tmp.path(), "bob");
        fs::write(b.join("receipts/mine.jpg"), b"mine").unwrap();
        let staged = stage_restore(&b, &single, 13).unwrap();
        assert_eq!(staged.journals, 7);
        assert_eq!(staged.file_count, 0);
        let result = apply_pending_restore(&b).unwrap();
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(journal_count(&b), 7);
        // 画像を含まない旧形式でも receipts/ は (空で) 用意される
        assert!(b.join("receipts").is_dir());
        assert!(b.join("inbox").is_dir());
    }

    #[test]
    fn old_keep_dirs_are_pruned_to_one_generation() {
        let tmp = tempfile::tempdir().unwrap();
        let a = make_app_data(tmp.path(), "alice");
        let zip_path = tmp.path().join("backup.zip");
        create_backup(&a, &zip_path, "0.3.3").unwrap();

        let b = make_app_data(tmp.path(), "bob");
        fs::create_dir_all(b.join("pre-restore-20200101-000000")).unwrap();
        fs::write(b.join("pre-restore-20200101-000000/kaikei.db"), b"old").unwrap();
        stage_restore(&b, &zip_path, 13).unwrap();
        let result = apply_pending_restore(&b).unwrap();
        assert!(result.ok);
        let keeps: Vec<_> = fs::read_dir(&b)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(KEEP_PREFIX))
            .collect();
        assert_eq!(keeps.len(), 1, "退避は直近 1 世代だけ");
    }
}
