mod lan_server;
mod migrations;

#[cfg(target_os = "macos")]
mod photos;

#[cfg(target_os = "macos")]
mod vision;

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

/// Vision.framework で画像のテキストを認識して返す。完全ローカル、ネット送信なし。
/// 結果: { lines: string[], joined: string, language: "ja"|"en" }
#[tauri::command]
async fn vision_recognize_text(file_path: String) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        let result =
            tokio::task::spawn_blocking(move || vision::recognize_text(&file_path))
                .await
                .map_err(|e| format!("join: {}", e))??;
        Ok(serde_json::to_value(result).unwrap_or(serde_json::Value::Null))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = file_path;
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


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
