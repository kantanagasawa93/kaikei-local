mod lan_server;
mod migrations;

#[cfg(target_os = "macos")]
mod photos;

#[cfg(target_os = "macos")]
mod vision;

#[cfg(target_os = "macos")]
mod classifier;

#[cfg(target_os = "macos")]
mod scanner;

#[cfg(target_os = "macos")]
mod launchd;

use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

#[tauri::command]
fn get_lan_upload_info() -> Option<lan_server::LanInfo> {
    lan_server::current_info()
}

#[tauri::command]
fn list_pending_lan_uploads() -> Vec<lan_server::PendingUpload> {
    lan_server::drain_pending()
}

// ────────────────────────────────────────────────────────────
// Photos.framework (macOS) 連携コマンド
//   - 写真ライブラリへのアクセス権限の確認・リクエスト
//   - 指定日時以降の写真をスキャンして、画像を inbox/ にコピー
//   - inbox/ のパスを Vec で返却し、Vision OCR / 領収書フィルタは別レイヤで処理
//
// 非 macOS では未対応エラーを返す stub。
// ────────────────────────────────────────────────────────────

#[tauri::command]
fn photos_authorization_status() -> String {
    #[cfg(target_os = "macos")]
    {
        photos::authorization_status().to_string()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "unsupported".to_string()
    }
}

#[tauri::command]
async fn photos_request_authorization() -> String {
    #[cfg(target_os = "macos")]
    {
        // ダイアログ表示は同期的にブロックする可能性があるので spawn_blocking で逃がす
        tokio::task::spawn_blocking(|| photos::request_authorization().to_string())
            .await
            .unwrap_or_else(|_| "unknown".to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        "unsupported".to_string()
    }
}

/// sqlx の "migration N was previously applied but has been modified"
/// エラーを自動復旧する Tauri command。
///
/// 経緯:
///   - sqlx は `_sqlx_migrations` に各マイグレーションの SHA384 を記録
///   - SQL を一切いじっていなくても、sqlx のバージョン違い・改行コード混入・
///     ビルド時のエンコーディング変動などで checksum が変わるケースがあり、
///     一度 mismatch が起きると tauri-plugin-sql は Database.load 時点で
///     例外を投げて「全マイグレーション停止」する
///   - Round 1 → Round 2 で v3 を追加した時に開発機で発症し、v4 が適用されない
///     事故が起きた。Round 2 では手動で `DELETE FROM _sqlx_migrations` で復旧。
///     end user 環境では JS から Database.load できないので JS だけでは直せない
///
/// この関数は:
///   1. rusqlite で kaikei.db を直接開く (tauri-plugin-sql を経由しない)
///   2. `kaikei.db.bak-<unix>` にコピーバックアップ (失われたら困るので必ず取る)
///   3. `_sqlx_migrations` の全行を DELETE (idempotent な SCHEMA_SQL に依存)
///   4. 再度 Database.load("sqlite:kaikei.db") を JS から呼び直すと、
///      sqlx は記録なし → 全マイグレーション再適用 (CREATE IF NOT EXISTS で安全)
///
/// 結果は { ok: bool, backup_path?: string, error?: string } で返す。
#[tauri::command]
async fn db_repair_migration_checksum(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("app data dir: {}", e))?;
        let db_path = app_data.join("kaikei.db");
        if !db_path.exists() {
            // DB が無い時は復旧不要 — 次の load で新規作成される
            return Ok(serde_json::json!({
                "ok": true,
                "skipped": "db_not_found",
            }));
        }
        // tokio のブロッキング外しに spawn_blocking
        let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
            let ts = chrono::Local::now().format("%Y%m%dT%H%M%S").to_string();
            let backup = db_path.with_file_name(format!("kaikei.db.bak-{}", ts));
            std::fs::copy(&db_path, &backup).map_err(|e| format!("backup: {}", e))?;

            let conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| format!("open db: {}", e))?;
            // _sqlx_migrations が無ければ何もしないで OK (新規 DB)
            let exists: bool = conn
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map(|_| true)
                .unwrap_or(false);
            if exists {
                conn.execute("DELETE FROM _sqlx_migrations", [])
                    .map_err(|e| format!("delete: {}", e))?;
            }
            Ok(backup.to_string_lossy().to_string())
        })
        .await
        .map_err(|e| format!("join: {}", e))?;

        match result {
            Ok(backup) => Ok(serde_json::json!({
                "ok": true,
                "backup_path": backup,
            })),
            Err(e) => Ok(serde_json::json!({
                "ok": false,
                "error": e,
            })),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("db_repair_migration_checksum is only supported on macOS".into())
    }
}

