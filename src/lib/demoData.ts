/**
 * LP用スクリーンショット生成時に、`?demo=1` が URL に含まれている場合だけ
 * 使用するモックデータ。ページは loadX() の先頭で isDemoMode() をチェックし、
 * true なら DB を叩かずに対応する MOCK_* を返す想定。
 *
 * 本番ビルドでも tree-shake されないが、分量は僅かなのでそのまま同梱。
 */

export function isDemoMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("demo") === "1";
}

// ──────────────────────────────────────────────────────────
// 仕訳 (journals) + 仕訳明細 (journal_lines) + 領収書 (receipts)
// ──────────────────────────────────────────────────────────

export const MOCK_RECEIPTS = [
  {
    id: "r1",
    user_id: "demo",
    image_url: "https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=200&h=280&fit=crop",
    vendor_name: "スターバックス 渋谷店",
    amount: 1240,
    date: "2026-03-15",
    account_code: "603",
    account_name: "会議費",
    status: "confirmed",
    created_at: "2026-03-15T10:00:00Z",
    ocr_text: null,
  },
  {
    id: "r2",
    user_id: "demo",
    image_url: "https://images.unsplash.com/photo-1563013544-824ae1b704d3?w=200&h=280&fit=crop",
    vendor_name: "ヨドバシカメラ",
    amount: 24800,
    date: "2026-03-12",
    account_code: "605",
    account_name: "消耗品費",
    status: "confirmed",
    created_at: "2026-03-12T14:30:00Z",
    ocr_text: null,
  },
  {
    id: "r3",
    user_id: "demo",
    image_url: "https://images.unsplash.com/photo-1586880244406-556ebe35f282?w=200&h=280&fit=crop",
    vendor_name: "JR東日本",
    amount: 860,
    date: "2026-03-10",
    account_code: "601",
    account_name: "旅費交通費",
    status: "confirmed",
    created_at: "2026-03-10T18:00:00Z",
    ocr_text: null,
  },
  {
    id: "r4",
    user_id: "demo",
    image_url: "https://images.unsplash.com/photo-1567521464027-f127ff144326?w=200&h=280&fit=crop",
    vendor_name: "Adobe Systems",
    amount: 6580,
    date: "2026-03-08",
    account_code: "604",
    account_name: "通信費",
    status: "confirmed",
    created_at: "2026-03-08T09:15:00Z",
    ocr_text: null,
  },
  {
    id: "r5",
    user_id: "demo",
    image_url: "https://images.unsplash.com/photo-1572102254099-c3f3e0a6cd42?w=200&h=280&fit=crop",
    vendor_name: "サンマルクカフェ",
    amount: 820,
    date: "2026-03-05",
    account_code: "603",
    account_name: "会議費",
    status: "confirmed",
    created_at: "2026-03-05T11:00:00Z",
    ocr_text: null,
  },
  {
    id: "r6",
    user_id: "demo",
    image_url: "https://images.unsplash.com/photo-1556742111-a301076d9d18?w=200&h=280&fit=crop",
    vendor_name: "Amazon Business",
    amount: 12480,
    date: "2026-03-03",
    account_code: "605",
    account_name: "消耗品費",
    status: "processed",
    created_at: "2026-03-03T16:20:00Z",
    ocr_text: null,
  },
];

