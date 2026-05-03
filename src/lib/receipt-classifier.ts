/**
 * 領収書スコアリング (Phase 2)
 *
 * Vision OCR で得たテキストから「これは領収書か?」を 0.0〜1.0 で評価する。
 * 完全ローカル、ネット送信なし。閾値超のものを receipt 状態にする。
 *
 * 設計:
 *   - キーワード辞書 (日英) で +score
 *   - 数値・日付パターンで +score
 *   - 自撮り / スクリーンショット / SNS 系のキーワードで -score
 *   - 縦横比 (受信箱には必須でないが Phase 2.x で利用予定)
 *
 * 閾値:
 *   - >= 0.6: receipt
 *   - 0.3〜0.6: candidate (人間判断)
 *   - < 0.3: not_receipt
 */

interface Signal {
  score: number;
  reason: string;
}

const POSITIVE_KEYWORDS_JA = [
  ["領収書", 0.4],
  ["レシート", 0.4],
  ["お買い上げ", 0.25],
  ["お買上げ", 0.25],
  ["合計", 0.15],
  ["小計", 0.15],
  ["税込", 0.15],
  ["税抜", 0.1],
  ["消費税", 0.15],
  ["内税", 0.1],
  ["外税", 0.1],
  ["お預り", 0.1],
  ["お釣り", 0.1],
  ["釣銭", 0.1],
  ["ご来店", 0.1],
  ["ありがとう", 0.05],
  ["登録番号", 0.2], // インボイス登録番号
  ["T", 0.0], // T+13桁の登録番号は別ロジックで
  ["店", 0.05],
  ["様", 0.05],
] as const;

const POSITIVE_KEYWORDS_EN = [
  ["receipt", 0.35],
  ["thank you", 0.15],
  ["total", 0.2],
  ["subtotal", 0.15],
  ["tax", 0.1],
  ["vat", 0.1],
  ["change", 0.05],
  ["cash", 0.05],
  ["card", 0.05],
  ["invoice", 0.2],
] as const;

const NEGATIVE_KEYWORDS = [
  ["スクリーンショット", -0.3],
  ["screenshot", -0.3],
  ["instagram", -0.3],
  ["twitter", -0.3],
  ["facebook", -0.2],
  ["line", -0.1],
  ["メッセージ", -0.1],
  ["selfie", -0.4],
  ["自撮り", -0.4],
] as const;

/** インボイス登録番号: T + 13桁 */
const INVOICE_NUM_RE = /T\d{13}/;

/** 金額っぽいパターン: ¥1,234 or ￥1,234 or 1,234円 or 1234 円 */
const AMOUNT_RE = /[¥￥]\s*\d{1,3}(,\d{3})*|\d{1,3}(,\d{3})*\s*円/g;

/** 日付っぽいパターン: 2025/01/02, 2025-01-02, 2025年1月2日, 令和7年1月2日 */
const DATE_RE = /\d{4}[-\/年]\s?\d{1,2}[-\/月]\s?\d{1,2}|令和\s?\d+年\s?\d{1,2}月\s?\d{1,2}日/;

/** 時刻っぽいパターン: 14:23, 14時23分 */
const TIME_RE = /\d{1,2}:\d{2}|\d{1,2}時\d{1,2}分/;

export interface ClassifyResult {
  score: number; // 0.0〜1.0 にクランプ済み
  state: "receipt" | "candidate" | "not_receipt";
  signals: Signal[];
}

/**
 * 「これが書かれていたら確実に領収書」と言い切れるキーワード。
 * Apple Photos.app の「領収書」キーワード検索もこのレベルの直接マッチで動く。
 * 1 つでもヒットしたら他のスコアを無視して即 receipt 判定する fast-path。
 */
const FORCE_RECEIPT_KEYWORDS = [
  "領収書",
  "レシート",
  "領収証",
  "受領書",
  "Receipt",
  "RECEIPT",
  "receipt",
];

