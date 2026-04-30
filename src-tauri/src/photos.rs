// macOS Photos.framework wrapper (PhotoKit) for KAIKEI LOCAL.
//
// 役割:
//   - ユーザの「写真」ライブラリ (iCloud 同期含む) から最近の写真メタデータを取得
//   - 各写真の JPEG/HEIF バイト列を取り出してディスクに保存
//   - 取得した写真は呼び出し側で領収書フィルタ (Vision OCR) に流す
//
// 重要:
//   - 初回呼出で macOS のシステムダイアログ (写真アクセス許可) が出る。
//     ダイアログ表示には Info.plist の NSPhotoLibraryUsageDescription
//     と entitlements の com.apple.security.personal-information.photos-library
//     が必須。
//   - PHFetchOptions.predicate で `creationDate > since_unix` の絞り込みを
//     ネイティブ側で完結させ、Mac 上の数万枚ライブラリでも高速。
//   - PHImageRequestOptions.synchronous = YES + networkAccessAllowed = YES で
//     iCloud 上にしかない写真も自動でダウンロードして取れる。
//
// プラットフォーム: macOS 限定。他 OS では空 stub を提供 (Tauri はビルド時に
// cfg(target_os) で除外できないので最低限のシグネチャを残す)。

#![cfg(target_os = "macos")]
#![allow(unexpected_cfgs)] // objc::msg_send macro emits some

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cocoa::base::{id, nil, BOOL, YES};
use cocoa::foundation::NSString;
use objc::runtime::Class;
use objc::{class, msg_send, sel, sel_impl};

#[link(name = "Photos", kind = "framework")]
extern "C" {}

// ────────────────────────────────────────────────────────────
// PhotoKit 定数 (Apple ヘッダから引用)
// ────────────────────────────────────────────────────────────

/// PHAuthorizationStatus
const PH_AUTH_NOT_DETERMINED: i64 = 0;
const PH_AUTH_RESTRICTED: i64 = 1;
const PH_AUTH_DENIED: i64 = 2;
const PH_AUTH_AUTHORIZED: i64 = 3;
const PH_AUTH_LIMITED: i64 = 4;

/// PHAccessLevel: read-only で十分 (書き込みは要らない)。
const PH_ACCESS_LEVEL_READ: i64 = 1;

/// PHAssetMediaType: 1 = image
const PH_MEDIA_TYPE_IMAGE: i64 = 1;

/// PHImageRequestOptionsDeliveryMode: 1 = HighQualityFormat
const PH_DELIVERY_MODE_HIGH_QUALITY: i64 = 1;

/// PHImageRequestOptionsVersion: 0 = current (edits applied)
const PH_VERSION_CURRENT: i64 = 0;

// ────────────────────────────────────────────────────────────
// 公開 API
// ────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Debug, Clone)]
pub struct ScannedPhoto {
    pub asset_id: String,
    pub taken_at: i64, // unix seconds
    pub width: i64,
    pub height: i64,
    pub file_path: String,
}

/// 現在の写真ライブラリへのアクセス権限を返す。
/// "authorized" / "limited" / "denied" / "restricted" / "not_determined" / "unknown"
pub fn authorization_status() -> &'static str {
    unsafe {
        let cls = class!(PHPhotoLibrary);
        let status: i64 = msg_send![cls, authorizationStatusForAccessLevel: PH_ACCESS_LEVEL_READ];
        match status {
            PH_AUTH_NOT_DETERMINED => "not_determined",
            PH_AUTH_RESTRICTED => "restricted",
            PH_AUTH_DENIED => "denied",
            PH_AUTH_AUTHORIZED => "authorized",
            PH_AUTH_LIMITED => "limited",
            _ => "unknown",
        }
    }
}

