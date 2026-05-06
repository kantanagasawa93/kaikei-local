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
use std::os::raw::c_void;
use objc::runtime::Class;
use objc::{class, msg_send, sel, sel_impl};

#[link(name = "Photos", kind = "framework")]
extern "C" {}

#[link(name = "CoreImage", kind = "framework")]
extern "C" {}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGColorSpaceCreateDeviceRGB() -> id;
}

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

/// PHAssetMediaSubtype フラグ (ビット OR 値)
/// 領収書はこれらの subtype では撮らないので、事前除外して効率化する。
const PH_SUBTYPE_PHOTO_PANORAMA: u64 = 1 << 0;
const PH_SUBTYPE_PHOTO_HDR: u64 = 1 << 1;
const PH_SUBTYPE_PHOTO_SCREENSHOT: u64 = 1 << 2;
#[allow(dead_code)]
const PH_SUBTYPE_PHOTO_LIVE: u64 = 1 << 3;
const PH_SUBTYPE_PHOTO_DEPTH_EFFECT: u64 = 1 << 4;
/// 「領収書ではあり得ない」subtype のビット和
const PH_SUBTYPE_NON_RECEIPT_MASK: u64 =
    PH_SUBTYPE_PHOTO_SCREENSHOT
        | PH_SUBTYPE_PHOTO_PANORAMA
        | PH_SUBTYPE_PHOTO_HDR
        | PH_SUBTYPE_PHOTO_DEPTH_EFFECT;