export function classifyReceipt(text: string): ClassifyResult {
  if (!text || text.trim().length === 0) {
    // 空テキスト → 自動破棄せず candidate に残す (人間判断)
    return {
      score: 0,
      state: "candidate",
      signals: [{ score: 0, reason: "空テキスト (人間判断に委ねる)" }],
    };
  }

  // Fast-path: 直接キーワードがあれば確定
  for (const kw of FORCE_RECEIPT_KEYWORDS) {
    if (text.includes(kw)) {
      return {
        score: 1.0,
        state: "receipt",
        signals: [{ score: 1.0, reason: `direct match: "${kw}"` }],
      };
    }
  }

  const lower = text.toLowerCase();
  const signals: Signal[] = [];
  let score = 0;

  for (const [kw, w] of POSITIVE_KEYWORDS_JA) {
    if (text.includes(kw as string)) {
      score += w as number;
      signals.push({ score: w as number, reason: `+ "${kw}"` });
    }
  }
  for (const [kw, w] of POSITIVE_KEYWORDS_EN) {
    if (lower.includes(kw as string)) {
      score += w as number;
      signals.push({ score: w as number, reason: `+ "${kw}"` });
    }
  }
  for (const [kw, w] of NEGATIVE_KEYWORDS) {
    if (lower.includes(kw as string)) {
      score += w as number;
      signals.push({ score: w as number, reason: `- "${kw}"` });
    }
  }

  // 金額パターンが 2回以上見つかれば領収書濃厚
  const amounts = text.match(AMOUNT_RE) ?? [];
  if (amounts.length >= 2) {
    score += 0.25;
    signals.push({ score: 0.25, reason: `+ 金額パターン x${amounts.length}` });
  } else if (amounts.length === 1) {
    score += 0.1;
    signals.push({ score: 0.1, reason: "+ 金額パターン x1" });
  }

  // 日付があれば +
  if (DATE_RE.test(text)) {
    score += 0.1;
    signals.push({ score: 0.1, reason: "+ 日付パターン" });
  }
  // 時刻もあれば領収書らしさが増す (= レシートの会計時刻)
  if (TIME_RE.test(text)) {
    score += 0.05;
    signals.push({ score: 0.05, reason: "+ 時刻パターン" });
  }

  // インボイス登録番号があれば確実
  if (INVOICE_NUM_RE.test(text)) {
    score += 0.3;
    signals.push({ score: 0.3, reason: "+ インボイス登録番号 (T+13桁)" });
  }

  // 短すぎ / 長すぎは減点 (短文 = ステッカー / 長文 = 文書スクショ)
  const len = text.length;
  if (len < 20) {
    score -= 0.2;
    signals.push({ score: -0.2, reason: `- テキスト短すぎ (${len}文字)` });
  } else if (len > 2000) {
    score -= 0.2;
    signals.push({ score: -0.2, reason: `- テキスト長すぎ (${len}文字)` });
  }

  score = Math.max(0, Math.min(1, score));

  // 重要な方針変更:
  //   - 自動で "not_receipt" は付けない。Stage2 (文書検出) を通った時点で
  //     文書ではあるので、領収書である可能性をゼロにはしない。
  //   - 閾値も少し下げ (0.4) て、ユーザーが見える受信箱に並ぶようにする。
  //   - 確信を持てない物は candidate のまま並ばせ、人間が「違う」を押した
  //     時だけ not_receipt に入る (= 自動でデータが失われない)。
  let state: ClassifyResult["state"];
  if (score >= 0.4) state = "receipt";
  else state = "candidate";

  return { score, state, signals };
}

// ────────────────────────────────────────────────────────────
// 行単位分類 (Round 3 ⓔ OCR rich preview 用)
//
// 受信箱カードで OCR テキストを表示するときに、金額・日付・店名候補を
// 色分けするための行レベル分類器。ロジックは classifyReceipt の弱化版で、
// AI OCR には投げず純粋にローカルキーワード/正規表現で判定する。
// ────────────────────────────────────────────────────────────

export type LineKind =
  | "amount" // ¥1,234 / 1,234 円
  | "total" // 合計 / 小計 / total / subtotal を含む行
  | "date" // 2025/01/02 / 2025年1月2日 / 令和7年1月2日
  | "time" // 14:23 / 14時23分
  | "invoice" // T+13桁のインボイス登録番号
  | "vendor" // 店名/会社名候補 — 最初の有意行で他種別に該当しないもの
  | "other";

const TOTAL_KEYWORDS = ["合計", "小計", "計：", "計:", "total", "subtotal"];
const VENDOR_HINTS = ["店", "会社", "shop", "stand", "store", "corp", "inc"];

/**
 * OCR テキストを行ごとに種別分類する。順序は元のまま。
 *
 * ルール (上から順に評価し、最初にマッチした種別を採用):
 *   1. INVOICE_NUM_RE (T+13桁) → 'invoice'
 *   2. AMOUNT_RE がヒット かつ 行に "合計"/"小計"/"total" のいずれかを含む → 'total'
 *   3. AMOUNT_RE がヒット → 'amount'
 *   4. DATE_RE がヒット → 'date'
 *   5. TIME_RE がヒット → 'time'
 *   6. 店名ヒント語が含まれる、または最初の有意行 → 'vendor'
 *   7. それ以外 → 'other'
 */