/// Round 15 ㉻: アプリ設定画面から呼ぶ「データ全消去」Tauri command。
///
/// app_data_dir 配下を:
///   1. dev.kaikei.app.bak-<ts> にコピー (cp -R)
///   2. std::fs::remove_dir_all で削除
///   3. JSON {ok, backup_path, removed_size_bytes} を返す
///
/// UI 側は呼出前に「DELETE と入力してください」など二重確認を要求する想定。
/// CLI の `--wipe-data --yes` (Round 14 ㉷) と同じ動きを Tauri 経由で。
#[tauri::command]
async fn wipe_app_data(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("app data dir: {}", e))?;
        if !app_data.exists() {
            return Ok(serde_json::json!({ "ok": true, "skipped": "not_exists" }));
        }
        let result = tokio::task::spawn_blocking(move || -> Result<(String, u64), String> {
            // バックアップ
            let ts = chrono::Local::now().format("%Y%m%dT%H%M%S").to_string();
            let backup = app_data.with_file_name(format!("dev.kaikei.app.bak-{}", ts));
            let status = std::process::Command::new("cp")
                .arg("-R")
                .arg(&app_data)
                .arg(&backup)
                .status()
                .map_err(|e| format!("cp spawn: {}", e))?;
            if !status.success() {
                return Err("cp -R 失敗".into());
            }

            // サイズ集計
            let mut total: u64 = 0;
            if let Ok(read) = std::fs::read_dir(&app_data) {
                for e in read.flatten() {
                    total += e.metadata().ok().map(|m| m.len()).unwrap_or(0);
                }
            }

            // 削除
            std::fs::remove_dir_all(&app_data).map_err(|e| format!("remove_dir_all: {}", e))?;
            Ok((backup.to_string_lossy().to_string(), total))
        })
        .await
        .map_err(|e| format!("join: {}", e))?;

        match result {
            Ok((backup, total)) => Ok(serde_json::json!({
                "ok": true,
                "backup_path": backup,
                "removed_size_bytes": total,
            })),
            Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("wipe_app_data is only supported on macOS".into())
    }
}

/// Round 15 ㉽: `_sqlx_migrations` の現在状態を JSON で返す。
///
/// UI / verify-app.sh から「DB が v7 まで適用されているか」を確認する用途。
/// Round 3 ⓐ の auto-recovery が動いた直後の状況確認にも使える。
#[tauri::command]
async fn migrations_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("app data dir: {}", e))?;
        let db_path = app_data.join("kaikei.db");
        if !db_path.exists() {
            return Ok(serde_json::json!({ "ok": true, "rows": [], "skipped": "db_not_found" }));
        }
        let result = tokio::task::spawn_blocking(move || -> Result<Vec<serde_json::Value>, String> {
            let conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| format!("open db: {}", e))?;
            let exists: bool = conn
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map(|_| true)
                .unwrap_or(false);
            if !exists {
                return Ok(vec![]);
            }
            let mut stmt = conn
                .prepare(
                    "SELECT version, description, installed_on, success, execution_time \
                     FROM _sqlx_migrations ORDER BY version",
                )
                .map_err(|e| format!("prepare: {}", e))?;
            let mut rows = stmt.query([]).map_err(|e| format!("query: {}", e))?;
            let mut out = Vec::new();
            while let Ok(Some(row)) = rows.next() {
                let version: i64 = row.get(0).unwrap_or(0);
                let description: String = row.get(1).unwrap_or_default();
                let installed_on: String = row.get(2).unwrap_or_default();
                let success: i64 = row.get(3).unwrap_or(0);
                let exec_us: i64 = row.get(4).unwrap_or(0);
                out.push(serde_json::json!({
                    "version": version,
                    "description": description,
                    "installed_on": installed_on,
                    "success": success == 1,
                    "execution_us": exec_us,
                }));
            }
            Ok(out)
        })
        .await
        .map_err(|e| format!("join: {}", e))?;

        match result {
            Ok(rows) => Ok(serde_json::json!({ "ok": true, "rows": rows, "count": rows.len() })),
            Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("migrations_status is only supported on macOS".into())
    }
}

/// 起動中のアプリが「ルート遷移すべきターゲット」を取りに行く。
/// `--navigate=/route` CLI が書いた `~/Library/Application Support/dev.kaikei.app/.navigate-target`
/// を読み、空文字を含めずに返したら呼出側 (Frontend NavigateBridge) で
/// router.push する → 直後に navigate_clear で消す。
#[tauri::command]
async fn navigate_target_get(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {}", e))?;
    let target = app_data.join(".navigate-target");
    if !target.exists() {
        return Ok(String::new());
    }
    match std::fs::read_to_string(&target) {
        Ok(s) => Ok(s.trim().to_string()),
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
async fn navigate_target_clear(app: tauri::AppHandle) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {}", e))?;
    let target = app_data.join(".navigate-target");
    let _ = std::fs::remove_file(&target);
    Ok(())
}

/// Round 17 ㊇: demo action target getter / clear.
/// `--simulate-action=<name>` が書く `.demo-action-target` を読み出す。
#[tauri::command]
async fn demo_action_get(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {}", e))?;
    let target = app_data.join(".demo-action-target");
    if !target.exists() {
        return Ok(String::new());
    }
    Ok(std::fs::read_to_string(&target).unwrap_or_default().trim().to_string())
}

#[tauri::command]
async fn demo_action_clear(app: tauri::AppHandle) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {}", e))?;
    let target = app_data.join(".demo-action-target");
    let _ = std::fs::remove_file(&target);
    Ok(())
}

