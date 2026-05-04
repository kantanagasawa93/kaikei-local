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
//   - HEIC: CIImage が macOS 11+ ネイティブで HEIC をサポートするため、
//     iPhone 純正カメラの HEIC ファイルもそのまま処理できる
//     (`imageWithContentsOfURL:` が ImageIO 経由で自動デコード)。
//   - PNG / JPEG / HEIC 全部同経路。
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

/// 認識精度: VNRequestTextRecognitionLevel
/// 0 = Accurate (デフォルト, 高精度・遅い)
/// 1 = Fast (低精度・速い、領収書には使えない)
/// 領収書は Accurate を使う。
const VN_TEXT_RECOGNITION_LEVEL_ACCURATE: i64 = 0;

/// 1 ページの認識結果。lines は左→右、上→下の順。
#[derive(serde::Serialize, Debug, Clone, Default)]
pub struct VisionOcrResult {
    pub lines: Vec<String>,
    pub joined: String,
    pub language: String,
    /// Round 11 ㉦: customWords の各語がいくつヒットしたか (語: 出現回数)。
    /// 空辞書 (custom_words=[]) や OCR 結果が空の時は空 map。
    /// "ヒット" は joined 文字列内の case-sensitive 部分一致 (vendor 名は
    /// 漢字主体なので case 区別は実害なし)。
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub custom_word_hits: std::collections::HashMap<String, u32>,
}

pub fn recognize_text<P: AsRef<Path>>(path: P) -> Result<VisionOcrResult, String> {
    recognize_text_with_words(path, &[])
}

/// Round 13 ㉲ both-pass: 日本語 only と 英語 only で 2 回 OCR して結果を結合。
///
/// 既存 recognize_text は `recognitionLanguages = ["ja-JP", "en-US"]` を一度に
/// 渡しているが、Apple の OCR は最初の言語にバイアスされ、英字メニューが
/// ひらがなに誤認されることがある (例: "Latte" → "ラテ" になる)。
///
/// both-pass は、ja-only パスと en-only パスの 2 回 OCR を実行し、
/// 重複しない行を全て連結する。順序より精度を優先する用途 (高解像度の
/// メニュー領収書など) に向く。custom_word_hits は両パスの合算。
///
/// 注意: OCR が 2 回走るので約 2 倍の時間。日常スキャンでは off が無難。
pub fn recognize_text_two_pass<P: AsRef<Path>>(
    path: P,
    custom_words: &[String],
) -> Result<VisionOcrResult, String> {
    let path = path.as_ref();
    if !path.exists() {
        return Err(format!("file not found: {}", path.display()));
    }

    let ja = recognize_text_single_lang(path, custom_words, "ja-JP")?;
    let en = recognize_text_single_lang(path, custom_words, "en-US")?;

    // 行を結合 (重複除去): ja を主、en で「ja に無い行」だけ末尾に足す
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut merged: Vec<String> = Vec::with_capacity(ja.lines.len() + en.lines.len());
    for line in ja.lines.iter().chain(en.lines.iter()) {
        if line.is_empty() {
            continue;
        }
        if seen.insert(line.clone()) {
            merged.push(line.clone());
        }
    }

    // ヒット数は両パスの合算
    let mut hits: std::collections::HashMap<String, u32> =
        std::collections::HashMap::with_capacity(ja.custom_word_hits.len());
    for (k, v) in ja.custom_word_hits.iter().chain(en.custom_word_hits.iter()) {
        *hits.entry(k.clone()).or_insert(0) += *v;
    }

    let joined = merged.join("\n");
    Ok(VisionOcrResult {
        language: detect_language(&joined),
        joined,
        lines: merged,
        custom_word_hits: hits,
    })
}

