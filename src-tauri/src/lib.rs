mod lan_server;
mod migrations;

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