/// 画像ファイルを生バイトで読み出す。tauri-plugin-fs のスコープ/権限に依存せず、
/// Rust 側 (フルディスクアクセス) で std::fs::read する。
///
/// 用途: フロントから `src/lib/localDb.ts:resolveLocalImageUrl` で呼び、
/// 戻り値を Blob → ObjectURL に変換して <img> に渡す。
///
/// セキュリティ: app_data_dir / ホームディレクトリ配下のみ許可。それ以外は弾く。
#[tauri::command]
async fn read_image_file(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<u8>, String> {
    use std::path::PathBuf;
    let p = PathBuf::from(&path);
    let canonical = p.canonicalize().map_err(|e| format!("canonicalize: {}", e))?;

    // 許可するディレクトリを決定
    let app_data = app.path().app_data_dir().ok();
    let home = dirs::home_dir();

    let allowed = [app_data.as_ref(), home.as_ref()]
        .iter()
        .filter_map(|x| *x)
        .any(|root| canonical.starts_with(root));

    if !allowed {
        return Err(format!("path not allowed: {}", canonical.display()));
    }

    std::fs::read(&canonical).map_err(|e| format!("read: {}", e))
}

/// Vision.framework で画像のテキストを認識して返す。完全ローカル、ネット送信なし。
/// 結果: { lines: string[], joined: string, language: "ja"|"en" }
///
/// Round 10 ㉡: 第 2 引数 customWords (Optional) で取引先名・店名等の
/// 固有名詞をバイアス用辞書として渡せる。指定なしなら従来挙動。
/// Round 13 ㉲: 第 3 引数 twoPass=true で日英両言語の独立 OCR を結合 (約 2 倍遅い)。
/// Round 15 ㉺: 第 4 引数 lang ("ja"|"en") で単一言語モード。指定があると
/// twoPass より優先 (ja-only / en-only での再 OCR を選択できる)。
#[tauri::command]
async fn vision_recognize_text(
    file_path: String,
    custom_words: Option<Vec<String>>,
    two_pass: Option<bool>,
    lang: Option<String>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        let words = custom_words.unwrap_or_default();
        let two_pass = two_pass.unwrap_or(false);
        let lang = lang.unwrap_or_default();
        let result = tokio::task::spawn_blocking(move || {
            // lang 指定が "ja" / "en" なら単一言語モード優先
            match lang.as_str() {
                "ja" => vision::recognize_text_single_lang(&file_path, &words, "ja-JP"),
                "en" => vision::recognize_text_single_lang(&file_path, &words, "en-US"),
                _ => {
                    if two_pass {
                        vision::recognize_text_two_pass(&file_path, &words)
                    } else {
                        vision::recognize_text_with_words(&file_path, &words)
                    }
                }
            }
        })
        .await
        .map_err(|e| format!("join: {}", e))??;
        Ok(serde_json::to_value(result).unwrap_or(serde_json::Value::Null))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (file_path, custom_words, two_pass, lang);
        Err("vision OCR is only supported on macOS".into())
    }
}

#[tauri::command]
async fn photos_scan_recent(
    app: tauri::AppHandle,
    since_unix: i64,
) -> Result<Vec<serde_json::Value>, String> {
    #[cfg(target_os = "macos")]
    {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("app data dir: {}", e))?;
        let inbox_dir = app_data.join("inbox");
        let result = tokio::task::spawn_blocking(move || photos::scan_recent(since_unix, &inbox_dir))
            .await
            .map_err(|e| format!("join: {}", e))??;
        let json = result
            .into_iter()
            .map(|p| serde_json::to_value(p).unwrap_or(serde_json::Value::Null))
            .collect();
        Ok(json)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, since_unix);
        Err("photos scan is only supported on macOS".into())
    }
}

/// macOS で指定パスを Finder で開く (reveal)。他 OS では open で既定アプリで開く。
fn open_in_finder(path: &std::path::Path) {
    // 親ディレクトリ無ければ作る
    let _ = std::fs::create_dir_all(path);
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(path).spawn();
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows: explorer / Linux: xdg-open 相当
        // Tauri アプリは Mac 限定なので通常到達しないが安全策
        let cmd = if cfg!(target_os = "windows") {
            "explorer"
        } else {
            "xdg-open"
        };
        let _ = std::process::Command::new(cmd).arg(path).spawn();
    }
}


// ────────────────────────────────────────────────────────────
// LaunchAgent / 定期スキャン管理コマンド
// ────────────────────────────────────────────────────────────

#[tauri::command]
fn launchd_status() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        serde_json::to_value(launchd::status()).unwrap_or(serde_json::Value::Null)
    }
    #[cfg(not(target_os = "macos"))]
    {
        serde_json::json!({ "installed": false, "supported": false })
    }
}

#[tauri::command]
fn launchd_install(time: String) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        let cfg = launchd::install(&time)?;
        Ok(serde_json::to_value(cfg).unwrap_or(serde_json::Value::Null))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = time;
        Err("LaunchAgent is only supported on macOS".into())
    }
}

#[tauri::command]
fn launchd_uninstall() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        let cfg = launchd::uninstall()?;
        Ok(serde_json::to_value(cfg).unwrap_or(serde_json::Value::Null))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("LaunchAgent is only supported on macOS".into())
    }
}

