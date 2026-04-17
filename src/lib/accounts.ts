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
