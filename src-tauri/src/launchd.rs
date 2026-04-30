// LaunchAgent 管理: 毎日決まった時間にヘッドレススキャンを走らせるための
// `~/Library/LaunchAgents/dev.kaikei.scan.plist` を生成・登録・解除する。
//
// 戦略:
//   - .plist の Program は "open" コマンド + KAIKEI LOCAL.app を起動 (--args で
//     --auto-scan を渡す)。GUI バイナリ自体に CLI モードを仕込む方が、署名・配布の
//     観点で Universal な単一バイナリで完結するため楽。
//   - 「open -gj」で background launch (dock を前面に出さない、最小化起動)。
//   - StartCalendarInterval で毎日 HH:MM に発火。
//
// ユーザ操作:
//   - install_launch_agent("21:00") → plist 書き出し + launchctl bootstrap
//   - uninstall_launch_agent() → bootout + ファイル削除
//   - is_launch_agent_installed() → ファイル存在チェック

#![cfg(target_os = "macos")]

use std::path::PathBuf;
use std::process::Command;

const LABEL: &str = "dev.kaikei.scan";

fn plist_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join("Library/LaunchAgents").join(format!("{}.plist", LABEL)))
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct LaunchAgentConfig {
    pub installed: bool,
    pub time: Option<String>, // "HH:MM"
    pub plist_path: Option<String>,
    pub last_run: Option<String>,
}

pub fn status() -> LaunchAgentConfig {
    let path = plist_path();
    let installed = path.as_ref().map(|p| p.exists()).unwrap_or(false);
    let time = if installed {
        path.as_ref().and_then(|p| read_time_from_plist(p))
    } else {
        None
    };
    LaunchAgentConfig {
        installed,
        time,
        plist_path: path.map(|p| p.to_string_lossy().to_string()),
        last_run: None,
    }
}

fn read_time_from_plist(path: &PathBuf) -> Option<String> {
    let content = std::fs::read(path).ok()?;
    let value: plist::Value = plist::from_bytes(&content).ok()?;
    let dict = value.as_dictionary()?;
    let calendar = dict.get("StartCalendarInterval")?.as_dictionary()?;
    let h = calendar.get("Hour")?.as_signed_integer()?;
    let m = calendar.get("Minute")?.as_signed_integer()?;
    Some(format!("{:02}:{:02}", h, m))
}

/// "HH:MM" を hour, minute に分解
fn parse_time(s: &str) -> Result<(u8, u8), String> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 {
        return Err(format!("invalid time format: {}", s));
    }
    let h: u8 = parts[0].parse().map_err(|_| format!("invalid hour: {}", parts[0]))?;
    let m: u8 = parts[1].parse().map_err(|_| format!("invalid minute: {}", parts[1]))?;
    if h > 23 || m > 59 {
        return Err(format!("out of range: {}", s));
    }
    Ok((h, m))
}

/// LaunchAgent を書き出して launchctl bootstrap で登録する。
/// 既に存在する場合は上書き + 再登録。
pub fn install(time: &str) -> Result<LaunchAgentConfig, String> {
    let (hour, minute) = parse_time(time)?;
    let path = plist_path().ok_or_else(|| "home dir not found".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }

    // /Applications/KAIKEI LOCAL.app を起動。--auto-scan 引数を渡す。
    // `open -gj /Applications/KAIKEI\ LOCAL.app --args --auto-scan`
    // -g: background launch (dock がアクティブにならない)
    // -j: junkヒット時にウィンドウ復元しない
    let app_path = "/Applications/KAIKEI LOCAL.app";

    let plist = serde_json::json!({
        "Label": LABEL,
        "ProgramArguments": [
            "/usr/bin/open",
            "-gj",
            app_path,
            "--args",
            "--auto-scan"
        ],
        "RunAtLoad": false,
        "StartCalendarInterval": {
            "Hour": hour,
            "Minute": minute
        },
        "StandardOutPath": dirs::home_dir()
            .map(|h| h.join("Library/Logs/KAIKEI LOCAL/scan-stdout.log").to_string_lossy().to_string())
            .unwrap_or_else(|| "/tmp/kaikei-scan.log".to_string()),
        "StandardErrorPath": dirs::home_dir()
            .map(|h| h.join("Library/Logs/KAIKEI LOCAL/scan-stderr.log").to_string_lossy().to_string())
            .unwrap_or_else(|| "/tmp/kaikei-scan-err.log".to_string()),
    });

    // serde_json::Value → plist (XML) 変換は plist crate 経由で行う
    let xml = serde_json_to_plist_xml(&plist)?;
    std::fs::write(&path, xml).map_err(|e| format!("write plist: {}", e))?;

    // 旧バージョンが load 済みなら bootout してから bootstrap
    let uid = unsafe { libc_getuid() };
    let domain = format!("gui/{}", uid);
    let _ = Command::new("launchctl")
        .args(["bootout", &domain, &path.to_string_lossy()])
        .output();
    let out = Command::new("launchctl")
        .args(["bootstrap", &domain, &path.to_string_lossy()])
        .output()
        .map_err(|e| format!("launchctl bootstrap: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("launchctl bootstrap failed: {}", stderr));
    }

    Ok(status())
}

pub fn uninstall() -> Result<LaunchAgentConfig, String> {
    let path = plist_path().ok_or_else(|| "home dir not found".to_string())?;
    if path.exists() {
        let uid = unsafe { libc_getuid() };
        let domain = format!("gui/{}", uid);
        let _ = Command::new("launchctl")
            .args(["bootout", &domain, &path.to_string_lossy()])
            .output();
        std::fs::remove_file(&path).map_err(|e| format!("remove plist: {}", e))?;
    }
    Ok(status())
}

// JSON Value → plist XML
fn serde_json_to_plist_xml(v: &serde_json::Value) -> Result<Vec<u8>, String> {
    // serde_json::Value を plist::Value に変換
    let plist_v = json_to_plist(v);
    let mut buf = Vec::<u8>::new();
    plist::to_writer_xml(&mut buf, &plist_v).map_err(|e| format!("plist write: {}", e))?;
    Ok(buf)
}

fn json_to_plist(v: &serde_json::Value) -> plist::Value {
    use serde_json::Value as J;
    match v {
        J::Null => plist::Value::String(String::new()),
        J::Bool(b) => plist::Value::Boolean(*b),
        J::Number(n) => {
            if let Some(i) = n.as_i64() {
                plist::Value::Integer(i.into())
            } else if let Some(f) = n.as_f64() {
                plist::Value::Real(f)
            } else {
                plist::Value::String(n.to_string())
            }
        }
        J::String(s) => plist::Value::String(s.clone()),
        J::Array(arr) => {
            let v: Vec<plist::Value> = arr.iter().map(json_to_plist).collect();
            plist::Value::Array(v)
        }
        J::Object(obj) => {
            let mut d = plist::Dictionary::new();
            for (k, val) in obj {
                d.insert(k.clone(), json_to_plist(val));
            }
            plist::Value::Dictionary(d)
        }
    }
}

// libc::getuid を直接呼ぶ (依存追加を避ける)
extern "C" {
    fn getuid() -> u32;
}
unsafe fn libc_getuid() -> u32 {
    getuid()
}