/// `--auto-scan` 起動時のヘッドレススキャン処理。GUI を立ち上げずに
/// scanner::run_once() を呼んで通知を出して exit する。
#[cfg(target_os = "macos")]
fn run_auto_scan_and_exit() -> ! {
    use std::path::PathBuf;
    let app_data = dirs::data_dir()
        .map(|d| d.join("dev.kaikei.app"))
        .unwrap_or_else(|| PathBuf::from("/tmp/dev.kaikei.app"));

    scanner::log_line(&format!("[auto-scan] start (app_data={})", app_data.display()));

    match scanner::run_once(&app_data) {
        Ok(s) => {
            let body = if s.new_photos == 0 {
                "新規の写真はありませんでした".to_string()
            } else if s.receipts > 0 {
                format!(
                    "新規 {} 枚 (うち領収書 {} 枚) を受信箱に追加しました",
                    s.new_photos, s.receipts
                )
            } else {
                format!("新規 {} 枚を受信箱に追加しました", s.new_photos)
            };
            scanner::log_line(&format!("[auto-scan] {}", body));
            scanner::post_notification("KAIKEI LOCAL", &body);
        }
        Err(e) => {
            scanner::log_line(&format!("[auto-scan] error: {}", e));
            scanner::post_notification(
                "KAIKEI LOCAL — スキャン失敗",
                &format!("詳細はログを確認してください: {}", e),
            );
        }
    }
    // launchd 上では即 exit すれば次回まで再実行されない
    std::process::exit(0);
}

/// 自律検証ハーネス用ヘルパ: ~/Library/Application Support/dev.kaikei.app
#[cfg(target_os = "macos")]
fn verify_app_data_dir() -> std::path::PathBuf {
    use std::path::PathBuf;
    dirs::data_dir()
        .map(|d| d.join("dev.kaikei.app"))
        .unwrap_or_else(|| PathBuf::from("/tmp/dev.kaikei.app"))
}

/// `--simulate-scan` ヘッドレスでスキャンを実行し、結果を JSON で stdout に吐く。
/// `--auto-scan` と挙動はほぼ同じだが、通知は出さず JSON だけ返すので
/// シェル経由で結果を assert できる。
#[cfg(target_os = "macos")]
fn run_simulate_scan_and_exit() -> ! {
    let app_data = verify_app_data_dir();
    let result = scanner::run_once(&app_data);
    let json = match &result {
        Ok(s) => serde_json::json!({
            "ok": true,
            "scanned": s.scanned,
            "new_photos": s.new_photos,
            "receipts": s.receipts,
            "errors": s.errors,
        }),
        Err(e) => serde_json::json!({
            "ok": false,
            "error": e,
        }),
    };
    println!("{}", serde_json::to_string_pretty(&json).unwrap_or_default());
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

/// `--db-dump=<table>` 指定テーブルの全行を JSON 配列で stdout に吐く。
/// 許可テーブル: photo_inbox / photo_scan_log / ai_ocr_log / app_settings /
/// receipts / journals / journal_lines。
#[cfg(target_os = "macos")]
fn run_db_dump_and_exit(table: &str) -> ! {
    const ALLOWED: &[&str] = &[
        "photo_inbox",
        "photo_scan_log",
        "ai_ocr_log",
        "app_settings",
        "receipts",
        "journals",
        "journal_lines",
    ];
    if !ALLOWED.contains(&table) {
        eprintln!(
            "table not allowed: {} (許可テーブル: {})",
            table,
            ALLOWED.join(", ")
        );
        std::process::exit(2);
    }
    let app_data = verify_app_data_dir();
    let db_path = app_data.join("kaikei.db");
    if !db_path.exists() {
        eprintln!("db not found: {}", db_path.display());
        std::process::exit(2);
    }

    let conn = match rusqlite::Connection::open(&db_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("open db: {}", e);
            std::process::exit(1);
        }
    };
    // テーブル存在チェック (migration が当たってないと crash する)
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
            rusqlite::params![table],
            |row| row.get::<_, i64>(0),
        )
        .map(|_| true)
        .unwrap_or(false);
    if !exists {
        eprintln!("table {} not yet created (open KAIKEI LOCAL.app once for migration)", table);
        std::process::exit(2);
    }

    let sql = format!("SELECT * FROM {}", table);
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("prepare: {}", e);
            std::process::exit(1);
        }
    };
    let cols: Vec<String> = stmt.column_names().iter().map(|s| (*s).to_string()).collect();
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut rows = stmt.query([]).expect("query");
    while let Ok(Some(row)) = rows.next() {
        let mut obj = serde_json::Map::new();
        for (i, name) in cols.iter().enumerate() {
            let v = match row.get_ref(i) {
                Ok(rusqlite::types::ValueRef::Null) => serde_json::Value::Null,
                Ok(rusqlite::types::ValueRef::Integer(n)) => serde_json::Value::from(n),
                Ok(rusqlite::types::ValueRef::Real(f)) => serde_json::Value::from(f),
                Ok(rusqlite::types::ValueRef::Text(t)) => {
                    serde_json::Value::String(String::from_utf8_lossy(t).into_owned())
                }
                Ok(rusqlite::types::ValueRef::Blob(b)) => {
                    serde_json::Value::String(format!("<blob {} bytes>", b.len()))
                }
                Err(_) => serde_json::Value::Null,
            };
            obj.insert(name.clone(), v);
        }
        out.push(serde_json::Value::Object(obj));
    }
    println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
    std::process::exit(0);
}

