import type { Account } from "@/types";

// 国税庁「青色申告決算書（一般用）」の標準勘定科目に準拠
export const DEFAULT_ACCOUNTS: Account[] = [
  // ===== 資産 =====
  { code: "100", name: "現金",         category: "asset", name_en: "Cash",                 is_default: true },
  { code: "101", name: "小口現金",     category: "asset", name_en: "Petty Cash",           is_default: true },
  { code: "110", name: "普通預金",     category: "asset", name_en: "Bank Deposit",         is_default: true },
  { code: "111", name: "当座預金",     category: "asset", name_en: "Checking Account",     is_default: true },
  { code: "112", name: "定期預金",     category: "asset", name_en: "Time Deposit",         is_default: true },
  { code: "120", name: "売掛金",       category: "asset", name_en: "Accounts Receivable",  is_default: true },
  { code: "121", name: "受取手形",     category: "asset", name_en: "Notes Receivable",     is_default: true },
  { code: "122", name: "未収入金",     category: "asset", name_en: "Other Receivable",     is_default: true },
  { code: "130", name: "前払金",       category: "asset", name_en: "Prepaid Expense",      is_default: true },
  { code: "131", name: "前払費用",     category: "asset", name_en: "Prepaid",              is_default: true },
  { code: "140", name: "棚卸資産",     category: "asset", name_en: "Inventory",            is_default: true },
  { code: "150", name: "仮払金",       category: "asset", name_en: "Suspense Payment",     is_default: true },
  { code: "151", name: "仮払消費税",   category: "asset", name_en: "Suspense Tax Payment", is_default: true },
  { code: "160", name: "建物",         category: "asset", name_en: "Buildings",            is_default: true },
  { code: "161", name: "建物附属設備", category: "asset", name_en: "Building Fixtures",    is_default: true },
  { code: "162", name: "車両運搬具",   category: "asset", name_en: "Vehicles",             is_default: true },
  { code: "163", name: "工具器具備品", category: "asset", name_en: "Tools & Equipment",    is_default: true },
  { code: "164", name: "土地",         category: "asset", name_en: "Land",                 is_default: true },
  { code: "165", name: "ソフトウェア", category: "asset", name_en: "Software",             is_default: true },
  { code: "190", name: "事業主貸",     category: "asset", name_en: "Owner Draw",           is_default: true },

  // ===== 負債 =====
  { code: "200", name: "買掛金",       category: "liability", name_en: "Accounts Payable",     is_default: true },
  { code: "201", name: "支払手形",     category: "liability", name_en: "Notes Payable",        is_default: true },
  { code: "210", name: "未払金",       category: "liability", name_en: "Accrued Expenses",     is_default: true },
  { code: "211", name: "未払費用",     category: "liability", name_en: "Accrued",              is_default: true },
  { code: "212", name: "未払消費税",   category: "liability", name_en: "Consumption Tax Pay",  is_default: true },
  { code: "220", name: "預り金",       category: "liability", name_en: "Deposits Received",    is_default: true },
  { code: "221", name: "源泉所得税預り", category: "liability", name_en: "Withholding Held",   is_default: true },
  { code: "230", name: "前受金",       category: "liability", name_en: "Advance Received",     is_default: true },
  { code: "240", name: "短期借入金",   category: "liability", name_en: "Short-term Loan",      is_default: true },
  { code: "241", name: "長期借入金",   category: "liability", name_en: "Long-term Loan",       is_default: true },
  { code: "250", name: "仮受金",       category: "liability", name_en: "Suspense Receipt",     is_default: true },
  { code: "251", name: "仮受消費税",   category: "liability", name_en: "Suspense Tax Receipt", is_default: true },
  { code: "290", name: "事業主借",     category: "liability", name_en: "Owner Investment",     is_default: true },

  // ===== 資本 =====
  { code: "300", name: "元入金",       category: "equity",  name_en: "Capital",      is_default: true },
  { code: "310", name: "青色申告特別控除前所得", category: "equity", name_en: "Pre-deduction Income", is_default: true },

  // ===== 収益 =====
  { code: "400", name: "売上高",       category: "revenue", name_en: "Sales",                 is_default: true },
  { code: "401", name: "家事消費等",   category: "revenue", name_en: "Self-consumption",      is_default: true },
  { code: "410", name: "雑収入",       category: "revenue", name_en: "Misc. Income",          is_default: true },
  { code: "420", name: "受取利息",     category: "revenue", name_en: "Interest Income",       is_default: true },

  // ===== 売上原価 =====
  { code: "500", name: "期首商品棚卸高", category: "expense", name_en: "Opening Inventory", is_default: true },
  { code: "501", name: "仕入高",         category: "expense", name_en: "Purchases",         is_default: true },
  { code: "502", name: "期末商品棚卸高", category: "expense", name_en: "Closing Inventory", is_default: true },

  // ===== 経費（青色申告決算書 経費欄の順序に準拠） =====
  { code: "601", name: "租税公課",     category: "expense", name_en: "Taxes & Dues",      is_default: true },
  { code: "602", name: "荷造運賃",     category: "expense", name_en: "Freight",           is_default: true },
  { code: "603", name: "水道光熱費",   category: "expense", name_en: "Utilities",         is_default: true },
  { code: "604", name: "旅費交通費",   category: "expense", name_en: "Travel",            is_default: true },
  { code: "605", name: "通信費",       category: "expense", name_en: "Communication",     is_default: true },
  { code: "606", name: "広告宣伝費",   category: "expense", name_en: "Advertising",       is_default: true },
  { code: "607", name: "接待交際費",   category: "expense", name_en: "Entertainment",     is_default: true },
  { code: "608", name: "損害保険料",   category: "expense", name_en: "Insurance",         is_default: true },
  { code: "609", name: "修繕費",       category: "expense", name_en: "Repairs",           is_default: true },
  { code: "610", name: "消耗品費",     category: "expense", name_en: "Supplies",          is_default: true },
  { code: "611", name: "減価償却費",   category: "expense", name_en: "Depreciation",      is_default: true },
  { code: "612", name: "福利厚生費",   category: "expense", name_en: "Welfare",           is_default: true },
  { code: "613", name: "給料賃金",     category: "expense", name_en: "Salaries",          is_default: true },
  { code: "614", name: "外注工賃",     category: "expense", name_en: "Outsourcing",       is_default: true },
  { code: "615", name: "利子割引料",   category: "expense", name_en: "Interest",          is_default: true },
  { code: "616", name: "地代家賃",     category: "expense", name_en: "Rent",              is_default: true },
  { code: "617", name: "貸倒金",       category: "expense", name_en: "Bad Debt",          is_default: true },
  // 任意項目（よく使う）
  { code: "620", name: "新聞図書費",   category: "expense", name_en: "Books",             is_default: true },
  { code: "621", name: "会議費",       category: "expense", name_en: "Meetings",          is_default: true },
  { code: "622", name: "支払手数料",   category: "expense", name_en: "Fees",              is_default: true },
  { code: "623", name: "車両費",       category: "expense", name_en: "Vehicle",           is_default: true },
  { code: "624", name: "研修費",       category: "expense", name_en: "Training",          is_default: true },
  { code: "699", name: "雑費",         category: "expense", name_en: "Miscellaneous",     is_default: true },
];