export const MOCK_JOURNALS = [
  {
    id: "j1",
    user_id: "demo",
    date: "2026-03-18",
    description: "ABCコーポレーション 3月分 報酬入金",
    receipt_id: null,
    created_at: "2026-03-18T09:00:00Z",
    receipts: null,
    journal_lines: [
      { id: "l1", journal_id: "j1", account_code: "112", account_name: "普通預金", debit_amount: 550000, credit_amount: 0, tax_code: "none", tax_amount: 0, partner_id: null, item_id: null, department_id: null, memo: null },
      { id: "l2", journal_id: "j1", account_code: "500", account_name: "売上高", debit_amount: 0, credit_amount: 500000, tax_code: "tax10", tax_amount: 50000, partner_id: null, item_id: null, department_id: null, memo: null },
      { id: "l3", journal_id: "j1", account_code: "216", account_name: "仮受消費税", debit_amount: 0, credit_amount: 50000, tax_code: "none", tax_amount: 0, partner_id: null, item_id: null, department_id: null, memo: null },
    ],
  },
  {
    id: "j2",
    user_id: "demo",
    date: "2026-03-15",
    description: "スターバックス 渋谷店 ミーティング",
    receipt_id: "r1",
    created_at: "2026-03-15T10:00:00Z",
    receipts: { id: "r1", vendor_name: "スターバックス 渋谷店", image_url: "https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=200&h=280&fit=crop" },
    journal_lines: [
      { id: "l4", journal_id: "j2", account_code: "603", account_name: "会議費", debit_amount: 1127, credit_amount: 0, tax_code: "tax10", tax_amount: 113, partner_id: null, item_id: null, department_id: null, memo: null },
      { id: "l5", journal_id: "j2", account_code: "218", account_name: "仮払消費税", debit_amount: 113, credit_amount: 0, tax_code: "none", tax_amount: 0, partner_id: null, item_id: null, department_id: null, memo: null },
      { id: "l6", journal_id: "j2", account_code: "112", account_name: "普通預金", debit_amount: 0, credit_amount: 1240, tax_code: "none", tax_amount: 0, partner_id: null, item_id: null, department_id: null, memo: null },
    ],
  },
  {
    id: "j3",
    user_id: "demo",
    date: "2026-03-12",
    description: "ヨドバシカメラ オフィス備品",
    receipt_id: "r2",
    created_at: "2026-03-12T14:30:00Z",
    receipts: { id: "r2", vendor_name: "ヨドバシカメラ", image_url: "https://images.unsplash.com/photo-1563013544-824ae1b704d3?w=200&h=280&fit=crop" },
    journal_lines: [
      { id: "l7", journal_id: "j3", account_code: "605", account_name: "消耗品費", debit_amount: 22545, credit_amount: 0, tax_code: "tax10", tax_amount: 2255, partner_id: null, item_id: null, department_id: null, memo: null },
      { id: "l8", journal_id: "j3", account_code: "218", account_name: "仮払消費税", debit_amount: 2255, credit_amount: 0, tax_code: "none", tax_amount: 0, partner_id: null, item_id: null, department_id: null, memo: null },
      { id: "l9", journal_id: "j3", account_code: "222", account_name: "未払金", debit_amount: 0, credit_amount: 24800, tax_code: "none", tax_amount: 0, partner_id: null, item_id: null, department_id: null, memo: null },
    ],
  },
  {
    id: "j4",
    user_id: "demo",
    date: "2026-03-10",
    description: "JR東日本 取引先訪問",
    receipt_id: "r3",
    created_at: "2026-03-10T18:00:00Z",
    receipts: { id: "r3", vendor_name: "JR東日本", image_url: "https://images.unsplash.com/photo-1586880244406-556ebe35f282?w=200&h=280&fit=crop" },
    journal_lines: [
      { id: "l10", journal_id: "j4", account_code: "601", account_name: "旅費交通費", debit_amount: 860, credit_amount: 0, tax_code: "tax10", tax_amount: 78, partner_id: null, item_id: null, department_id: null, memo: null },
      { id: "l11", journal_id: "j4", account_code: "112", account_name: "普通預金", debit_amount: 0, credit_amount: 860, tax_code: "none", tax_amount: 0, partner_id: null, item_id: null, department_id: null, memo: null },
    ],
  },
  {
    id: "j5",
    user_id: "demo",
    date: "2026-03-08",
    description: "Adobe Creative Cloud 月額",
    receipt_id: "r4",
    created_at: "2026-03-08T09:15:00Z",
    receipts: { id: "r4", vendor_name: "Adobe Systems", image_url: "https://images.unsplash.com/photo-1567521464027-f127ff144326?w=200&h=280&fit=crop" },
    journal_lines: [
      { id: "l12", journal_id: "j5", account_code: "604", account_name: "通信費", debit_amount: 5982, credit_amount: 0, tax_code: "tax10", tax_amount: 598, partner_id: null, item_id: null, department_id: null, memo: null },
      { id: "l13", journal_id: "j5", account_code: "112", account_name: "普通預金", debit_amount: 0, credit_amount: 6580, tax_code: "none", tax_amount: 0, partner_id: null, item_id: null, department_id: null, memo: null },
    ],
  },
  {
    id: "j6",
    user_id: "demo",
    date: "2026-03-05",
    description: "ソフトバンク 携帯料金 3月分",
    receipt_id: null,
    created_at: "2026-03-05T08:00:00Z",
    receipts: null,
    journal_lines: [
      { id: "l14", journal_id: "j6", account_code: "604", account_name: "通信費", debit_amount: 8910, credit_amount: 0, tax_code: "tax10", tax_amount: 810, partner_id: null, item_id: null, department_id: null, memo: null },
      { id: "l15", journal_id: "j6", account_code: "112", account_name: "普通預金", debit_amount: 0, credit_amount: 9720, tax_code: "none", tax_amount: 0, partner_id: null, item_id: null, department_id: null, memo: null },
    ],
  },
];

// ──────────────────────────────────────────────────────────
// 請求書 (invoices)
// ──────────────────────────────────────────────────────────

