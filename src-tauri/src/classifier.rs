// Rust port of src/lib/receipt-classifier.ts.
//
// 完全ローカルで動く LaunchAgent / CLI scanner では Frontend を経由せずに
// 領収書スコアリングが必要なので、JS と等価のロジックを Rust 側にも置く。
// 仕様変更時は両方同期して更新すること。

#![cfg(target_os = "macos")]

use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum ClassifyState {
    Receipt,
    Candidate,
    NotReceipt,
}

impl ClassifyState {
    pub fn as_str(&self) -> &'static str {
        match self {
            ClassifyState::Receipt => "receipt",
            ClassifyState::Candidate => "candidate",
            ClassifyState::NotReceipt => "not_receipt",
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ClassifyResult {
    pub score: f32,
    pub state: ClassifyState,
}

const POSITIVE_JA: &[(&str, f32)] = &[
    ("領収書", 0.4),
    ("レシート", 0.4),
    ("お買い上げ", 0.25),
    ("お買上げ", 0.25),
    ("合計", 0.15),
    ("小計", 0.15),
    ("税込", 0.15),
    ("税抜", 0.10),
    ("消費税", 0.15),
    ("内税", 0.10),
    ("外税", 0.10),
    ("お預り", 0.10),
    ("お釣り", 0.10),
    ("釣銭", 0.10),
    ("ご来店", 0.10),
    ("ありがとう", 0.05),
    ("登録番号", 0.20),
    ("店", 0.05),
    ("様", 0.05),
];

const POSITIVE_EN: &[(&str, f32)] = &[
    ("receipt", 0.35),
    ("thank you", 0.15),
    ("total", 0.20),
    ("subtotal", 0.15),
    ("tax", 0.10),
    ("vat", 0.10),
    ("change", 0.05),
    ("cash", 0.05),
    ("card", 0.05),
    ("invoice", 0.20),
];

const NEGATIVE: &[(&str, f32)] = &[
    ("スクリーンショット", -0.30),
    ("screenshot", -0.30),
    ("instagram", -0.30),
    ("twitter", -0.30),
    ("facebook", -0.20),
    ("メッセージ", -0.10),
    ("selfie", -0.40),
    ("自撮り", -0.40),
];

fn invoice_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"T\d{13}").unwrap())
}
fn amount_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[¥￥]\s*\d{1,3}(,\d{3})*|\d{1,3}(,\d{3})*\s*円").unwrap())
}
fn date_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"\d{4}[-/年]\s?\d{1,2}[-/月]\s?\d{1,2}|令和\s?\d+年\s?\d{1,2}月\s?\d{1,2}日",
        )
        .unwrap()
    })
}
fn time_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\d{1,2}:\d{2}|\d{1,2}時\d{1,2}分").unwrap())
}

pub fn classify(text: &str) -> ClassifyResult {
    if text.trim().is_empty() {
        return ClassifyResult {
            score: 0.0,
            state: ClassifyState::NotReceipt,
        };
    }

    let lower = text.to_lowercase();
    let mut score: f32 = 0.0;

    for (kw, w) in POSITIVE_JA {
        if text.contains(kw) {
            score += w;
        }
    }
    for (kw, w) in POSITIVE_EN {
        if lower.contains(kw) {
            score += w;
        }
    }
    for (kw, w) in NEGATIVE {
        if lower.contains(kw) {
            score += w;
        }
    }

    let amounts = amount_re().find_iter(text).count();
    if amounts >= 2 {
        score += 0.25;
    } else if amounts == 1 {
        score += 0.10;
    }

    if date_re().is_match(text) {
        score += 0.10;
    }
    if time_re().is_match(text) {
        score += 0.05;
    }
    if invoice_re().is_match(text) {
        score += 0.30;
    }

    let len = text.chars().count();
    if len < 20 {
        score -= 0.20;
    } else if len > 2000 {
        score -= 0.20;
    }

    let score = score.clamp(0.0, 1.0);
    let state = if score >= 0.6 {
        ClassifyState::Receipt
    } else if score >= 0.3 {
        ClassifyState::Candidate
    } else {
        ClassifyState::NotReceipt
    };
    ClassifyResult { score, state }
}