export function classifyReceiptLines(text: string): { line: string; kind: LineKind }[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);

  const result: { line: string; kind: LineKind }[] = [];
  let vendorAssigned = false;

  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();
    if (!trimmed) {
      result.push({ line, kind: "other" });
      continue;
    }

    if (INVOICE_NUM_RE.test(trimmed)) {
      result.push({ line, kind: "invoice" });
      continue;
    }

    const lower = trimmed.toLowerCase();
    const hasAmount = AMOUNT_RE.test(trimmed);
    // AMOUNT_RE は g フラグで lastIndex が動くので reset
    AMOUNT_RE.lastIndex = 0;
    const isTotalKeyword = TOTAL_KEYWORDS.some((k) =>
      k === k.toLowerCase() ? lower.includes(k) : trimmed.includes(k)
    );
    if (hasAmount && isTotalKeyword) {
      result.push({ line, kind: "total" });
      continue;
    }
    if (hasAmount) {
      result.push({ line, kind: "amount" });
      continue;
    }

    if (DATE_RE.test(trimmed)) {
      result.push({ line, kind: "date" });
      continue;
    }
    if (TIME_RE.test(trimmed)) {
      result.push({ line, kind: "time" });
      continue;
    }

    // 店名候補: ヒント語があるか、まだ vendor が割り当てられていない最初の有意行
    const hasVendorHint = VENDOR_HINTS.some((h) =>
      h === h.toLowerCase() ? lower.includes(h) : trimmed.includes(h)
    );
    if (hasVendorHint || !vendorAssigned) {
      result.push({ line, kind: "vendor" });
      vendorAssigned = true;
      continue;
    }

    result.push({ line, kind: "other" });
  }

  return result;
}

// ────────────────────────────────────────────────────────────
// Round 5 ㊇: receipts/new の pre-fill 用ヘルパ
//
// Vision OCR の生テキストから店名候補・金額・日付を抜いて、
// 領収書手動登録フォームの初期値を作る。AI OCR を回さなくても
// "そこそこ埋まっている" 状態を提供するのが目的。
// ────────────────────────────────────────────────────────────

export interface PrefillFromOcr {
  vendor_name: string | null;
  amount: number | null; // 数字のみ
  date: string | null; // YYYY-MM-DD
}

/**
 * OCR テキストから領収書フォームの初期値を抽出する。
 *
 * 規則:
 *   - vendor_name: 最初の kind='vendor' 行 (trim)
 *   - amount: 最初の kind='total' 行があればそこから、無ければ最後の
 *     kind='amount' 行から (最大の数値が「合計っぽい」ヒューリスティック)
 *   - date: 最初の kind='date' 行を ISO 形式に変換
 */
export function prefillFromOcr(text: string): PrefillFromOcr {
  const lines = classifyReceiptLines(text);

  const vendorLine = lines.find((l) => l.kind === "vendor");

  // total があれば優先、なければ最後の amount 行 (合計は通常 receipt の下にある)
  const totalLine = lines.find((l) => l.kind === "total");
  const amountLines = lines.filter((l) => l.kind === "amount");
  const amountSource = totalLine ?? amountLines[amountLines.length - 1];

  let amount: number | null = null;
  if (amountSource) {
    // ¥1,234 / 1,234 円 / 1234 から数字を全部抜き、最大値を採用
    const matches = amountSource.line.match(/[\d,]+/g) ?? [];
    const nums = matches
      .map((s) => parseInt(s.replace(/,/g, ""), 10))
      .filter((n) => !isNaN(n) && n > 0);
    if (nums.length > 0) {
      amount = Math.max(...nums);
    }
  }

  let date: string | null = null;
  const dateLine = lines.find((l) => l.kind === "date");
  if (dateLine) {
    // 2025/01/02 / 2025-01-02
    const slash = dateLine.line.match(/(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})/);
    if (slash) {
      const [, y, m, d] = slash;
      date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    } else {
      // 2025年1月2日
      const jp = dateLine.line.match(/(\d{4})年\s?(\d{1,2})月\s?(\d{1,2})/);
      if (jp) {
        const [, y, m, d] = jp;
        date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
      }
      // 令和7年1月2日 → 2025-01-02 (令和元年=2019)
      const reiwa = dateLine.line.match(/令和\s?(\d+)年\s?(\d{1,2})月\s?(\d{1,2})/);
      if (!date && reiwa) {
        const [, ry, m, d] = reiwa;
        const y = 2018 + parseInt(ry, 10);
        date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
      }
    }
  }

  return {
    vendor_name: vendorLine ? vendorLine.line.trim() : null,
    amount,
    date,
  };
}

// ────────────────────────────────────────────────────────────
// Round 7 ㊑ 自動破棄ルール (dismissed パターン学習)
//
// ユーザーが過去に「破棄」「違う」とマークした写真の OCR テキストを使って、
// 新しい candidate がそれらと十分似ていれば初期 state を 'dismissed' にする。
//
// 似ている = ジャッカード類似度 (キーワード集合の |A∩B| / |A∪B|) が
// 閾値以上 (デフォルト 0.5) という単純実装。本格的な ML はやらないが、
// 「Wi-Fi 案内」「機器ラベル」「メニュー写真」のような繰り返しの偽陽性が
// 受信箱に並ばなくなる効果が大きい。
// ────────────────────────────────────────────────────────────

