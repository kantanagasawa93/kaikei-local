use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::StatusCode,
    response::Html,
    routing::{get, post},
    Router,
};
use local_ip_address::local_ip;
use qrcode::render::svg;
use qrcode::QrCode;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use subtle::ConstantTimeEq;
use tokio::runtime::Runtime;

// ============================================================
// 定数
// ============================================================
const PORT: u16 = 17777;
const MAX_BODY_SIZE: usize = 25 * 1024 * 1024; // 25MB
const MAX_NAME_MEMO: usize = 500;              // 元ファイル名を覚えておく最大件数
/// スマホから受信したファイルの保存名の接頭辞。
/// 受信済み・未登録の一覧は「receipts/ にあるこの接頭辞のファイル」から組み立てる。
/// (以前はメモリ上のキューだけで管理していたため、画面を離れる・アプリを再起動すると
///  受信済みの写真が一覧から消え、さらに「孤児ファイル整理」で削除されていた)
pub const PHONE_PREFIX: &str = "phone-";
const MAX_FIELDS_PER_REQUEST: usize = 10;      // multipart 1 リクエストで処理する上限
const UPLOAD_TIMEOUT_SECS: u64 = 30;           // 1 フィールドの読み取りタイムアウト

// アップロードを受け付ける拡張子の許可リスト
const ALLOWED_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tiff", "pdf",
];

// ============================================================
// 型
// ============================================================
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LanInfo {
    pub url: String,
    pub qr_svg: String,
    pub token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PendingUpload {
    pub filename: String,
    pub relative_path: String, // receipts/ 配下の相対パス
    pub received_at: String,
}

// ============================================================
// 共有状態
// ============================================================
static INFO: OnceLock<Mutex<Option<LanInfo>>> = OnceLock::new();
/// 保存名 → スマホ側の元ファイル名 (表示用のメモ。無くても動く)
static ORIGINAL_NAMES: OnceLock<Mutex<Vec<(String, String)>>> = OnceLock::new();
static RUNTIME: OnceLock<Runtime> = OnceLock::new();
static STARTED: OnceLock<()> = OnceLock::new();

#[derive(Clone)]
struct AppState {
    receipts_dir: PathBuf,
    token: String,
}

// ============================================================
// 外部公開 API
// ============================================================
pub fn start(receipts_dir: PathBuf) {
    if STARTED.set(()).is_err() {
        log::warn!("LAN server already started, skipping");
        return;
    }

    let token = generate_token();
    let ip = match local_ip() {
        Ok(i) => i.to_string(),
        Err(e) => {
            log::warn!("Failed to detect local IP ({}), falling back to 127.0.0.1", e);
            "127.0.0.1".into()
        }
    };
    let url = format!("http://{}:{}/upload?t={}", ip, PORT, token);

    let qr_svg = QrCode::new(url.as_bytes())
        .map(|code| {
            code.render::<svg::Color>()
                .min_dimensions(240, 240)
                .dark_color(svg::Color("#000"))
                .light_color(svg::Color("#fff"))
                .build()
        })
        .unwrap_or_default();

    let info = LanInfo {
        url,
        qr_svg,
        token: token.clone(),
    };
    if let Ok(mut g) = INFO.get_or_init(|| Mutex::new(None)).lock() {
        *g = Some(info);
    }

    ORIGINAL_NAMES.get_or_init(|| Mutex::new(Vec::new()));

    let state = AppState {
        receipts_dir,
        token,
    };
    let app = Router::new()
        .route("/", get(root))
        .route("/upload", get(upload_form))
        .route("/upload/:token", post(upload_file))
        .layer(DefaultBodyLimit::max(MAX_BODY_SIZE))
        .with_state(state);

    let rt = match RUNTIME.get() {
        Some(r) => r,
        None => {
            match Runtime::new() {
                Ok(r) => {
                    let _ = RUNTIME.set(r);
                    RUNTIME.get().expect("runtime just set")
                }
                Err(e) => {
                    log::error!("Failed to create tokio runtime for LAN server: {}", e);
                    return;
                }
            }
        }
    };
    rt.spawn(async move {
        let addr = SocketAddr::from(([0, 0, 0, 0], PORT));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                if let Err(e) = axum::serve(listener, app).await {
                    log::warn!("LAN server serve ended: {}", e);
                }
            }
            Err(e) => {
                log::warn!("LAN server bind failed: {}", e);
            }
        }
    });
}

pub fn current_info() -> Option<LanInfo> {
    INFO.get()?.lock().ok()?.clone()
}

fn original_name_of(safe: &str) -> Option<String> {
    let guard = ORIGINAL_NAMES.get()?.lock().ok()?;
    guard.iter().rev().find(|(k, _)| k == safe).map(|(_, v)| v.clone())
}