// キーワード → 勘定科目コードのマッピング（自動推測の初期辞書）
const KEYWORD_MAP: { keywords: string[]; account_code: string }[] = [
  { keywords: ["タクシー", "JR", "電車", "バス", "Suica", "PASMO", "新幹線", "飛行機", "航空", "ANA", "JAL", "定期"], account_code: "604" },
  { keywords: ["ドコモ", "ソフトバンク", "au", "KDDI", "NTT", "AWS", "Google Cloud", "Azure", "サーバー", "ドメイン", "レンタルサーバ", "インターネット", "Wi-Fi", "携帯"], account_code: "605" },
  { keywords: ["Amazon", "アマゾン", "文房具", "コピー用紙", "トナー", "USB", "充電", "ケーブル", "電池", "100均", "ダイソー", "セリア"], account_code: "610" },
  { keywords: ["居酒屋", "レストラン", "焼肉", "寿司", "飲み会", "宴会", "バー", "ビール", "ワイン", "お中元", "お歳暮", "ギフト"], account_code: "607" },
  { keywords: ["家賃", "マンション", "オフィス", "事務所", "駐車場", "レンタルオフィス", "コワーキング"], account_code: "616" },
  { keywords: ["電気", "ガス", "水道", "東京電力", "東京ガス", "関西電力", "光熱費"], account_code: "603" },
  { keywords: ["広告", "Google Ads", "Facebook広告", "チラシ", "名刺", "看板", "SNS広告"], account_code: "606" },
  { keywords: ["振込手数料", "ATM手数料", "PayPal", "Stripe", "決済手数料", "仲介手数料"], account_code: "622" },
  { keywords: ["外注", "クラウドワークス", "ランサーズ", "ココナラ", "業務委託", "デザイン依頼"], account_code: "614" },
  { keywords: ["宅急便", "ゆうパック", "ヤマト", "佐川", "送料", "配送", "郵便"], account_code: "602" },
  { keywords: ["保険", "損害保険", "生命保険", "火災保険"], account_code: "608" },
  { keywords: ["修理", "修繕", "メンテナンス", "リフォーム"], account_code: "609" },
  { keywords: ["書籍", "本", "雑誌", "新聞", "サブスクリプション", "Kindle", "日経", "技術書"], account_code: "620" },
  { keywords: ["カフェ", "スターバックス", "ドトール", "タリーズ", "コメダ", "会議室", "打ち合わせ"], account_code: "621" },
  { keywords: ["印紙", "収入印紙", "固定資産税", "自動車税", "住民税", "所得税", "国民年金", "国民健康保険"], account_code: "601" },
];