/** OCR テキストから distinctive な短いキーワードを取り出す */
export function extractKeywordSet(text: string): Set<string> {
  if (!text) return new Set();
  const set = new Set<string>();
  // 日本語: 2 文字以上の漢字/カナ連続を拾う
  const jpRe = /[一-鿿぀-ゟ゠-ヿ]{2,}/g;
  for (const m of text.matchAll(jpRe)) {
    if (m[0].length >= 2 && m[0].length <= 12) set.add(m[0]);
  }
  // 英数字: 3 文字以上の英単語
  const enRe = /[A-Za-z][A-Za-z0-9]{2,}/g;
  for (const m of text.matchAll(enRe)) {
    set.add(m[0].toLowerCase());
  }
  return set;
}

/** ジャッカード類似度 (0.0〜1.0) */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const x of a) if (b.has(x)) intersect++;
  const union = a.size + b.size - intersect;
  if (union === 0) return 0;
  return intersect / union;
}

/**
 * 過去に dismissed / not_receipt にされた写真の OCR テキスト集合を渡し、
 * 新規 candidate のテキストがどれかと十分似ているか判定する。
 *
 * Round 8 ㊖ で「ホワイトリスト」を追加: classifyReceipt の score が 0.4
 * 以上 (= 領収書らしさが高い) の場合は問答無用で false を返す。
 * 過去の dismissed と表面上似ているだけで本当の領収書を弾く事故を防ぐ。
 *
 * @param newText 新しい OCR テキスト
 * @param pastTexts 過去の dismissed / not_receipt OCR テキスト一覧
 * @param threshold 0.0〜1.0 (既定 0.5)
 * @returns 似ていれば true (= 自動 dismissed にすべき)
 */
export function shouldAutoDismiss(
  newText: string | null | undefined,
  pastTexts: string[],
  threshold = 0.5,
): boolean {
  if (!newText || pastTexts.length === 0) return false;

  // Round 8 ㊖ ホワイトリスト: 「領収書らしさ」スコアが既に高い物は絶対に
  // 自動破棄しない。ユーザの過去 dismissed と部分一致していても、
  // FORCE_RECEIPT_KEYWORDS / インボイス番号 / 合計+金額パターン がある
  // 写真は本物の領収書の可能性が高い。
  const cls = classifyReceipt(newText);
  if (cls.score >= 0.4) return false;

  const newSet = extractKeywordSet(newText);
  if (newSet.size < 3) return false; // 短すぎるテキストは判定不能 (誤判定避ける)
  for (const past of pastTexts) {
    const pastSet = extractKeywordSet(past);
    if (pastSet.size < 3) continue;
    if (jaccardSimilarity(newSet, pastSet) >= threshold) {
      return true;
    }
  }
  return false;
}

/**
 * Round 8 ㊗: 自動破棄判定の透明性のため、なぜ dismiss されたかを返す。
 * shouldAutoDismiss が true 判定を返した時の「最も類似度が高かった過去テキスト」
 * のキーワード集合 (上位 5 個) と類似度を一緒に返す。UI で「○○ と似てたので
 * 自動破棄しました」と説明できるようにする。
 */
export interface AutoDismissReason {
  matched: boolean;
  similarity: number; // 0.0-1.0
  matchedKeywords: string[]; // 共通キーワード上位 5
  matchedPastSnippet: string; // どの past text と似たか (先頭 60 文字)
}

export function explainAutoDismiss(
  newText: string | null | undefined,
  pastTexts: string[],
  threshold = 0.5,
): AutoDismissReason {
  const empty: AutoDismissReason = {
    matched: false,
    similarity: 0,
    matchedKeywords: [],
    matchedPastSnippet: "",
  };
  if (!newText || pastTexts.length === 0) return empty;
  const cls = classifyReceipt(newText);
  if (cls.score >= 0.4) return empty;
  const newSet = extractKeywordSet(newText);
  if (newSet.size < 3) return empty;

  let best: AutoDismissReason = empty;
  for (const past of pastTexts) {
    const pastSet = extractKeywordSet(past);
    if (pastSet.size < 3) continue;
    const sim = jaccardSimilarity(newSet, pastSet);
    if (sim >= threshold && sim > best.similarity) {
      const inter: string[] = [];
      for (const k of newSet) if (pastSet.has(k)) inter.push(k);
      best = {
        matched: true,
        similarity: sim,
        matchedKeywords: inter.slice(0, 5),
        matchedPastSnippet: past.slice(0, 60).replace(/\s+/g, " "),
      };
    }
  }
  return best;
}