export const MOCK_INVOICES = [
  {
    id: "i1",
    invoice_number: "INV-2026-012",
    issue_date: "2026-03-31",
    due_date: "2026-04-30",
    partner_id: "p1",
    partner_name: "ABCコーポレーション株式会社",
    partner_address: "東京都千代田区丸の内1-1-1",
    subject: "3月分 顧問料・開発業務",
    subtotal: 500000,
    tax_amount: 50000,
    total_amount: 550000,
    status: "sent",
    sent_at: "2026-03-31T10:00:00Z",
    paid_at: null,
    notes: null,
    journal_id: null,
    created_at: "2026-03-31T09:00:00Z",
    updated_at: "2026-03-31T10:00:00Z",
  },
  {
    id: "i2",
    invoice_number: "INV-2026-011",
    issue_date: "2026-03-31",
    due_date: "2026-04-30",
    partner_id: "p2",
    partner_name: "株式会社テック&デザイン",
    partner_address: "東京都渋谷区神南1-2-3",
    subject: "3月分 Webサイト制作費",
    subtotal: 280000,
    tax_amount: 28000,
    total_amount: 308000,
    status: "paid",
    sent_at: "2026-03-31T11:00:00Z",
    paid_at: "2026-04-15T10:00:00Z",
    notes: null,
    journal_id: null,
    created_at: "2026-03-31T09:30:00Z",
    updated_at: "2026-04-15T10:00:00Z",
  },
  {
    id: "i3",
    invoice_number: "INV-2026-010",
    issue_date: "2026-02-28",
    due_date: "2026-03-31",
    partner_id: "p3",
    partner_name: "合同会社スタートアップX",
    partner_address: "東京都港区六本木6-10-1",
    subject: "2月分 技術アドバイザリー",
    subtotal: 200000,
    tax_amount: 20000,
    total_amount: 220000,
    status: "paid",
    sent_at: "2026-02-28T14:00:00Z",
    paid_at: "2026-03-20T10:00:00Z",
    notes: null,
    journal_id: null,
    created_at: "2026-02-28T13:00:00Z",
    updated_at: "2026-03-20T10:00:00Z",
  },
  {
    id: "i4",
    invoice_number: "INV-2026-009",
    issue_date: "2026-02-15",
    due_date: "2026-03-15",
    partner_id: "p1",
    partner_name: "ABCコーポレーション株式会社",
    partner_address: "東京都千代田区丸の内1-1-1",
    subject: "2月分 開発業務 追加分",
    subtotal: 150000,
    tax_amount: 15000,
    total_amount: 165000,
    status: "paid",
    sent_at: "2026-02-15T10:00:00Z",
    paid_at: "2026-03-10T10:00:00Z",
    notes: null,
    journal_id: null,
    created_at: "2026-02-15T09:00:00Z",
    updated_at: "2026-03-10T10:00:00Z",
  },
];

// ──────────────────────────────────────────────────────────
// 銀行取引 (bank_transactions)
// ──────────────────────────────────────────────────────────

export const MOCK_BANK_TRANSACTIONS = [
  { id: "bt1", bank_account_id: "ba1", user_id: "demo", date: "2026-03-25", description: "カ)エービーシーコーポレーション", amount: 550000,  balance_after: 1850000, category: null, is_income: true,  journal_id: "j1", status: "matched",   created_at: "2026-03-25T10:00:00Z" },
  { id: "bt2", bank_account_id: "ba1", user_id: "demo", date: "2026-03-20", description: "ラクテンカ-ド",                    amount: -45200,  balance_after: 1300000, category: null, is_income: false, journal_id: null, status: "unmatched", created_at: "2026-03-20T08:00:00Z" },
  { id: "bt3", bank_account_id: "ba1", user_id: "demo", date: "2026-03-18", description: "AWS BILLING",                    amount: -8920,   balance_after: 1345200, category: null, is_income: false, journal_id: null, status: "unmatched", created_at: "2026-03-18T08:00:00Z" },
  { id: "bt4", bank_account_id: "ba1", user_id: "demo", date: "2026-03-15", description: "スターバックス",                    amount: -1240,   balance_after: 1354120, category: null, is_income: false, journal_id: "j2", status: "matched",   created_at: "2026-03-15T10:00:00Z" },
  { id: "bt5", bank_account_id: "ba1", user_id: "demo", date: "2026-03-10", description: "ＪＲヒガシニホン",                   amount: -860,    balance_after: 1355360, category: null, is_income: false, journal_id: "j4", status: "matched",   created_at: "2026-03-10T18:00:00Z" },
  { id: "bt6", bank_account_id: "ba1", user_id: "demo", date: "2026-03-08", description: "アドビシステムス",                   amount: -6580,   balance_after: 1356220, category: null, is_income: false, journal_id: "j5", status: "matched",   created_at: "2026-03-08T09:15:00Z" },
  { id: "bt7", bank_account_id: "ba1", user_id: "demo", date: "2026-03-05", description: "ソフトバンク",                      amount: -9720,   balance_after: 1362800, category: null, is_income: false, journal_id: "j6", status: "matched",   created_at: "2026-03-05T08:00:00Z" },
  { id: "bt8", bank_account_id: "ba1", user_id: "demo", date: "2026-03-01", description: "フリコミ テクアンドデザイン",           amount: 308000,  balance_after: 1372520, category: null, is_income: true,  journal_id: null, status: "unmatched", created_at: "2026-03-01T10:00:00Z" },
];