/// `phone-<秒>-<uuid>.<ext>` の <秒> 部分を取り出す。形式が違えば None。
fn received_secs_of(safe: &str) -> Option<u64> {
    let rest = safe.strip_prefix(PHONE_PREFIX)?;
    let (secs, _) = rest.split_once('-')?;
    if secs.is_empty() || !secs.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    secs.parse().ok()
}

/// スマホから受信して receipts/ に保存済みのファイル一覧 (受信の古い順)。
///
/// ディスク上のファイルから毎回組み立てるので、読んでも消えない。
/// 領収書として登録済みかどうかは DB を見ないと分からないため、呼び出し側
/// (phone-upload ページ) が receipts.image_url と突き合わせて未登録分だけを表示する。
pub fn list_pending(receipts_dir: &std::path::Path) -> Vec<PendingUpload> {
    let Ok(read) = std::fs::read_dir(receipts_dir) else {
        return Vec::new();
    };
    let mut out: Vec<(u64, PendingUpload)> = Vec::new();
    for entry in read.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let safe = entry.file_name().to_string_lossy().to_string();
        let Some(secs) = received_secs_of(&safe) else {
            continue;
        };
        out.push((
            secs,
            PendingUpload {
                filename: original_name_of(&safe).unwrap_or_else(|| safe.clone()),
                relative_path: format!("receipts/{}", safe),
                received_at: secs.to_string(),
            },
        ));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.relative_path.cmp(&b.1.relative_path)));
    out.into_iter().map(|(_, p)| p).collect()
}

// ============================================================
// 内部ヘルパ
// ============================================================
fn generate_token() -> String {
    use rand::Rng;
    let chars: Vec<char> = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".chars().collect();
    let mut rng = rand::thread_rng();
    (0..8).map(|_| chars[rng.gen_range(0..chars.len())]).collect()
}

fn sanitize_ext(filename: &str) -> &'static str {
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("bin")
        .to_ascii_lowercase();
    for allowed in ALLOWED_EXTS {
        if ext == *allowed {
            return allowed;
        }
    }
    "bin"
}

fn chrono_like_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", secs)
}

fn constant_time_eq_str(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.as_bytes().ct_eq(b.as_bytes()).unwrap_u8() == 1
}

fn remember_original_name(safe: &str, original: &str) {
    if let Some(m) = ORIGINAL_NAMES.get() {
        let mut g = match m.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        while g.len() >= MAX_NAME_MEMO {
            g.remove(0);
        }
        g.push((safe.to_string(), original.to_string()));
    }
}

// ============================================================
// ハンドラ
// ============================================================
#[derive(Deserialize)]
struct FormQuery {
    t: Option<String>,
}

/// ルートは何も返さない。以前はここがアップロードフォーム (= トークン入り) を
/// 無条件で返していたため、同じ Wi-Fi 上の誰でもトークンを取得してアップロードできた。
async fn root() -> StatusCode {
    StatusCode::NOT_FOUND
}

