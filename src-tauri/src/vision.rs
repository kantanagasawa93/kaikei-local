// macOS Vision.framework wrapper for receipt detection.
//
// 役割:
//   - 与えられた JPEG/PNG ファイルパスから、Vision の VNRecognizeTextRequest
//     を呼んでテキストを取得 (完全ローカル、ネット送信なし)
//   - Apple のテキスト認識は日本語 (`ja-JP`) と英語 (`en-US`) を同時指定可能
//   - 認識結果は行単位の Vec<String> として返す
//
// 注意:
//   - VNRecognizeTextRequest は macOS 10.15+ で利用可能。
//   - 日本語認識は macOS 13+ でサポート (recognitionLanguages に "ja-JP")。
//     古い OS では英語のみで動作するが、領収書は数字や記号が多いので
//     英語フォールバックでも金額・日付などはある程度拾える。
//   - フレームワーク: Vision + CoreImage + ImageIO。
//
// Phase 2 ではここまで。受信箱の各写真に対して認識テキストを保存し、
// receipt_classifier がスコアを付ける。

#![cfg(target_os = "macos")]
#![allow(unexpected_cfgs)]

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cocoa::base::{id, nil, BOOL, YES};
use cocoa::foundation::{NSArray, NSString};
use objc::runtime::Class;
use objc::{class, msg_send, sel, sel_impl};

#[link(name = "Vision", kind = "framework")]
extern "C" {}

#[link(name = "CoreImage", kind = "framework")]
extern "C" {}

/// 認識精度: 0=fast, 1=accurate. 領収書は accurate にする。
const VN_TEXT_RECOGNITION_LEVEL_ACCURATE: i64 = 1;

/// 1 ページの認識結果。lines は左→右、上→下の順。
#[derive(serde::Serialize, Debug, Clone, Default)]
pub struct VisionOcrResult {
    pub lines: Vec<String>,
    pub joined: String,
    pub language: String,
}

pub fn recognize_text<P: AsRef<Path>>(path: P) -> Result<VisionOcrResult, String> {
    let path = path.as_ref();
    if !path.exists() {
        return Err(format!("file not found: {}", path.display()));
    }
    let path_str = path.to_string_lossy().to_string();

    unsafe {
        // file:// URL を作る
        let path_ns: id = NSString::alloc(nil).init_str(&path_str);
        let url: id = msg_send![class!(NSURL), fileURLWithPath: path_ns];
        if url == nil {
            return Err("invalid file URL".into());
        }

        // CGImageSource → CGImage
        let cf_url: id = url; // NSURL は toll-free bridge で CFURLRef 互換
        let source: id = msg_send![class!(CIImage), imageWithContentsOfURL: cf_url];
        if source == nil {
            return Err("failed to load CIImage".into());
        }

        // VNImageRequestHandler を CIImage で初期化
        let handler: id = {
            let alloc: id = msg_send![class!(VNImageRequestHandler), alloc];
            let opts: id = msg_send![class!(NSDictionary), dictionary];
            msg_send![alloc, initWithCIImage: source options: opts]
        };

        // VNRecognizeTextRequest を作る (block で結果を受け取る)
        use block::ConcreteBlock;
        let result: Arc<(Mutex<Option<Result<Vec<String>, String>>>, std::sync::Condvar)> =
            Arc::new((Mutex::new(None), std::sync::Condvar::new()));
        let result_clone = result.clone();

        let completion = ConcreteBlock::new(move |req: id, error: id| {
            let lines = if error != nil {
                let desc: id = unsafe { msg_send![error, localizedDescription] };
                Err(unsafe { nsstring_to_rust(desc) })
            } else {
                // [VNRecognizedTextObservation] -> firstCandidate -> string
                let observations: id = unsafe { msg_send![req, results] };
                if observations == nil {
                    Ok(Vec::<String>::new())
                } else {
                    let count: u64 = unsafe { msg_send![observations, count] };
                    let mut out = Vec::with_capacity(count as usize);
                    for i in 0..count {
                        unsafe {
                            let obs: id = msg_send![observations, objectAtIndex: i];
                            let candidates: id = msg_send![obs, topCandidates: 1u64];
                            if candidates == nil {
                                continue;
                            }
                            let c_count: u64 = msg_send![candidates, count];
                            if c_count == 0 {
                                continue;
                            }
                            let first: id = msg_send![candidates, objectAtIndex: 0u64];
                            let s: id = msg_send![first, string];
                            let line = nsstring_to_rust(s);
                            if !line.is_empty() {
                                out.push(line);
                            }
                        }
                    }
                    Ok(out)
                }
            };
            let (lock, cvar) = &*result_clone;
            let mut g = lock.lock().unwrap();
            *g = Some(lines);
            cvar.notify_all();
        });
        let completion = completion.copy();

        // VNRecognizeTextRequest alloc/init
        let request: id = {
            let alloc: id = msg_send![class!(VNRecognizeTextRequest), alloc];
            msg_send![alloc, initWithCompletionHandler: &*completion]
        };

        // recognitionLevel = accurate
        let _: () = msg_send![request, setRecognitionLevel: VN_TEXT_RECOGNITION_LEVEL_ACCURATE];
        // usesLanguageCorrection = true
        let _: () = msg_send![request, setUsesLanguageCorrection: YES];

        // recognitionLanguages = ["ja-JP", "en-US"]
        let lang_ja: id = NSString::alloc(nil).init_str("ja-JP");
        let lang_en: id = NSString::alloc(nil).init_str("en-US");
        let langs_array: [id; 2] = [lang_ja, lang_en];
        let langs: id = msg_send![class!(NSArray),
            arrayWithObjects: langs_array.as_ptr()
            count: 2u64];
        let _: () = msg_send![request, setRecognitionLanguages: langs];

        // perform requests
        let requests_array: [id; 1] = [request];
        let requests: id = msg_send![class!(NSArray),
            arrayWithObjects: requests_array.as_ptr()
            count: 1u64];

        let mut error_out: id = nil;
        let _ok: BOOL = msg_send![handler,
            performRequests: requests
            error: &mut error_out];
        if error_out != nil {
            let desc: id = msg_send![error_out, localizedDescription];
            return Err(nsstring_to_rust(desc));
        }

        // wait for completion
        let (lock, cvar) = &*result;
        let mut g = lock.lock().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        while g.is_none() {
            let now = std::time::Instant::now();
            if now >= deadline {
                return Err("vision OCR timeout".into());
            }
            let (ng, _) = cvar.wait_timeout(g, deadline - now).unwrap();
            g = ng;
        }
        let lines = g.take().unwrap_or_else(|| Err("no result".into()))?;
        let joined = lines.join("\n");
        Ok(VisionOcrResult {
            language: detect_language(&joined),
            joined,
            lines,
        })
    }
}

/// 文字列から日本語/英語を雑判定 (UI 表示用)
fn detect_language(s: &str) -> String {
    let mut has_kana_kanji = false;
    for ch in s.chars() {
        let c = ch as u32;
        if (0x3040..=0x309F).contains(&c)        // hiragana
            || (0x30A0..=0x30FF).contains(&c)    // katakana
            || (0x4E00..=0x9FFF).contains(&c)
        {
            has_kana_kanji = true;
            break;
        }
    }
    if has_kana_kanji {
        "ja".into()
    } else {
        "en".into()
    }
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

// 未使用警告抑制
#[allow(dead_code)]
fn _ensure_imports(_: Class) {}
