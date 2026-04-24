// SQLite schema for kaikei desktop app
// ローカル1ユーザ向けのためRLSやauth参照は削除
// FK制約は接続URL (sqlite:kaikei.db?foreign_keys=true) で有効化する
pub const SCHEMA_SQL: &str = r#"

------------------------------------------------------------
-- 税区分マスタ
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tax_classes (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rate REAL NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('taxable_sales','taxable_purchase','export','exempt','non_taxable','out_of_scope')),
  reduced INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO tax_classes (code, name, rate, kind, reduced, sort_order) VALUES
  ('OUT',   '対象外',           0, 'out_of_scope',     0, 10),
  ('NT',    '不課税',           0, 'non_taxable',      0, 20),
  ('EXM',   '非課税',           0, 'exempt',           0, 30),
  ('EXP',   '輸出免税',         0, 'export',           0, 40),
  ('S10',   '課税売上10%',     10, 'taxable_sales',    0, 50),
  ('S08R',  '課税売上8%(軽)',   8, 'taxable_sales',    1, 60),
  ('S08',   '課税売上8%',       8, 'taxable_sales',    0, 70),
  ('P10',   '課対仕入10%',     10, 'taxable_purchase', 0, 80),
  ('P08R',  '課対仕入8%(軽)',   8, 'taxable_purchase', 1, 90),
  ('P08',   '課対仕入8%',       8, 'taxable_purchase', 0,100);

------------------------------------------------------------
-- 勘定科目マスタ（ユーザ追加・編集可能）
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT CHECK (category IN ('asset','liability','equity','revenue','expense','other')),
  name_en TEXT,
  sub_category TEXT,
  parent_category TEXT,
  display_name TEXT,
  short_cut_1 TEXT,
  short_cut_2 TEXT,
  default_tax_code TEXT,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

------------------------------------------------------------
-- 領収書
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  image_url TEXT NOT NULL,
  ocr_text TEXT,
  vendor_name TEXT,
  amount INTEGER,
  date TEXT,
  account_code TEXT,
  account_name TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','processed','confirmed')),
  doc_type TEXT DEFAULT 'receipt' CHECK (doc_type IN ('receipt','invoice','other')),
  file_hash TEXT,
  tax_code TEXT REFERENCES tax_classes(code),
  partner_id TEXT,
  tax_amount INTEGER DEFAULT 0,
  registered INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(date);
CREATE INDEX IF NOT EXISTS idx_receipts_hash ON receipts(file_hash);

------------------------------------------------------------
-- 仕訳
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journals (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  receipt_id TEXT REFERENCES receipts(id) ON DELETE SET NULL,
  number TEXT,
  is_adjustment INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_journals_date ON journals(date);

CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  debit_amount INTEGER DEFAULT 0,
  credit_amount INTEGER DEFAULT 0,
  tax_code TEXT REFERENCES tax_classes(code),
  tax_amount INTEGER DEFAULT 0,
  partner_id TEXT,
  item_id TEXT,
  department_id TEXT,
  memo TEXT
);
CREATE INDEX IF NOT EXISTS idx_journal_lines_journal ON journal_lines(journal_id);