/// アクセス権限ダイアログを出して結果を返す。
/// 既に許可済みの場合は即座に "authorized" / "limited" を返す。
/// ダイアログ表示中はこの関数がブロックする (タイムアウト 60秒)。
pub fn request_authorization() -> &'static str {
    let current = authorization_status();
    if current != "not_determined" {
        return current;
    }

    let result: Arc<(Mutex<Option<i64>>, std::sync::Condvar)> =
        Arc::new((Mutex::new(None), std::sync::Condvar::new()));
    let result_clone = result.clone();

    unsafe {
        use block::ConcreteBlock;
        let handler = ConcreteBlock::new(move |status: i64| {
            let (lock, cvar) = &*result_clone;
            let mut guard = lock.lock().unwrap();
            *guard = Some(status);
            cvar.notify_all();
        });
        let handler = handler.copy();

        let cls = class!(PHPhotoLibrary);
        let _: () = msg_send![cls,
            requestAuthorizationForAccessLevel: PH_ACCESS_LEVEL_READ
            handler: &*handler];
    }

    let (lock, cvar) = &*result;
    let mut guard = lock.lock().unwrap();
    let timeout = std::time::Instant::now() + Duration::from_secs(60);
    while guard.is_none() {
        let now = std::time::Instant::now();
        if now >= timeout {
            return "denied"; // ダイアログ無視されたら拒否扱い
        }
        let (g, _) = cvar.wait_timeout(guard, timeout - now).unwrap();
        guard = g;
    }
    match guard.take() {
        Some(PH_AUTH_AUTHORIZED) => "authorized",
        Some(PH_AUTH_LIMITED) => "limited",
        Some(PH_AUTH_DENIED) => "denied",
        Some(PH_AUTH_RESTRICTED) => "restricted",
        _ => "unknown",
    }
}

/// `since_unix` 以降に撮影された画像を全取得し、JPEG/HEIF バイトを `output_dir`
/// に保存して [`ScannedPhoto`] のリストを返す。
/// 既存ファイル (asset_id で名前衝突) は再取得せずスキップ。
pub fn scan_recent(since_unix: i64, output_dir: &Path) -> Result<Vec<ScannedPhoto>, String> {
    let auth = authorization_status();
    if auth != "authorized" && auth != "limited" {
        return Err(format!("not_authorized:{}", auth));
    }
    std::fs::create_dir_all(output_dir).map_err(|e| format!("mkdir failed: {}", e))?;

    unsafe {
        // NSDate from since_unix
        let since_date: id = msg_send![class!(NSDate),
            dateWithTimeIntervalSince1970: since_unix as f64];

        // PHFetchOptions
        let options: id = {
            let alloc: id = msg_send![class!(PHFetchOptions), alloc];
            msg_send![alloc, init]
        };

        // predicate: mediaType = 1 (image) AND creationDate > since
        // ObjC の variadic +predicateWithFormat: は Rust FFI から呼べないので、
        // +predicateWithFormat:argumentArray: 経由で NSArray<id> として引数を渡す。
        // %d は NSNumber に、%@ はそのまま NSDate に置換される。
        let predicate_format = nsstring("mediaType = %@ AND creationDate > %@");
        let media_type_num: id = msg_send![class!(NSNumber),
            numberWithInt: PH_MEDIA_TYPE_IMAGE as i32];
        let predicate_args: [id; 2] = [media_type_num, since_date];
        let predicate_arr: id = msg_send![class!(NSArray),
            arrayWithObjects: predicate_args.as_ptr()
            count: 2u64];
        let predicate: id = msg_send![class!(NSPredicate),
            predicateWithFormat: predicate_format
            argumentArray: predicate_arr];
        let _: () = msg_send![options, setPredicate: predicate];

        // sortDescriptors: creationDate ascending
        let sort_key = nsstring("creationDate");
        let sort_descriptor: id = msg_send![class!(NSSortDescriptor),
            sortDescriptorWithKey: sort_key
            ascending: YES];
        let descriptors: id = msg_send![class!(NSArray),
            arrayWithObject: sort_descriptor];
        let _: () = msg_send![options, setSortDescriptors: descriptors];

        // fetch
        let assets: id = msg_send![class!(PHAsset),
            fetchAssetsWithOptions: options];
        let count: u64 = msg_send![assets, count];

        let mut out: Vec<ScannedPhoto> = Vec::with_capacity(count as usize);

        // PHImageRequestOptions (synchronous + iCloud download OK)
        let req_opts: id = {
            let alloc: id = msg_send![class!(PHImageRequestOptions), alloc];
            msg_send![alloc, init]
        };
        let _: () = msg_send![req_opts, setSynchronous: YES];
        let _: () = msg_send![req_opts, setNetworkAccessAllowed: YES];
        let _: () = msg_send![req_opts, setVersion: PH_VERSION_CURRENT];
        let _: () = msg_send![req_opts, setDeliveryMode: PH_DELIVERY_MODE_HIGH_QUALITY];

        let manager: id = msg_send![class!(PHImageManager), defaultManager];

        for i in 0..count {
            let asset: id = msg_send![assets, objectAtIndex: i];
            if asset == nil {
                continue;
            }

            let local_id_ns: id = msg_send![asset, localIdentifier];
            let asset_id = nsstring_to_rust(local_id_ns);
            if asset_id.is_empty() {
                continue;
            }

            let creation_date: id = msg_send![asset, creationDate];
            let taken_at: f64 = if creation_date == nil {
                0.0
            } else {
                msg_send![creation_date, timeIntervalSince1970]
            };
            let width: u64 = msg_send![asset, pixelWidth];
            let height: u64 = msg_send![asset, pixelHeight];

            // 衝突する asset_id は LocalIdentifier に "/" を含むので置換
            let safe_name = asset_id.replace('/', "_");
            let file_path = output_dir.join(format!("{}.jpg", safe_name));
            if file_path.exists() {
                // 既に取得済み — メタだけ詰めて返す
                out.push(ScannedPhoto {
                    asset_id,
                    taken_at: taken_at as i64,
                    width: width as i64,
                    height: height as i64,
                    file_path: file_path.to_string_lossy().to_string(),
                });
                continue;
            }

            // 画像データ取得 (synchronous=YES でも block で結果を受け取る)
            let bytes = match request_image_data(manager, asset, req_opts) {
                Ok(b) => b,
                Err(e) => {
                    log::warn!("photo fetch failed for {}: {}", asset_id, e);
                    continue;
                }
            };

            if let Err(e) = std::fs::write(&file_path, &bytes) {
                log::warn!("save photo failed: {}", e);
                continue;
            }
            out.push(ScannedPhoto {
                asset_id,
                taken_at: taken_at as i64,
                width: width as i64,
                height: height as i64,
                file_path: file_path.to_string_lossy().to_string(),
            });
        }

        Ok(out)
    }
}

