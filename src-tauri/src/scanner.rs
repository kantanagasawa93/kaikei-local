// ヘッドレススキャン (LaunchAgent / `kaikei --auto-scan` から呼ばれる).
//
// メインアプリの GUI を立ち上げずに:
//   1. PhotoKit から増分写真を取得
//   2. Vision OCR でテキスト抽出
//   3. classifier でスコアリング
//   4. SQLite (Tauri と同じ kaikei.db) に photo_inbox / photo_scan_log を直接書き込み
//   5. 結果を NSUserNotification で通知
// を完結させる。
//
// 注: rusqlite のスキーマは Tauri 経由のマイグレーションが事前に当たっている前提。
// CLI scanner はマイグレーションを再実行しない (バージョン乖離を避けるため初回は
// メインアプリで起動して migrate v3 まで完了させてから LaunchAgent を有効化する流れ)。

#![cfg(target_os = "macos")]

use std::path::PathBuf;

use crate::classifier;
use crate::photos;
use crate::vision;

use rusqlite::params;
use std::io::Write;

/// LaunchAgent から呼ばれる場合 stdio が `open(1)` で食われて plist の
/// StandardErrorPath にも届かないため、scanner 自身でログファイルを開いて
/// 追記する。手動 (`kaikei --auto-scan` をターミナルから) で動かす分には
/// stderr にも従来通り出力される。
fn log_file_path() -> std::path::PathBuf {
    dirs::home_dir()
        .map(|h| h.join("Library/Logs/KAIKEI LOCAL/scan.log"))
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp/kaikei-scan.log"))
}

pub fn log_line(msg: &str) {
    eprintln!("[scanner] {}", msg);
    let path = log_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(f, "[{}] {}", ts, msg);
    }
}

#[derive(Debug)]
pub struct ScanSummary {
    pub scanned: usize,
    pub new_photos: usize,
    pub receipts: usize,
    /// Round 23: OCR が空 + classifier.score == 0 で「明らかに領収書ではない」と
    /// 判定して photo_inbox に INSERT しなかった件数 (= 「未判定」を雪崩のように
    /// 並べないための事前フィルタ)。strict mode 時のみカウントされる。
    pub skipped: usize,
    pub errors: Vec<String>,
}