/// PHImageRequestOptionsDeliveryMode: 1 = HighQualityFormat
const PH_DELIVERY_MODE_HIGH_QUALITY: i64 = 1;
/// PHImageRequestOptionsDeliveryMode: 2 = FastFormat
/// (iCloud 上の写真の場合、低画質サムネ相当を返す → 帯域 1/20 程度)
/// 注: synchronous=YES だとこのフラグは無視され HighQuality 扱いになるので、
/// サムネ取得時は synchronous=NO で使う必要がある。
const PH_DELIVERY_MODE_FAST_FORMAT: i64 = 2;

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
    /// Round 21 ⓐ: PHAsset.isFavorite — お気に入り写真は領収書の可能性が高い
    /// (ユーザが意図的に保存した) ので classifier のスコアブースト用シグナルに使う。
    pub is_favorite: bool,
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

        // PHImageRequestOptions (synchronous + iCloud download OK) — Stage 2 用 (フル DL)
        let req_opts: id = {
            let alloc: id = msg_send![class!(PHImageRequestOptions), alloc];
            msg_send![alloc, init]
        };
        let _: () = msg_send![req_opts, setSynchronous: YES];
        let _: () = msg_send![req_opts, setNetworkAccessAllowed: YES];
        let _: () = msg_send![req_opts, setVersion: PH_VERSION_CURRENT];
        let _: () = msg_send![req_opts, setDeliveryMode: PH_DELIVERY_MODE_HIGH_QUALITY];

        // Stage 1.5 用 — 「サムネ画質」で先に文書判定し、通った物だけフル DL する。
        // synchronous=NO + DeliveryMode=FastFormat で iCloud 帯域を抑える。
        // (synchronous=YES だと FastFormat は無視されるので必ず NO のまま)
        let fast_opts: id = {
            let alloc: id = msg_send![class!(PHImageRequestOptions), alloc];
            msg_send![alloc, init]
        };
        let _: () = msg_send![fast_opts, setNetworkAccessAllowed: YES];
        let _: () = msg_send![fast_opts, setVersion: PH_VERSION_CURRENT];
        let _: () = msg_send![fast_opts, setDeliveryMode: PH_DELIVERY_MODE_FAST_FORMAT];

        let manager: id = msg_send![class!(PHImageManager), defaultManager];

        for i in 0..count {
            let asset: id = msg_send![assets, objectAtIndex: i];
            if asset == nil {
                continue;
            }

            // ── Stage 0: PHAsset.isHidden で「ユーザが隠した写真」を除外 ──
            // Apple Photos の "Hidden" album に入れた写真は明確にプライベート扱い。
            // 領収書としてもアプリで見えない方が良いし、誤検出を減らす効果も大きい。
            let is_hidden: BOOL = msg_send![asset, isHidden];
            if is_hidden {
                continue;
            }

            // ── Stage 1: メタデータだけで除外できるものを早期 skip ──
            // スクリーンショット / パノラマ / HDR / Depth Effect 等は
            // ほぼ確実に領収書ではない。subtype フラグで弾く。
            let subtypes: u64 = msg_send![asset, mediaSubtypes];
            if (subtypes & PH_SUBTYPE_NON_RECEIPT_MASK) != 0 {
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
            // Round 21 ⓐ: isFavorite は BOOL (cocoa 0.26 では Rust の bool 型エイリアス)
            let is_favorite: BOOL = msg_send![asset, isFavorite];

            // ── Stage 1.2: アスペクト比 + 最小画素数フィルタ ──
            // 領収書の現実的な範囲:
            //   - 縦横比は概ね 1:1 〜 1:4 (短い側 vs 長い側)
            //   - 短辺は 600px 以上 (これ未満だとアイコン・サムネ)
            //   - 「お気に入り」(is_favorite=true) はユーザが意図的に保存した可能性が
            //     高いので、画素数 / アスペクト比による事前 skip を免除する
            //
            // これで family snap の風景写真 (16:9 の 4032x3024 等) は Stage 1.5 まで
            // 行ってサムネ DL → 文書検出するが、「自撮り写真」「背景画像」などの
            // 縦横比が極端なものはここで弾ける。
            if !is_favorite {
                if width < 600 || height < 600 {
                    continue;
                }
                let (long_side, short_side) = if width >= height {
                    (width as f64, height as f64)
                } else {
                    (height as f64, width as f64)
                };
                let ratio = long_side / short_side;
                // 領収書はせいぜい 1:5 (細長いレシート) まで。それ以上は写真パノラマ等
                if ratio > 5.0 {
                    continue;
                }
            }

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
                    is_favorite,
                });
                continue;
            }

            // ── Stage 1.5: サムネで先に文書判定 (iCloud 帯域削減) ──
            // FastFormat (~数百 KB) でサムネを取って has_document で文書らしさを判定。
            // 通らなかった物は フル DL (~5 MB/枚) を完全 skip — 1000 枚規模で帯域 1/20。
            // 注: 偽陰性 (本当は領収書なのにサムネで弾かれる) を避けるため、サムネ取得
            //     や判定が失敗した時は安全側で「pass」扱いにし、Stage 2 の has_document
            //     で再判定する。
            let thumb_passed = {
                let thumb_path = std::env::temp_dir()
                    .join(format!("kaikei-thumb-{}.jpg", safe_name));
                match request_image_data(manager, asset, fast_opts) {
                    Ok(b) => {
                        let b = ensure_jpeg(b);
                        if std::fs::write(&thumb_path, &b).is_err() {
                            true // 一時書込失敗 → 安全側で full DL に進む
                        } else {
                            let r = crate::vision::has_document(
                                &thumb_path.to_string_lossy(),
                            )
                            .unwrap_or(true);
                            let _ = std::fs::remove_file(&thumb_path);
                            r
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "thumb fetch failed for {}: {} (full DL に fallback)",
                            asset_id, e
                        );
                        true
                    }
                }
            };
            if !thumb_passed {
                // サムネ判定で文書検出されず — 帯域節約のため完全 skip
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

            // iPhone の純正カメラは HEIC で保存するので、ここで JPEG に正規化する。
            // (ファイル名は .jpg のままにしておく)
            let bytes = ensure_jpeg(bytes);

            if let Err(e) = std::fs::write(&file_path, &bytes) {
                log::warn!("save photo failed: {}", e);
                continue;
            }

            // ── Stage 2: フル解像度で再度 VNDetectDocumentSegmentationRequest ──
            // サムネ判定は解像度が低くて偽陽性が混じる可能性がある (壁掛け絵・PC 画面
            // のラベル等)。フル DL 後に同じモデルでもう一度判定し、ここで弾けるなら
            // ファイルごと削除する safety net。
            let path_str = file_path.to_string_lossy().to_string();
            match crate::vision::has_document(&path_str) {
                Ok(false) => {
                    // 領収書らしくない: 保存したファイルを削除して skip
                    let _ = std::fs::remove_file(&file_path);
                    continue;
                }
                Ok(true) => { /* 領収書候補 — そのまま保持 */ }
                Err(e) => {
                    // 文書検出が失敗 (= macOS が古い等) の時は安全側で残す
                    log::warn!("document detect failed for {}: {} (keeping anyway)", asset_id, e);
                }
            }

            out.push(ScannedPhoto {
                asset_id,
                taken_at: taken_at as i64,
                width: width as i64,
                height: height as i64,
                file_path: file_path.to_string_lossy().to_string(),
                is_favorite,
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

/// HEIC / HEIF / その他 ImageIO が読める形式を JPEG にエンコードし直す。
/// 既に JPEG / PNG / GIF / WebP の場合はそのまま返す (再エンコード回避)。
/// 変換に失敗した場合も入力をそのまま返す (= ファイル名は .jpg だが
/// 中身が HEIC のまま、ということが起こり得る → resolveLocalImageUrl 側で
/// MIME 判定して Blob URL 化されるので OS レベルでは表示される)。
fn ensure_jpeg(bytes: Vec<u8>) -> Vec<u8> {
    // すでに JPEG (FF D8) なら何もしない
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
        return bytes;
    }
    // PNG / WebP / GIF はそのまま (Web も読める)
    if bytes.len() >= 8 {
        let head = &bytes[0..8];
        if head[0] == 0x89 && head[1] == 0x50 && head[2] == 0x4e && head[3] == 0x47 {
            return bytes;
        }
        if head[0] == 0x47 && head[1] == 0x49 && head[2] == 0x46 {
            return bytes;
        }
        // RIFF????WEBP
        if bytes.len() >= 12
            && head[0] == 0x52
            && head[1] == 0x49
            && head[2] == 0x46
            && head[3] == 0x46
            && bytes[8] == 0x57
        {
            return bytes;
        }
    }

    // ここまで来たら HEIC / HEIF / その他 → CIImage 経由で JPEG 化
    match unsafe { convert_to_jpeg(&bytes) } {
        Some(jpeg) => jpeg,
        None => bytes,
    }
}

/// HEIC バイト列を CIContext.JPEGRepresentationOfImage で JPEG に変換。
unsafe fn convert_to_jpeg(input: &[u8]) -> Option<Vec<u8>> {
    let nsdata: id = msg_send![class!(NSData),
        dataWithBytes: input.as_ptr() as *const c_void
        length: input.len() as u64];
    if nsdata == nil {
        return None;
    }
    let ci_image: id = msg_send![class!(CIImage), imageWithData: nsdata];
    if ci_image == nil {
        return None;
    }

    let ctx: id = msg_send![class!(CIContext), context];
    if ctx == nil {
        return None;
    }

    // colorSpace: 画像由来 → 取れなければ DeviceRGB に fallback
    let cs_from_image: id = msg_send![ci_image, colorSpace];
    let cs: id = if cs_from_image == nil {
        CGColorSpaceCreateDeviceRGB()
    } else {
        cs_from_image
    };

    let opts: id = msg_send![class!(NSDictionary), dictionary];
    let jpeg: id = msg_send![ctx,
        JPEGRepresentationOfImage: ci_image
        colorSpace: cs
        options: opts];
    if jpeg == nil {
        return None;
    }
    let len: u64 = msg_send![jpeg, length];
    let ptr: *const u8 = msg_send![jpeg, bytes];
    if ptr.is_null() || len == 0 {
        return None;
    }
    Some(std::slice::from_raw_parts(ptr, len as usize).to_vec())
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