export function suggestAccount(text: string): { code: string; name: string } | null {
  const normalizedText = text.toLowerCase();
  for (const mapping of KEYWORD_MAP) {
    for (const keyword of mapping.keywords) {
      if (normalizedText.includes(keyword.toLowerCase())) {
        const account = DEFAULT_ACCOUNTS.find((a) => a.code === mapping.account_code);
        if (account) {
          return { code: account.code, name: account.name };
        }
      }
    }
  }
  return null;
}

/**
 * Round 24 ㊞: partners.default_account_code を優先してから suggestAccount.
 *
 * - vendor_name が partners と完全一致 (or 部分一致) かつ default_account_code
 *   が登録されてれば、その科目を即返す (ユーザがその取引先用に決めた科目)
 * - ヒットしなければキーワードマップ (suggestAccount) に fallback
 *
 * 効果: 「タリーズコーヒー」を partners に登録 + default_account_code='621'
 *       (会議費) にしておけば、以後 OCR で同じ vendor が来た瞬間に会議費が
 *       自動セットされる。ユーザの「毎回科目を選ぶ」操作が消える。
 */
export async function suggestAccountForVendor(
  vendorName: string | null | undefined,
  fullText: string,
): Promise<{ code: string; name: string } | null> {
  // partners 検索 (vendor_name が空なら skip)
  if (vendorName && vendorName.trim().length >= 2) {
    try {
      const { db } = await import("@/lib/localDb");
      // 1) 完全一致
      const { data: exact } = await db
        .from("partners")
        .select("name, default_account_code")
        .eq("name", vendorName.trim())
        .single();
      const exactRow = exact as
        | { name: string; default_account_code: string | null }
        | null;
      if (exactRow?.default_account_code) {
        const acc = DEFAULT_ACCOUNTS.find((a) => a.code === exactRow.default_account_code);
        if (acc) return { code: acc.code, name: acc.name };
      }
      // 2) text に partners.name の一部が含まれているか部分一致
      //    (店舗名表記揺れ対策: "タリーズコーヒー トリアス久山店" → "タリーズコーヒー")
      const { data: all } = await db
        .from("partners")
        .select("name, default_account_code");
      const rows = (all as { name: string; default_account_code: string | null }[] | null) ?? [];
      const haystack = `${vendorName} ${fullText}`.toLowerCase();
      for (const p of rows) {
        if (!p.default_account_code || !p.name || p.name.length < 2) continue;
        if (haystack.includes(p.name.toLowerCase())) {
          const acc = DEFAULT_ACCOUNTS.find((a) => a.code === p.default_account_code);
          if (acc) return { code: acc.code, name: acc.name };
        }
      }
    } catch {
      /* partners 取得失敗は致命的ではない、suggestAccount に fallback */
    }
  }
  // partners ヒットなし → 既存のキーワードマッチ
  return suggestAccount(`${vendorName ?? ""} ${fullText}`);
}

export function getAccountByCode(code: string): Account | undefined {
  return DEFAULT_ACCOUNTS.find((a) => a.code === code);
}

export function getExpenseAccounts(): Account[] {
  return DEFAULT_ACCOUNTS.filter((a) => a.category === "expense");
}

export function getAccountsByCategory(category: Account["category"]): Account[] {
  return DEFAULT_ACCOUNTS.filter((a) => a.category === category);
}

export function findAccountCodeByName(name: string | null): string | null {
  if (!name) return null;
  const account = DEFAULT_ACCOUNTS.find((a) => a.name === name);
  return account?.code ?? null;
}

// ---------------------------------------------------------------------------
// 科目コード → 区分 (売上/経費などの集計はここを単一の基準にする)
// ---------------------------------------------------------------------------

/** 取込時に科目名を解決できなかった明細に付く仮コード (未分類)。 */
export const UNCLASSIFIED_ACCOUNT_CODE = "999";