/// LaunchAgent / CLI から呼ばれるエントリポイント。
/// app_data_dir = ~/Library/Application Support/dev.kaikei.app/
pub fn run_once(app_data_dir: &PathBuf) -> Result<ScanSummary, String> {
    log_line(&format!("run_once start: app_data={}", app_data_dir.display()));
    let auth = photos::authorization_status();
    if auth != "authorized" && auth != "limited" {
        let msg = format!("not authorized: {}", auth);
        log_line(&msg);
        return Err(msg);
    }

    let inbox_dir = app_data_dir.join("inbox");
    std::fs::create_dir_all(&inbox_dir).map_err(|e| format!("mkdir inbox: {}", e))?;

    let db_path = app_data_dir.join("kaikei.db");
    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("open db ({}): {}", db_path.display(), e))?;

    // GUI アプリの起動を一度も経ていない場合 photo_scan_log が無い。
    // その場合は明示エラーで止めて「初回は KAIKEI LOCAL.app を開いてください」
    // と促す (cargo の migration を CLI 側でやり直すと version 不整合の
    // 危険があるため、敢えて GUI 経由に統一する)。
    let has_v3: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='photo_scan_log' LIMIT 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|_| true)
        .unwrap_or(false);
    if !has_v3 {
        let msg = "DB v3 migration not applied. Please open KAIKEI LOCAL.app once first.";
        log_line(msg);
        return Err(msg.into());
    }

    // 前回スキャン時刻を取得
    let last_scan: i64 = conn
        .query_row(
            "SELECT value FROM app_settings WHERE id='photo_scan_last_unix'",
            [],
            |row| {
                let s: String = row.get(0)?;
                Ok(s.parse::<i64>().unwrap_or(0))
            },
        )
        .unwrap_or(0);

    let since = if last_scan > 0 {
        last_scan
    } else {
        // 初回 fallback: 過去 7 日
        chrono::Utc::now().timestamp() - 7 * 24 * 3600
    };

    // photo_scan_log の進行行
    let log_id = uuid::Uuid::new_v4().to_string();
    let started_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO photo_scan_log (id, started_at, trigger, scanned_count, receipt_count, imported_count) VALUES (?, ?, 'launchagent', 0, 0, 0)",
        params![log_id, started_at],
    )
    .map_err(|e| format!("insert log: {}", e))?;

    let scanned = match photos::scan_recent(since, &inbox_dir) {
        Ok(v) => v,
        Err(e) => {
            let _ = conn.execute(
                "UPDATE photo_scan_log SET finished_at = ?, error = ? WHERE id = ?",
                params![chrono::Utc::now().to_rfc3339(), e, log_id],
            );
            return Err(e);
        }
    };

    let mut summary = ScanSummary {
        scanned: scanned.len(),
        new_photos: 0,
        receipts: 0,
        skipped: 0,
        errors: vec![],
    };

    // Round 23: 厳格フィルタ ON/OFF。app_settings.inbox_strict_filter='false' で
    // 明示的に OFF にしない限りデフォルト ON。OFF にすると「OCR 空 + score=0」も
    // 全部 photo_inbox に並ぶ (旧挙動)。
    let strict_filter: bool = conn
        .query_row(
            "SELECT value FROM app_settings WHERE id='inbox_strict_filter'",
            [],
            |row| {
                let s: String = row.get(0)?;
                Ok(s != "false")
            },
        )
        .unwrap_or(true);

    let mut latest_taken: i64 = since;

    for photo in &scanned {
        if photo.taken_at > latest_taken {
            latest_taken = photo.taken_at;
        }
        // 重複チェック
        let existing: rusqlite::Result<i64> = conn.query_row(
            "SELECT 1 FROM photo_inbox WHERE source_asset_id = ?",
            params![photo.asset_id],
            |row| row.get(0),
        );
        if existing.is_ok() {
            continue;
        }

        // Vision OCR
        // Round 21 ⓐ: classify_with_signals に is_favorite を渡してスコアブースト
        let (ocr_text, score, state) = match vision::recognize_text(&photo.file_path) {
            Ok(v) => {
                let cls = classifier::classify_with_signals(&v.joined, photo.is_favorite);
                (Some(v.joined), Some(cls.score), cls.state.as_str().to_string())
            }
            Err(e) => {
                summary.errors.push(format!("{}: vision: {}", photo.asset_id, e));
                (None, None, "candidate".to_string())
            }
        };

        // Round 23: 厳格フィルタ (OCR 空 or score=0) → photo_inbox に INSERT しない。
        // 既に inbox/ にコピーした jpg ファイルは削除して帯域・ストレージも回収。
        // is_favorite=true は救済 (ユーザが意図的に保存した可能性)。
        if strict_filter && !photo.is_favorite {
            let ocr_empty = ocr_text
                .as_ref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true);
            let zero_score = match score {
                Some(s) => s <= 0.001,
                None => true,
            };
            if ocr_empty || zero_score {
                let _ = std::fs::remove_file(&photo.file_path);
                summary.skipped += 1;
                continue;
            }
        }

        let id = uuid::Uuid::new_v4().to_string();
        let taken_at_iso =
            chrono::DateTime::<chrono::Utc>::from_timestamp(photo.taken_at, 0)
                .map(|d| d.to_rfc3339())
                .unwrap_or_default();

        let res = conn.execute(
            "INSERT INTO photo_inbox (id, source_asset_id, taken_at, detected_at, width, height, file_path, ocr_text, state, receipt_score)
             VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)",
            params![
                id,
                photo.asset_id,
                taken_at_iso,
                photo.width,
                photo.height,
                photo.file_path,
                ocr_text,
                state,
                score
            ],
        );
        match res {
            Ok(_) => {
                summary.new_photos += 1;
                if state == "receipt" {
                    summary.receipts += 1;
                }
            }
            Err(e) => {
                summary.errors.push(format!("{}: insert: {}", photo.asset_id, e));
            }
        }
    }

    // 前回スキャン時刻を更新
    let new_last = if latest_taken > since {
        latest_taken
    } else {
        chrono::Utc::now().timestamp()
    };
    let now_iso = chrono::Utc::now().to_rfc3339();
    let upsert = conn.execute(
        "INSERT INTO app_settings (id, value, updated_at) VALUES ('photo_scan_last_unix', ?, ?)
         ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![new_last.to_string(), now_iso],
    );
    if let Err(e) = upsert {
        summary.errors.push(format!("update last_scan: {}", e));
    }

    let err_str = if summary.errors.is_empty() {
        None
    } else {
        Some(summary.errors.join("; ").chars().take(500).collect::<String>())
    };
    let _ = conn.execute(
        "UPDATE photo_scan_log SET finished_at = ?, scanned_count = ?, receipt_count = ?, error = ? WHERE id = ?",
        params![
            chrono::Utc::now().to_rfc3339(),
            summary.scanned as i64,
            summary.receipts as i64,
            err_str,
            log_id
        ],
    );

    Ok(summary)
}

/// macOS の通知センターに「スキャン完了」を出す。
/// notarized + signed の場合のみ表示される。dev ビルドだと Apple は通知を弾く。
pub fn post_notification(title: &str, body: &str) {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        // UNUserNotificationCenter (modern API) は authorization が要る。
        // CLI scanner では legacy NSUserNotification を使う (macOS 11+ で
        // deprecated だが動く)。
        let center: id = msg_send![class!(NSUserNotificationCenter), defaultUserNotificationCenter];
        if center == nil {
            return;
        }
        let alloc: id = msg_send![class!(NSUserNotification), alloc];
        let n: id = msg_send![alloc, init];
        let title_ns: id = NSString::alloc(nil).init_str(title);
        let body_ns: id = NSString::alloc(nil).init_str(body);
        let _: () = msg_send![n, setTitle: title_ns];
        let _: () = msg_send![n, setInformativeText: body_ns];
        let _: () = msg_send![center, deliverNotification: n];
    }
}