/// 単一言語で OCR するヘルパ (recognize_text_with_words の派生)。
/// Round 15 ㉺ で pub に格上げ — lib.rs の Tauri command から ja-only / en-only
/// モードを直接呼べるようにする。
pub fn recognize_text_single_lang<P: AsRef<Path>>(
    path: P,
    custom_words: &[String],
    lang: &str,
) -> Result<VisionOcrResult, String> {
    // recognize_text_with_words のロジックを reuse したいが、recognitionLanguages を
    // 引数化するのは大改造になるので、専用 wrapper を別途用意。
    // 簡略化のため two_pass モードだけは追加実装で複製。実装の重複は許容範囲。
    let path = path.as_ref();
    if !path.exists() {
        return Err(format!("file not found: {}", path.display()));
    }
    let path_str = path.to_string_lossy().to_string();
    unsafe {
        let path_ns: id = NSString::alloc(nil).init_str(&path_str);
        let url: id = msg_send![class!(NSURL), fileURLWithPath: path_ns];
        if url == nil {
            return Err("invalid file URL".into());
        }
        let source: id = msg_send![class!(CIImage), imageWithContentsOfURL: url];
        if source == nil {
            return Err("failed to load CIImage".into());
        }
        let handler: id = {
            let alloc: id = msg_send![class!(VNImageRequestHandler), alloc];
            let opts: id = msg_send![class!(NSDictionary), dictionary];
            msg_send![alloc, initWithCIImage: source options: opts]
        };

        use block::ConcreteBlock;
        let result: Arc<(Mutex<Option<Result<Vec<String>, String>>>, std::sync::Condvar)> =
            Arc::new((Mutex::new(None), std::sync::Condvar::new()));
        let result_clone = result.clone();
        let completion = ConcreteBlock::new(move |req: id, error: id| {
            let lines = if error != nil {
                let desc: id = unsafe { msg_send![error, localizedDescription] };
                Err(unsafe { nsstring_to_rust(desc) })
            } else {
                let observations: id = msg_send![req, results];
                if observations == nil {
                    Ok(Vec::<String>::new())
                } else {
                    let count: u64 = msg_send![observations, count];
                    let mut out = Vec::with_capacity(count as usize);
                    for i in 0..count {
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
                    Ok(out)
                }
            };
            let (lock, cvar) = &*result_clone;
            let mut g = lock.lock().unwrap();
            *g = Some(lines);
            cvar.notify_all();
        });
        let completion = completion.copy();

        let request: id = {
            let alloc: id = msg_send![class!(VNRecognizeTextRequest), alloc];
            msg_send![alloc, initWithCompletionHandler: &*completion]
        };
        let _: () = msg_send![request, setRecognitionLevel: VN_TEXT_RECOGNITION_LEVEL_ACCURATE];
        let _: () = msg_send![request, setUsesLanguageCorrection: YES];

        // 単一言語のみ
        let lang_ns: id = NSString::alloc(nil).init_str(lang);
        let langs: id = msg_send![class!(NSArray), arrayWithObject: lang_ns];
        let _: () = msg_send![request, setRecognitionLanguages: langs];

        // customWords (recognize_text_with_words と同じ)
        if !custom_words.is_empty() {
            let mut ns_words: Vec<id> = Vec::with_capacity(custom_words.len());
            for w in custom_words {
                if !w.is_empty() {
                    ns_words.push(NSString::alloc(nil).init_str(w));
                }
            }
            if !ns_words.is_empty() {
                let words_array: id = msg_send![class!(NSArray),
                    arrayWithObjects: ns_words.as_ptr()
                    count: ns_words.len() as u64];
                let _: () = msg_send![request, setCustomWords: words_array];
            }
        }

        let requests_array: [id; 1] = [request];
        let requests: id = msg_send![class!(NSArray),
            arrayWithObjects: requests_array.as_ptr()
            count: 1u64];
        let mut error_out: id = nil;
        let _ok: BOOL = msg_send![handler, performRequests: requests error: &mut error_out];
        if error_out != nil {
            let desc: id = msg_send![error_out, localizedDescription];
            return Err(nsstring_to_rust(desc));
        }
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
        // ヒット集計
        let mut hits: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
        if !custom_words.is_empty() && !joined.is_empty() {
            for w in custom_words {
                if w.is_empty() {
                    continue;
                }
                let mut count: u32 = 0;
                let mut start = 0usize;
                while let Some(pos) = joined[start..].find(w.as_str()) {
                    count += 1;
                    start += pos + w.len();
                    if count >= 100 { break; }
                }
                if count > 0 {
                    hits.insert(w.clone(), count);
                }
            }
        }
        Ok(VisionOcrResult {
            language: detect_language(&joined),
            joined,
            lines,
            custom_word_hits: hits,
        })
    }
}

/// Round 10 ㉡: VNRecognizeTextRequest.customWords にドメイン語彙
/// (取引先名・過去領収書の店名など) を渡して認識バイアスを掛ける。
///
/// Apple のドキュメント: customWords は "additional words to use during the
/// language correction process" — つまり Vision の internal LM の補助辞書。
/// 屋号 (例: "ホクシン", "メルセデスベンツ" 等の固有名詞) を渡すと、
/// 同じ綴りの普通名詞より優先的にこちらを採用する。
///
/// 空配列なら従来挙動。
pub fn recognize_text_with_words<P: AsRef<Path>>(
    path: P,
    custom_words: &[String],
) -> Result<VisionOcrResult, String> {
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
                let observations: id = msg_send![req, results];
                if observations == nil {
                    Ok(Vec::<String>::new())
                } else {
                    let count: u64 = msg_send![observations, count];
                    let mut out = Vec::with_capacity(count as usize);
                    for i in 0..count {
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

        // Round 10 ㉡: customWords (NSArray<NSString *>) で語彙バイアス
        // 空配列の時は API 呼出を skip (デフォルト挙動を維持)
        if !custom_words.is_empty() {
            let mut ns_words: Vec<id> = Vec::with_capacity(custom_words.len());
            for w in custom_words {
                if w.is_empty() {
                    continue;
                }
                ns_words.push(NSString::alloc(nil).init_str(w));
            }
            if !ns_words.is_empty() {
                let words_array: id = msg_send![class!(NSArray),
                    arrayWithObjects: ns_words.as_ptr()
                    count: ns_words.len() as u64];
                let _: () = msg_send![request, setCustomWords: words_array];
            }
        }

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
        // Round 11 ㉦: customWords ヒット数を集計
        let mut hits: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
        if !custom_words.is_empty() && !joined.is_empty() {
            for w in custom_words {
                if w.is_empty() {
                    continue;
                }
                let mut count: u32 = 0;
                let mut start = 0usize;
                while let Some(pos) = joined[start..].find(w.as_str()) {
                    count += 1;
                    start += pos + w.len();
                    if count >= 100 { break; } // 暴走防止
                }
                if count > 0 {
                    hits.insert(w.clone(), count);
                }
            }
        }
        Ok(VisionOcrResult {
            language: detect_language(&joined),
            joined,
            lines,
            custom_word_hits: hits,
        })
    }
}

/// 画像の中に「文書らしい長方形」が検出されるかを返す。
///
/// 実装は VNDetectDocumentSegmentationRequest (macOS 13+, 2022年)。これは
/// Apple Photos.app の領収書/書類検出に使われているのと同じ on-device モデル。
/// 紙片/レシート/書類/カードを高精度に検出する。
///
/// 戻り値: 何らかの document observation が返れば true。
/// - macOS 12 以下や class 未登録なら Ok(true) を返してフィルタを無効化
///   (キーワードベースの receipt-classifier に処理を委ねる安全策)
/// - 入力エラーは Err
pub fn has_document(file_path: &str) -> Result<bool, String> {
    use objc::runtime::Class;

    // macOS 13 未満では VNDetectDocumentSegmentationRequest が無いので
    // フィルタを掛けず通す (= true)
    let Some(req_class) = Class::get("VNDetectDocumentSegmentationRequest") else {
        return Ok(true);
    };

    if !std::path::Path::new(file_path).exists() {
        return Err(format!("file not found: {}", file_path));
    }

    unsafe {
        let path_ns: id = NSString::alloc(nil).init_str(file_path);
        let url: id = msg_send![class!(NSURL), fileURLWithPath: path_ns];
        if url == nil {
            return Err("invalid file URL".into());
        }
        let image: id = msg_send![class!(CIImage), imageWithContentsOfURL: url];
        if image == nil {
            return Err("CIImage load failed".into());
        }

        // VNImageRequestHandler を CIImage で初期化
        let handler: id = {
            let alloc: id = msg_send![class!(VNImageRequestHandler), alloc];
            let opts: id = msg_send![class!(NSDictionary), dictionary];
            msg_send![alloc, initWithCIImage: image options: opts]
        };

        // 結果受け取り用の同期化された箱
        use block::ConcreteBlock;
        let observed: std::sync::Arc<std::sync::Mutex<Option<bool>>> =
            std::sync::Arc::new(std::sync::Mutex::new(None));
        let observed_clone = observed.clone();

        let completion = ConcreteBlock::new(move |req: id, _err: id| {
            let results: id = unsafe { msg_send![req, results] };
            let count: u64 = if results == nil {
                0
            } else {
                unsafe { msg_send![results, count] }
            };
            // 1 件でも長方形が検出されれば文書あり
            *observed_clone.lock().unwrap() = Some(count > 0);
        });
        let completion = completion.copy();

        let request: id = {
            let alloc: id = msg_send![req_class, alloc];
            msg_send![alloc, initWithCompletionHandler: &*completion]
        };

        let requests_array: [id; 1] = [request];
        let requests: id = msg_send![class!(NSArray),
            arrayWithObjects: requests_array.as_ptr()
            count: 1u64];

        let mut error_out: id = nil;
        let _ok: BOOL = msg_send![handler,
            performRequests: requests
            error: &mut error_out];
        if error_out != nil {
            // 失敗時は安全側 (true: フィルタ通す) にする
            return Ok(true);
        }
        // performRequests は同期実行なので、ここに来る時点で完了している
        let v = observed.lock().unwrap().unwrap_or(true);
        Ok(v)
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