/// アップロードフォーム。QR コードの URL に付いている `?t=<トークン>` が合っている時だけ返す。
async fn upload_form(
    State(state): State<AppState>,
    Query(q): Query<FormQuery>,
) -> Result<Html<String>, StatusCode> {
    let given = q.t.unwrap_or_default();
    if !constant_time_eq_str(&given, &state.token) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    // token は英数字のみの乱数なので HTML エスケープ不要だが、
    // 念のため非英数字が混入していた場合のフォールバック処理
    let token_safe: String = state
        .token
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();

    let html = format!(
        r##"<!doctype html><html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KAIKEI LOCAL - 領収書アップロード</title>
<style>
body{{font-family:-apple-system,sans-serif;background:#f5f5f7;color:#111;max-width:480px;margin:0 auto;padding:24px}}
h1{{font-size:20px}}
.card{{background:#fff;padding:20px;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:16px}}
button{{background:#111;color:#fff;border:0;padding:14px 20px;border-radius:10px;font-size:16px;width:100%;margin-top:12px}}
input[type=file]{{display:block;margin:12px 0;width:100%}}
.status{{font-size:14px;color:#666;margin-top:8px}}
.ok{{color:#0a8a3a}}
</style>
</head><body>
<div class="card">
<h1>📷 領収書をアップロード</h1>
<p>同じWi-Fi上のデスクトップアプリに送信されます。</p>
<form id="f" action="/upload/{token}" method="post" enctype="multipart/form-data">
<input type="file" name="file" accept="image/*,application/pdf" capture="environment" required>
<button type="submit">送信</button>
</form>
<div id="s" class="status"></div>
</div>
<script>
const f = document.getElementById('f');
const s = document.getElementById('s');
f.addEventListener('submit', async (e) => {{
  e.preventDefault();
  s.textContent = '送信中...';
  const fd = new FormData(f);
  try {{
    const r = await fetch(f.action, {{method:'POST', body: fd}});
    if (r.ok) {{
      s.innerHTML = '<span class="ok">✓ 送信しました</span>';
      f.reset();
    }} else {{
      s.textContent = '失敗しました (' + r.status + ')';
    }}
  }} catch (err) {{ s.textContent = 'エラー: ' + err; }}
}});
</script>
</body></html>"##,
        token = token_safe
    );
    Ok(Html(html))
}

async fn upload_file(
    Path(token): Path<String>,
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<&'static str, StatusCode> {
    if !constant_time_eq_str(&token, &state.token) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let mut field_count = 0usize;
    loop {
        if field_count >= MAX_FIELDS_PER_REQUEST {
            return Err(StatusCode::BAD_REQUEST);
        }
        field_count += 1;

        // 1 フィールドあたり UPLOAD_TIMEOUT_SECS 秒でタイムアウト
        let next = tokio::time::timeout(
            std::time::Duration::from_secs(UPLOAD_TIMEOUT_SECS),
            multipart.next_field(),
        )
        .await;

        let field = match next {
            Ok(Ok(Some(f))) => f,
            Ok(Ok(None)) => break,
            Ok(Err(_)) => return Err(StatusCode::BAD_REQUEST),
            Err(_) => return Err(StatusCode::REQUEST_TIMEOUT),
        };

        let filename = field
            .file_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("upload-{}.bin", uuid::Uuid::new_v4()));
        let data = field.bytes().await.map_err(|_| StatusCode::BAD_REQUEST)?;

        // サイズ再確認
        if data.len() > MAX_BODY_SIZE {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }

        let ext = sanitize_ext(&filename);
        let safe = format!(
            "{}{}-{}.{}",
            PHONE_PREFIX,
            chrono_like_timestamp(),
            uuid::Uuid::new_v4(),
            ext
        );
        let path = state.receipts_dir.join(&safe);
        if let Err(e) = std::fs::write(&path, &data) {
            log::warn!("write upload failed: {}", e);
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
        remember_original_name(&safe, &filename);
    }
    Ok("ok")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_list_is_built_from_disk_and_is_not_consumed_by_reading() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("phone-1700000200-aaaaaaaa-0000-0000-0000-000000000000.jpg"), b"2").unwrap();
        std::fs::write(dir.join("phone-1700000100-bbbbbbbb-0000-0000-0000-000000000000.heic"), b"1").unwrap();
        // スマホ受信ではないファイル (ドロップ取込・旧形式・トリミング前バックアップ)
        std::fs::write(dir.join("1700000000000-cccccccc.jpg"), b"x").unwrap();
        std::fs::write(dir.join("phone-notanumber-x.jpg"), b"x").unwrap();
        std::fs::create_dir_all(dir.join("phone-1700000300-dir")).unwrap();

        let first = list_pending(dir);
        let names: Vec<_> = first.iter().map(|p| p.relative_path.clone()).collect();
        assert_eq!(
            names,
            vec![
                "receipts/phone-1700000100-bbbbbbbb-0000-0000-0000-000000000000.heic",
                "receipts/phone-1700000200-aaaaaaaa-0000-0000-0000-000000000000.jpg",
            ],
            "受信の古い順・スマホ受信ファイルだけ"
        );
        assert_eq!(first[0].received_at, "1700000100");

        // 何度読んでも同じ (旧実装は 1 回読むと消えた)
        assert_eq!(list_pending(dir).len(), 2);
    }

    #[test]
    fn received_secs_only_accepts_the_phone_upload_name_shape() {
        assert_eq!(received_secs_of("phone-1700000000-uuid.jpg"), Some(1700000000));
        assert_eq!(received_secs_of("1700000000-uuid.jpg"), None);
        assert_eq!(received_secs_of("phone--uuid.jpg"), None);
        assert_eq!(received_secs_of("phone-12ab-uuid.jpg"), None);
        assert_eq!(received_secs_of("phone-1700000000.jpg"), None);
    }

    #[test]
    fn token_comparison_rejects_empty_and_wrong_values() {
        assert!(constant_time_eq_str("ABCD2345", "ABCD2345"));
        assert!(!constant_time_eq_str("", "ABCD2345"));
        assert!(!constant_time_eq_str("ABCD2346", "ABCD2345"));
        assert!(!constant_time_eq_str("ABCD234", "ABCD2345"));
    }
}