// ────────────────────────────────────────────────────────────
// 内部ユーティリティ
// ────────────────────────────────────────────────────────────

unsafe fn request_image_data(manager: id, asset: id, options: id) -> Result<Vec<u8>, String> {
    use block::ConcreteBlock;

    let result: Arc<(Mutex<Option<Result<Vec<u8>, String>>>, std::sync::Condvar)> =
        Arc::new((Mutex::new(None), std::sync::Condvar::new()));
    let result_clone = result.clone();

    let handler = ConcreteBlock::new(
        move |data: id, _data_uti: id, _orientation: u32, _info: id| {
            let bytes = if data == nil {
                Err("nil image data".to_string())
            } else {
                let len: u64 = unsafe { msg_send![data, length] };
                let ptr: *const u8 = unsafe { msg_send![data, bytes] };
                if ptr.is_null() || len == 0 {
                    Err("empty image data".to_string())
                } else {
                    let slice = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
                    Ok(slice.to_vec())
                }
            };
            let (lock, cvar) = &*result_clone;
            let mut g = lock.lock().unwrap();
            *g = Some(bytes);
            cvar.notify_all();
        },
    );
    let handler = handler.copy();

    let _: () = msg_send![manager,
        requestImageDataAndOrientationForAsset: asset
        options: options
        resultHandler: &*handler];

    let (lock, cvar) = &*result;
    let mut g = lock.lock().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while g.is_none() {
        let now = std::time::Instant::now();
        if now >= deadline {
            return Err("photo fetch timeout".into());
        }
        let (ng, _) = cvar.wait_timeout(g, deadline - now).unwrap();
        g = ng;
    }
    g.take().unwrap_or_else(|| Err("no result".into()))
}

unsafe fn nsstring(s: &str) -> id {
    NSString::alloc(nil).init_str(s)
}

unsafe fn nsstring_to_rust(ns: id) -> String {
    if ns == nil {
        return String::new();
    }
    let bytes: *const i8 = msg_send![ns, UTF8String];
    if bytes.is_null() {
        return String::new();
    }
    std::ffi::CStr::from_ptr(bytes)
        .to_string_lossy()
        .into_owned()
}

// `Class` を unused import 警告から守る
#[allow(dead_code)]
fn _ensure_imports(_: Class, _: BOOL) {}