export type AccountCategoryMap = ReadonlyMap<string, Account["category"]>;

/** 既定の科目表だけで作った「コード → 区分」の対応表。 */
export const DEFAULT_CATEGORY_MAP: AccountCategoryMap = new Map(
  DEFAULT_ACCOUNTS.map((a) => [a.code, a.category]),
);

const CATEGORIES: readonly Account["category"][] = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
];

/**
 * 既定の科目表 + DB の accounts テーブル (マスタ取込・ユーザ追加分) を合わせた
 * 「コード → 区分」の対応表を返す。既定コードの区分は DB 側で上書きさせない。
 */
export async function loadAccountCategoryMap(): Promise<AccountCategoryMap> {
  const map = new Map(DEFAULT_CATEGORY_MAP);
  try {
    const { db } = await import("@/lib/localDb");
    const { data } = await db.from("accounts").select("code, category");
    for (const row of (data as { code: string; category: string }[] | null) ?? []) {
      const cat = row.category as Account["category"];
      if (row.code && !map.has(row.code) && CATEGORIES.includes(cat)) {
        map.set(row.code, cat);
      }
    }
  } catch {
    /* DB が読めない時は既定の科目表だけで判定する */
  }
  return map;
}

/** 損益計算書・貸借対照表のどこに入るか。 */
export type AccountKind = "revenue" | "cogs" | "expense" | "bs";

/**
 * 科目コード → 集計上の区分。
 *   - revenue: 収益 / cogs: 売上原価 (5xx) / expense: 経費 / bs: 資産・負債・資本
 *   - null: 科目表に無いコード (取込で付いた 999 = 未分類 など)
 *
 * 以前は「コードの先頭が 4 なら売上、5・6 なら経費」と数字だけで判定していたため、
 * 999 (未分類) や A9xx (マスタ取込で採番) の明細が売上にも経費にも入らず、
 * 黙って集計から消えていた。区分は必ず科目表から引き、引けないものは
 * null として呼び出し側が「未分類」として扱う (= 利用者に見せる)。
 */
export function classifyAccountCode(
  code: string | null | undefined,
  categories: AccountCategoryMap = DEFAULT_CATEGORY_MAP,
): AccountKind | null {
  if (!code) return null;
  const cat = categories.get(code);
  if (!cat) return null;
  if (cat === "revenue") return "revenue";
  if (cat === "expense") return /^5\d\d$/.test(code) ? "cogs" : "expense";
  return "bs";
}

/**
 * 他の会計ソフト (freee / マネーフォワード / 弥生) でよく使われる科目名の別名。
 * 意味が同じと言い切れるものだけを載せる (迷うものは未分類のまま利用者に選ばせる)。
 */
const ACCOUNT_NAME_ALIASES: Record<string, string> = {
  // 収益
  売上: "400",
  売上金額: "400",
  // 売上原価
  仕入: "501",
  仕入金額: "501",
  期首棚卸高: "500",
  期末棚卸高: "502",
  // 経費
  交際費: "607",
  接待費: "607",
  外注費: "614",
  業務委託費: "614",
  保険料: "608",
  支払保険料: "608",
  支払利息: "615",
  給料手当: "613",
  給与手当: "613",
  給料: "613",
  雑給: "613",
  家賃: "616",
  貸倒損失: "617",
  図書費: "620",
  書籍費: "620",
  手数料: "622",
  荷造発送費: "602",
  発送費: "602",
  広告費: "606",
  交通費: "604",
  旅費: "604",
  事務用品費: "610",
  // 資産・負債・資本
  預金: "110",
  未払い金: "210",
};

function normalizeAccountName(name: string): string {
  return name.normalize("NFKC").replace(/\s/g, "");
}

const ACCOUNT_BY_NORMALIZED_NAME = new Map(
  DEFAULT_ACCOUNTS.map((a) => [normalizeAccountName(a.name), a]),
);

/**
 * 科目名から既定の科目を引く (完全一致 → 別名)。空白と全角/半角の差は無視する。
 * 引けない時は null (取込側は未分類コードにして利用者に知らせる)。
 */