/// `--tail-scan-log[=N]` ~/Library/Logs/KAIKEI LOCAL/scan.log の末尾 N 行を表示。
#[cfg(target_os = "macos")]
fn run_tail_scan_log_and_exit(n: usize) -> ! {
    let path = dirs::home_dir()
        .map(|h| h.join("Library/Logs/KAIKEI LOCAL/scan.log"))
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp/kaikei-scan.log"));
    if !path.exists() {
        // log が無いのは「まだ scanner が一度も走っていない」だけ。終了 0 で空出力。
        std::process::exit(0);
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("read log: {}", e);
            std::process::exit(1);
        }
    };
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(n);
    for line in &lines[start..] {
        println!("{}", line);
    }
    std::process::exit(0);
}

/// Round 8 ㊘: `--tail-app-log[=N]` で
/// `~/Library/Logs/dev.kaikei.app/kaikei.log` (Tauri plugin-log の出力先) を
/// tail する。`error-reporter.ts` が webview の console.error /
/// unhandledrejection を全部ここに流しているので、Claude が CLI から
/// アプリ実行時エラーを拾える。
///
/// `--errors-only` を別 flag で同時に受けると ERR / WARN の行のみフィルタ。
#[cfg(target_os = "macos")]
fn run_tail_app_log_and_exit(n: usize, errors_only: bool) -> ! {
    let path = dirs::home_dir()
        .map(|h| h.join("Library/Logs/dev.kaikei.app/kaikei.log"))
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp/kaikei.log"));
    if !path.exists() {
        std::process::exit(0);
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("read app log: {}", e);
            std::process::exit(1);
        }
    };
    let mut lines: Vec<&str> = content.lines().collect();
    if errors_only {
        lines.retain(|l| l.contains("[ERROR]") || l.contains("[WARN]") || l.contains("[ERR]"));
    }
    let start = lines.len().saturating_sub(n);
    for line in &lines[start..] {
        println!("{}", line);
    }
    std::process::exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // CLI/LaunchAgent 経由で `--auto-scan` が来た場合は GUI を立ち上げず即スキャン
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--auto-scan") {
        #[cfg(target_os = "macos")]
        run_auto_scan_and_exit();
        #[cfg(not(target_os = "macos"))]
        {
            eprintln!("--auto-scan is only supported on macOS");
            std::process::exit(2);
        }
    }

    // 自律検証ハーネス用 CLI (GUI 起動を伴わない、JSON 出力で assert 可能)
    #[cfg(target_os = "macos")]
    {
        if args.iter().any(|a| a == "--simulate-scan") {
            run_simulate_scan_and_exit();
        }
        if let Some(arg) = args.iter().find(|a| a.starts_with("--db-dump=")) {
            let table = arg.strip_prefix("--db-dump=").unwrap_or("");
            run_db_dump_and_exit(table);
        }
        if let Some(arg) = args.iter().find(|a| a == &"--tail-scan-log" || a.starts_with("--tail-scan-log=")) {
            let n: usize = arg
                .strip_prefix("--tail-scan-log=")
                .and_then(|s| s.parse().ok())
                .unwrap_or(50);
            run_tail_scan_log_and_exit(n);
        }
        if let Some(arg) = args.iter().find(|a| a == &"--tail-app-log" || a.starts_with("--tail-app-log=")) {
            let n: usize = arg
                .strip_prefix("--tail-app-log=")
                .and_then(|s| s.parse().ok())
                .unwrap_or(50);
            let errors_only = args.iter().any(|a| a == "--errors-only");
            run_tail_app_log_and_exit(n, errors_only);
        }
        // --navigate=/route — 起動中のアプリに「次の polling でこのルートに遷移して」
        // と control file 経由で指示。CLI なので別プロセスから webview に直接命令
        // できないため、~/Library/Application Support/dev.kaikei.app/.navigate-target
        // にルートを書いて、Frontend の NavigateBridge が 1 秒ごとに読む。
        if let Some(arg) = args.iter().find(|a| a.starts_with("--navigate=")) {
            let route = arg.strip_prefix("--navigate=").unwrap_or("/");
            let app_data = verify_app_data_dir();
            let _ = std::fs::create_dir_all(&app_data);
            let target = app_data.join(".navigate-target");
            match std::fs::write(&target, route) {
                Ok(_) => {
                    println!("navigate target = {} (written to {})", route, target.display());
                    std::process::exit(0);
                }
                Err(e) => {
                    eprintln!("failed to write navigate target: {}", e);
                    std::process::exit(1);
                }
            }
        }

        // Round 17 ㊇ --simulate-action=<name> — exit して、起動中アプリに
        // 名前付きアクションを実行させる (例: "scan-now")。
        // 内部実装は navigate と同じく control file 経由 (.demo-action-target)。
        // セキュリティ: Frontend は allowlist された action 名 のみ実行する。
        if let Some(arg) = args.iter().find(|a| a.starts_with("--simulate-action=")) {
            let name = arg.strip_prefix("--simulate-action=").unwrap_or("");
            if name.is_empty() {
                eprintln!("--simulate-action: 空の name");
                std::process::exit(2);
            }
            let app_data = verify_app_data_dir();
            let _ = std::fs::create_dir_all(&app_data);
            let target = app_data.join(".demo-action-target");
            match std::fs::write(&target, name) {
                Ok(_) => {
                    println!("demo action target = {} (written to {})", name, target.display());
                    std::process::exit(0);
                }
                Err(e) => {
                    eprintln!("simulate-action: failed: {}", e);
                    std::process::exit(1);
                }
            }
        }

        // Round 12 ㉬ --start-route=/route — exit せず、起動完了後に
        // NavigateBridge が control file を pickup する形で初回ナビゲート。
        // 用途: dev 中に `kaikei --start-route=/inbox` で起動直後に受信箱を開く。
        // last_route 復元 (Round 11 ㉩) よりも優先 (NavigateBridge poll で
        // 上書きされる)。
        if let Some(arg) = args.iter().find(|a| a.starts_with("--start-route=")) {
            let route = arg.strip_prefix("--start-route=").unwrap_or("/");
            let app_data = verify_app_data_dir();
            let _ = std::fs::create_dir_all(&app_data);
            let target = app_data.join(".navigate-target");
            if let Err(e) = std::fs::write(&target, route) {
                eprintln!("--start-route: failed to write navigate target: {}", e);
            } else {
                eprintln!("[start-route] {} (control file = {})", route, target.display());
            }
            // exit せず通常の Builder フローに進む
        }

        // Round 14 ㉷ --wipe-data: アンインストール補助。
        // app_data_dir 配下 (kaikei.db / inbox/ / receipts/ / snapshots/ / 等) を
        // バックアップしてから削除。--wipe-data --yes で確認 skip。
        if args.iter().any(|a| a == "--wipe-data") {
            let confirmed = args.iter().any(|a| a == "--yes" || a == "-y");
            let app_data = verify_app_data_dir();
            if !app_data.exists() {
                println!("app data dir が存在しません: {}", app_data.display());
                std::process::exit(0);
            }
            // 中身を一覧
            let mut total_bytes: u64 = 0;
            let mut entries: Vec<String> = Vec::new();
            if let Ok(read) = std::fs::read_dir(&app_data) {
                for e in read.flatten() {
                    let p = e.path();
                    let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                    let size = e.metadata().ok().map(|m| m.len()).unwrap_or(0);
                    total_bytes += size;
                    entries.push(format!("  - {} ({} bytes)", name, size));
                }
            }
            println!("削除対象: {}", app_data.display());
            for e in &entries {
                println!("{}", e);
            }
            println!("合計: {} bytes ({:.1} MB)", total_bytes, total_bytes as f64 / 1024.0 / 1024.0);

            if !confirmed {
                println!();
                println!("これらを完全削除します。実行する場合は --yes を付けて再実行してください:");
                println!("  kaikei --wipe-data --yes");
                println!();
                println!("バックアップが欲しい場合は手動で:");
                println!("  cp -R \"{}\" \"{}.bak-$(date +%s)\"", app_data.display(), app_data.display());
                std::process::exit(0);
            }

            // バックアップを必ず取る
            let ts = chrono::Local::now().format("%Y%m%dT%H%M%S").to_string();
            let backup = app_data.with_file_name(format!("dev.kaikei.app.bak-{}", ts));
            match std::process::Command::new("cp")
                .arg("-R")
                .arg(&app_data)
                .arg(&backup)
                .status()
            {
                Ok(s) if s.success() => {
                    println!("バックアップ: {}", backup.display());
                }
                _ => {
                    eprintln!("バックアップ失敗 — 中止");
                    std::process::exit(1);
                }
            }

            // 削除
            match std::fs::remove_dir_all(&app_data) {
                Ok(_) => {
                    println!("削除完了: {}", app_data.display());
                    println!("(バックアップ: {})", backup.display());
                    std::process::exit(0);
                }
                Err(e) => {
                    eprintln!("削除失敗: {}", e);
                    std::process::exit(1);
                }
            }
        }

        if args.iter().any(|a| a == "--verify-help") {
            println!(
                "{}",
                concat!(
                    "KAIKEI LOCAL — 自律検証 CLI\n\n",
                    "  --auto-scan              ヘッドレススキャン (LaunchAgent 互換、通知付き)\n",
                    "  --simulate-scan          ヘッドレススキャン (JSON 出力、検証用)\n",
                    "  --db-dump=<table>        DB テーブルを JSON 配列で出力\n",
                    "                           対象: photo_inbox / photo_scan_log / ai_ocr_log /\n",
                    "                                 app_settings / receipts / journals / journal_lines\n",
                    "  --tail-scan-log[=N]      ~/Library/Logs/KAIKEI LOCAL/scan.log の末尾 N 行 (既定 50)\n",
                    "  --tail-app-log[=N]       ~/Library/Logs/dev.kaikei.app/kaikei.log の末尾 N 行\n",
                    "                           [+ --errors-only で WARN/ERR 行のみ]\n",
                    "  --navigate=<route>       起動中のアプリに次のルートへ遷移するよう指示\n",
                    "                           (例: --navigate=/inbox)\n",
                    "  --start-route=<route>    GUI 起動時に直接そのルートに飛ぶ\n",
                    "                           (例: --start-route=/inbox)\n",
                    "  --simulate-action=<name> 起動中アプリで allowlist された action を発火\n",
                    "                           (scan-now / journalize-all-receipts / open-help)\n",
                    "  --test-ocr=<path>        画像を Vision OCR にかけて結果を表示\n",
                    "  --test-doc=<path>        画像に文書矩形が検出されるか表示\n",
                    "  --launchd-status         LaunchAgent の状態を JSON 表示\n",
                    "  --install-launchd=HH:MM  LaunchAgent を指定時刻でインストール\n",
                    "  --uninstall-launchd      LaunchAgent をアンインストール\n",
                    "  --wipe-data [--yes]      app data dir をバックアップしてから完全削除\n",
                    "                           (DB / inbox / receipts / snapshots) アンインストール補助\n",
                ),
            );
            std::process::exit(0);
        }
    }

    // ops / 検証用: LaunchAgent の install/uninstall を CLI から叩ける
    #[cfg(target_os = "macos")]
    {
        if let Some(arg) = args.iter().find(|a| a.starts_with("--install-launchd=")) {
            let time = arg.strip_prefix("--install-launchd=").unwrap_or("21:00");
            match launchd::install(time) {
                Ok(cfg) => {
                    println!("{}", serde_json::to_string_pretty(&cfg).unwrap_or_default());
                    std::process::exit(0);
                }
                Err(e) => {
                    eprintln!("install failed: {}", e);
                    std::process::exit(1);
                }
            }
        }
        if args.iter().any(|a| a == "--uninstall-launchd") {
            match launchd::uninstall() {
                Ok(cfg) => {
                    println!("{}", serde_json::to_string_pretty(&cfg).unwrap_or_default());
                    std::process::exit(0);
                }
                Err(e) => {
                    eprintln!("uninstall failed: {}", e);
                    std::process::exit(1);
                }
            }
        }
        if args.iter().any(|a| a == "--launchd-status") {
            let cfg = launchd::status();
            println!("{}", serde_json::to_string_pretty(&cfg).unwrap_or_default());
            std::process::exit(0);
        }
        // --test-ocr=<path> : 任意のファイルを Vision OCR にかけて結果を出す
        if let Some(arg) = args.iter().find(|a| a.starts_with("--test-ocr=")) {
            let path = arg.strip_prefix("--test-ocr=").unwrap_or("");
            match vision::recognize_text(path) {
                Ok(r) => {
                    println!("---OCR OK---");
                    println!("language: {}", r.language);
                    println!("lines: {}", r.lines.len());
                    println!("joined:\n{}", r.joined);
                    std::process::exit(0);
                }
                Err(e) => {
                    eprintln!("OCR failed: {}", e);
                    std::process::exit(1);
                }
            }
        }
        // --test-doc=<path> : 文書検出だけ走らせる
        if let Some(arg) = args.iter().find(|a| a.starts_with("--test-doc=")) {
            let path = arg.strip_prefix("--test-doc=").unwrap_or("");
            match vision::has_document(path) {
                Ok(b) => {
                    println!("has_document: {}", b);
                    std::process::exit(0);
                }
                Err(e) => {
                    eprintln!("has_document failed: {}", e);
                    std::process::exit(1);
                }
            }
        }
    }

    let sql_migrations: Vec<Migration> = vec![
        Migration {
            version: 1,
            description: "initial_schema",
            sql: migrations::SCHEMA_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "invoices_and_settings",
            sql: migrations::SCHEMA_V2_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "photo_inbox_and_scan_log",
            sql: migrations::SCHEMA_V3_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "photo_inbox_claude_result_and_retry",
            sql: migrations::SCHEMA_V4_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "photo_inbox_v4_cleanup",
            sql: migrations::SCHEMA_V5_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "photo_inbox_auto_dismissed_reason",
            sql: migrations::SCHEMA_V6_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "photo_inbox_score_signals_json",
            sql: migrations::SCHEMA_V7_SQL,
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("kaikei".into()),
                    }),
                ])
                .build(),
        )
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:kaikei.db", sql_migrations)
                .build(),
        )
        .setup(|app| {

            // receipts ディレクトリを作成
            let app_data_dir = app.path().app_data_dir().ok();
            if let Some(dir) = app_data_dir {
                let receipts_dir = dir.join("receipts");
                let _ = std::fs::create_dir_all(&receipts_dir);
                lan_server::start(receipts_dir);
            }

            // ── メニューバー ──
            // macOS では画面上部に App 名 / ファイル / 編集 / ウインドウ のメニューが出る。
            // ファイルメニューに「データフォルダを開く」「領収書フォルダを開く」を追加し、
            // クラッシュで UI が開かなくなった時でも Finder で中身にアクセスできるようにする。
            {
                let handle = app.handle();
                let about_metadata = AboutMetadataBuilder::new()
                    .name(Some("KAIKEI LOCAL"))
                    .version(Some(env!("CARGO_PKG_VERSION")))
                    .copyright(Some("© 2026 KAIKEI LOCAL"))
                    .build();

                let app_submenu = SubmenuBuilder::new(handle, "KAIKEI LOCAL")
                    .item(&PredefinedMenuItem::about(
                        handle,
                        Some("KAIKEI LOCAL について"),
                        Some(about_metadata),
                    )?)
                    .separator()
                    .item(&PredefinedMenuItem::hide(handle, Some("KAIKEI LOCAL を隠す"))?)
                    .item(&PredefinedMenuItem::hide_others(handle, Some("ほかを隠す"))?)
                    .item(&PredefinedMenuItem::show_all(handle, Some("すべてを表示"))?)
                    .separator()
                    .item(&PredefinedMenuItem::quit(handle, Some("KAIKEI LOCAL を終了"))?)
                    .build()?;

                let open_data_item = MenuItemBuilder::with_id("open_data_dir", "データフォルダを開く")
                    .build(handle)?;
                let open_receipts_item =
                    MenuItemBuilder::with_id("open_receipts_dir", "領収書フォルダを開く")
                        .build(handle)?;
                let open_snapshots_item =
                    MenuItemBuilder::with_id("open_snapshots_dir", "自動バックアップフォルダを開く")
                        .build(handle)?;
                let open_logs_item =
                    MenuItemBuilder::with_id("open_logs_dir", "ログフォルダを開く")
                        .build(handle)?;

                let file_submenu = SubmenuBuilder::new(handle, "ファイル")
                    .item(&open_data_item)
                    .item(&open_receipts_item)
                    .item(&open_snapshots_item)
                    .separator()
                    .item(&open_logs_item)
                    .build()?;

                let edit_submenu = SubmenuBuilder::new(handle, "編集")
                    .item(&PredefinedMenuItem::undo(handle, None)?)
                    .item(&PredefinedMenuItem::redo(handle, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::cut(handle, None)?)
                    .item(&PredefinedMenuItem::copy(handle, None)?)
                    .item(&PredefinedMenuItem::paste(handle, None)?)
                    .item(&PredefinedMenuItem::select_all(handle, None)?)
                    .build()?;

                let window_submenu = SubmenuBuilder::new(handle, "ウインドウ")
                    .item(&PredefinedMenuItem::minimize(handle, None)?)
                    .item(&PredefinedMenuItem::maximize(handle, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::close_window(handle, None)?)
                    .build()?;

                let menu = MenuBuilder::new(handle)
                    .items(&[&app_submenu, &file_submenu, &edit_submenu, &window_submenu])
                    .build()?;

                app.set_menu(menu)?;
                app.on_menu_event(|app_handle, event| {
                    let id = event.id().as_ref();
                    match id {
                        "open_data_dir" => {
                            if let Ok(base) = app_handle.path().app_data_dir() {
                                open_in_finder(&base);
                            }
                        }
                        "open_receipts_dir" => {
                            if let Ok(base) = app_handle.path().app_data_dir() {
                                open_in_finder(&base.join("receipts"));
                            }
                        }
                        "open_snapshots_dir" => {
                            if let Ok(base) = app_handle.path().app_data_dir() {
                                open_in_finder(&base.join("snapshots"));
                            }
                        }
                        "open_logs_dir" => {
                            // ~/Library/Logs/dev.kaikei.app/
                            if let Ok(logs) = app_handle.path().app_log_dir() {
                                open_in_finder(&logs);
                            }
                        }
                        _ => {}
                    }
                });
            }

            // macOS: ウィンドウを Full Screen / Split View 対応にする
            #[cfg(target_os = "macos")]
            {
                use cocoa::base::id;
                use objc::{msg_send, sel, sel_impl};
                // NSWindowCollectionBehaviorFullScreenPrimary         = 1 << 7  = 0x080
                // NSWindowCollectionBehaviorFullScreenAllowsTiling    = 1 << 11 = 0x800
                const BEHAVIOR_FULLSCREEN_PRIMARY: u64 = 1 << 7;
                const BEHAVIOR_FULLSCREEN_ALLOWS_TILING: u64 = 1 << 11;
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(ns_window) = window.ns_window() {
                        unsafe {
                            let ns: id = ns_window as id;
                            let current: u64 = msg_send![ns, collectionBehavior];
                            let new_behavior =
                                current | BEHAVIOR_FULLSCREEN_PRIMARY | BEHAVIOR_FULLSCREEN_ALLOWS_TILING;
                            let _: () = msg_send![ns, setCollectionBehavior: new_behavior];
                        }
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_lan_upload_info,
            list_pending_lan_uploads,
            photos_authorization_status,
            photos_request_authorization,
            photos_scan_recent,
            vision_recognize_text,
            read_image_file,
            launchd_status,
            launchd_install,
            launchd_uninstall,
            db_repair_migration_checksum,
            navigate_target_get,
            navigate_target_clear,
            demo_action_get,
            demo_action_clear,
            wipe_app_data,
            migrations_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