------------------------------------------------------------
-- 口座・明細
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_type TEXT DEFAULT 'bank' CHECK (account_type IN ('bank','credit_card')),
  account_number_last4 TEXT,
  balance INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id TEXT PRIMARY KEY,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER,
  category TEXT,
  is_income INTEGER DEFAULT 0,
  journal_id TEXT REFERENCES journals(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched','ignored')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bank_tx_acc ON bank_transactions(bank_account_id, date);

------------------------------------------------------------
-- 源泉徴収票
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS withholding_slips (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  payer_name TEXT,
  payer_address TEXT,
  payment_amount INTEGER DEFAULT 0,
  withholding_tax INTEGER DEFAULT 0,
  social_insurance INTEGER DEFAULT 0,
  life_insurance_deduction INTEGER DEFAULT 0,
  earthquake_insurance_deduction INTEGER DEFAULT 0,
  housing_loan_deduction INTEGER DEFAULT 0,
  dependents_count INTEGER DEFAULT 0,
  image_url TEXT,
  ocr_text TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

------------------------------------------------------------
-- 確定申告
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tax_returns (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  return_type TEXT DEFAULT 'blue' CHECK (return_type IN ('blue','white')),
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','calculated','submitted')),
  revenue_total INTEGER DEFAULT 0,
  expense_total INTEGER DEFAULT 0,
  income_total INTEGER DEFAULT 0,
  basic_deduction INTEGER DEFAULT 480000,
  social_insurance_deduction INTEGER DEFAULT 0,
  life_insurance_deduction INTEGER DEFAULT 0,
  earthquake_insurance_deduction INTEGER DEFAULT 0,
  spouse_deduction INTEGER DEFAULT 0,
  dependents_deduction INTEGER DEFAULT 0,
  medical_deduction INTEGER DEFAULT 0,
  small_business_deduction INTEGER DEFAULT 0,
  blue_special_deduction INTEGER DEFAULT 650000,
  taxable_income INTEGER DEFAULT 0,
  income_tax INTEGER DEFAULT 0,
  reconstruction_tax INTEGER DEFAULT 0,
  withholding_total INTEGER DEFAULT 0,
  tax_due INTEGER DEFAULT 0,
  consumption_tax_amount INTEGER DEFAULT 0,
  consumption_tax_type TEXT DEFAULT 'exempt' CHECK (consumption_tax_type IN ('exempt','simplified','standard','invoice')),
  my_number_encrypted TEXT,
  etax_submission_id TEXT,
  etax_submitted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tax_return_expenses (
  id TEXT PRIMARY KEY,
  tax_return_id TEXT NOT NULL REFERENCES tax_returns(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  amount INTEGER DEFAULT 0
);

------------------------------------------------------------
-- 管理項目マスタ
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_kana TEXT,
  registered_number TEXT,
  is_customer INTEGER DEFAULT 1,
  is_vendor INTEGER DEFAULT 1,
  email TEXT,
  phone TEXT,
  address TEXT,
  default_account_code TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  shortcut1 TEXT,
  shortcut2 TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memo_tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);

------------------------------------------------------------
-- 家事按分
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS biz_allocations (
  id TEXT PRIMARY KEY,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  item_id TEXT,
  business_ratio INTEGER NOT NULL CHECK (business_ratio BETWEEN 0 AND 100),
  fiscal_year INTEGER NOT NULL,
  last_calculated_at TEXT,
  generated_journal_id TEXT REFERENCES journals(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

------------------------------------------------------------
-- 固定資産
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fixed_assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  asset_account_code TEXT NOT NULL,
  acquisition_date TEXT NOT NULL,
  acquisition_cost INTEGER NOT NULL,
  useful_life_years INTEGER,
  depreciation_method TEXT DEFAULT 'straight_line' CHECK (depreciation_method IN ('straight_line','declining_balance','none')),
  business_ratio INTEGER DEFAULT 100 CHECK (business_ratio BETWEEN 0 AND 100),
  residual_value INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','disposed','sold')),
  disposed_at TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fixed_asset_depreciations (
  id TEXT PRIMARY KEY,
  fixed_asset_id TEXT NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
  fiscal_year INTEGER NOT NULL,
  depreciation_amount INTEGER NOT NULL,
  book_value_after INTEGER NOT NULL,
  posted_journal_id TEXT REFERENCES journals(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

------------------------------------------------------------
-- 自動登録ルール
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_rules (
  id TEXT PRIMARY KEY,
  bank_account_id TEXT REFERENCES bank_accounts(id) ON DELETE CASCADE,
  is_income INTEGER,
  match_text TEXT NOT NULL,
  match_type TEXT DEFAULT 'contains' CHECK (match_type IN ('contains','starts','equals','regex')),
  amount_min INTEGER,
  amount_max INTEGER,
  priority INTEGER DEFAULT 0,
  action_type TEXT DEFAULT 'suggest_journal' CHECK (action_type IN ('suggest_journal','suggest_transfer','ignore')),
  account_code TEXT,
  account_name TEXT,
  tax_code TEXT REFERENCES tax_classes(code),
  partner_id TEXT,
  applied_count INTEGER DEFAULT 0,
  accepted_count INTEGER DEFAULT 0,
  is_enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
"#;

// -----------------------------------------------------------------------------
// V2: 請求書機能
// -----------------------------------------------------------------------------
pub const SCHEMA_V2_SQL: &str = r#"
-- 発行者情報（シングルトン: id='singleton'）
CREATE TABLE IF NOT EXISTS issuer_settings (
  id TEXT PRIMARY KEY,
  business_name TEXT,
  owner_name TEXT,
  postal_code TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  registered_number TEXT,      -- インボイス登録番号 T+13桁
  bank_info TEXT,              -- 振込先表記
  seal_image_url TEXT,         -- 印影画像
  default_payment_terms_days INTEGER DEFAULT 30,
  default_notes TEXT,          -- 請求書の固定文言
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 請求書ヘッダ
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  partner_id TEXT REFERENCES partners(id) ON DELETE SET NULL,
  partner_name TEXT NOT NULL,
  partner_address TEXT,
  subject TEXT,                -- 件名
  subtotal INTEGER DEFAULT 0,
  tax_amount INTEGER DEFAULT 0,
  total_amount INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','cancelled')),
  sent_at TEXT,
  paid_at TEXT,
  notes TEXT,
  journal_id TEXT REFERENCES journals(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_issue_date ON invoices(issue_date);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

-- 請求書明細
CREATE TABLE IF NOT EXISTS invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  description TEXT NOT NULL,
  quantity REAL DEFAULT 1,
  unit TEXT,                   -- 例: 個 / 時間 / 式
  unit_price INTEGER DEFAULT 0,
  amount INTEGER DEFAULT 0,
  tax_code TEXT REFERENCES tax_classes(code),
  tax_amount INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);

-- 自動ルール適用履歴（正答率トラッキング用）
CREATE TABLE IF NOT EXISTS auto_rule_applications (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES auto_rules(id) ON DELETE CASCADE,
  bank_transaction_id TEXT REFERENCES bank_transactions(id) ON DELETE CASCADE,
  accepted INTEGER,            -- NULL = 未確定, 1 = 採用, 0 = 却下
  applied_at TEXT DEFAULT (datetime('now'))
);

-- アプリ設定（KVストア）— id をキーとして使う
CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
"#;