export function resolveAccountByName(
  name: string | null | undefined,
): { code: string; name: string } | null {
  if (!name) return null;
  const key = normalizeAccountName(name);
  if (!key) return null;
  const exact = ACCOUNT_BY_NORMALIZED_NAME.get(key);
  if (exact) return { code: exact.code, name: exact.name };
  const aliasCode = ACCOUNT_NAME_ALIASES[key];
  if (aliasCode) {
    const a = DEFAULT_ACCOUNTS.find((x) => x.code === aliasCode);
    if (a) return { code: a.code, name: a.name };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 予測変換 (freee 風タイプアヘッド) 用の読み仮名 + 検索
// ---------------------------------------------------------------------------

/** 勘定科目コード → 読み仮名 (ひらがな)。「しょうもう」で消耗品費が出るように。 */
export const ACCOUNT_READINGS: Record<string, string> = {
  // 資産
  "100": "げんきん", "101": "こぐちげんきん", "110": "ふつうよきん",
  "111": "とうざよきん", "112": "ていきよきん", "120": "うりかけきん",
  "121": "うけとりてがた", "122": "みしゅうにゅうきん", "130": "まえばらいきん",
  "131": "まえばらいひよう", "140": "たなおろししさん", "150": "かりばらいきん",
  "151": "かりばらいしょうひぜい", "160": "たてもの", "161": "たてものふぞくせつび",
  "162": "しゃりょううんぱんぐ", "163": "こうぐきぐびひん", "164": "とち",
  "165": "そふとうぇあ", "190": "じぎょうぬしかし",
  // 負債
  "200": "かいかけきん", "201": "しはらいてがた", "210": "みばらいきん",
  "211": "みばらいひよう", "212": "みばらいしょうひぜい", "220": "あずかりきん",
  "221": "げんせんしょとくぜいあずかり", "230": "まえうけきん", "240": "たんきかりいれきん",
  "241": "ちょうきかりいれきん", "250": "かりうけきん", "251": "かりうけしょうひぜい",
  "290": "じぎょうぬしかり",
  // 資本
  "300": "もといれきん", "310": "あおいろしんこくとくべつこうじょまえしょとく",
  // 収益
  "400": "うりあげだか", "401": "かじしょうひとう", "410": "ざつしゅうにゅう",
  "420": "うけとりりそく",
  // 売上原価
  "500": "きしゅしょうひんたなおろしだか", "501": "しいれだか",
  "502": "きまつしょうひんたなおろしだか",
  // 経費
  "601": "そぜいこうか", "602": "にづくりうんちん", "603": "すいどうこうねつひ",
  "604": "りょひこうつうひ", "605": "つうしんひ", "606": "こうこくせんでんひ",
  "607": "せったいこうさいひ", "608": "そんがいほけんりょう", "609": "しゅうぜんひ",
  "610": "しょうもうひんひ", "611": "げんかしょうきゃくひ", "612": "ふくりこうせいひ",
  "613": "きゅうりょうちんぎん", "614": "がいちゅうこうちん", "615": "りしわりびきりょう",
  "616": "ちだいやちん", "617": "かしだおれきん", "620": "しんぶんとしょひ",
  "621": "かいぎひ", "622": "しはらいてすうりょう", "623": "しゃりょうひ",
  "624": "けんしゅうひ", "699": "ざっぴ",
};

function kataToHira(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0x60),
  );
}

/** 検索用の正規化: NFKC (全角→半角) + カタカナ→ひらがな + 小文字化。 */
export function normalizeForSearch(s: string): string {
  return kataToHira(s.normalize("NFKC")).toLowerCase();
}

/**
 * freee 風の予測変換。query を コード / 科目名 / 読み仮名 / 英名 で部分一致させ、
 * 関連度 (前方一致 > 部分一致、コード・名前 > 読み > 英名) の高い順に返す。
 * query が空なら pool をそのまま返す。
 */
export function searchAccounts(
  query: string,
  category?: Account["category"],
): Account[] {
  const pool = category
    ? DEFAULT_ACCOUNTS.filter((a) => a.category === category)
    : DEFAULT_ACCOUNTS;
  const q = normalizeForSearch(query.trim());
  if (!q) return pool;

  const scored: { account: Account; score: number }[] = [];
  for (const a of pool) {
    const code = a.code.toLowerCase();
    const name = normalizeForSearch(a.name);
    const reading = normalizeForSearch(ACCOUNT_READINGS[a.code] ?? "");
    const en = normalizeForSearch(a.name_en ?? "");
    let score = 0;
    if (code === q) score = 1000;
    else if (code.startsWith(q)) score = 900;
    else if (name.startsWith(q)) score = 820;
    else if (reading.startsWith(q)) score = 780;
    else if (name.includes(q)) score = 600;
    else if (reading.includes(q)) score = 520;
    else if (en.startsWith(q)) score = 400;
    else if (en.includes(q)) score = 300;
    else if (code.includes(q)) score = 200;
    if (score > 0) scored.push({ account: a, score });
  }
  scored.sort(
    (x, y) => y.score - x.score || x.account.code.localeCompare(y.account.code),
  );
  return scored.map((s) => s.account);
}
