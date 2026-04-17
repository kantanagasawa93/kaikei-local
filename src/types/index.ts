export interface Receipt {
  id: string;
  user_id: string;
  image_url: string;
  ocr_text: string | null;
  vendor_name: string | null;
  amount: number | null;
  date: string | null;
  account_code: string | null;
  account_name: string | null;
  status: "pending" | "processed" | "confirmed";
  created_at: string;
}

export interface Journal {
  id: string;
  user_id: string;
  date: string;
  description: string;
  receipt_id: string | null;
  created_at: string;
  lines?: JournalLine[];
}

export interface JournalLine {
  id: string;
  journal_id: string;
  account_code: string;
  account_name: string;
  debit_amount: number;
  credit_amount: number;
  tax_code: string | null;
  tax_amount: number;
  partner_id: string | null;
  item_id: string | null;
  department_id: string | null;
  memo: string | null;
}

export interface TaxClass {
  code: string;
  name: string;
  rate: number;
  kind: "taxable_sales" | "taxable_purchase" | "export" | "exempt" | "non_taxable" | "out_of_scope";
  reduced: boolean;
  sort_order: number;
}

export interface Partner {
  id: string;
  user_id: string;
  name: string;
  name_kana: string | null;
  registered_number: string | null;
  is_customer: boolean;
  is_vendor: boolean;
  email: string | null;
  phone: string | null;
  address: string | null;
  default_account_code: string | null;
  notes: string | null;
  created_at: string;
}

export interface Item {
  id: string;
  user_id: string;
  name: string;
  shortcut1: string | null;
  shortcut2: string | null;
  created_at: string;
}

export interface Department {
  id: string;
  user_id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
}

export interface MemoTag {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
}

export interface BizAllocation {
  id: string;
  user_id: string;
  account_code: string;
  account_name: string;
  item_id: string | null;
  business_ratio: number;
  fiscal_year: number;
  last_calculated_at: string | null;
  generated_journal_id: string | null;
  created_at: string;
}

export interface FixedAsset {
  id: string;
  user_id: string;
  name: string;
  asset_account_code: string;
  acquisition_date: string;
  acquisition_cost: number;
  useful_life_years: number | null;
  depreciation_method: "straight_line" | "declining_balance" | "none";
  business_ratio: number;
  residual_value: number;
  status: "active" | "disposed" | "sold";
  disposed_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface FixedAssetDepreciation {
  id: string;
  fixed_asset_id: string;
  fiscal_year: number;
  depreciation_amount: number;
  book_value_after: number;
  posted_journal_id: string | null;
  created_at: string;
}

export interface IssuerSettings {
  id: string;
  business_name: string | null;
  owner_name: string | null;
  postal_code: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  registered_number: string | null;
  bank_info: string | null;
  seal_image_url: string | null;
  default_payment_terms_days: number;
  default_notes: string | null;
  updated_at: string;
}

export interface Invoice {
  id: string;
  invoice_number: string;
  issue_date: string;
  due_date: string | null;
  partner_id: string | null;
  partner_name: string;
  partner_address: string | null;
  subject: string | null;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  status: "draft" | "sent" | "paid" | "cancelled";
  sent_at: string | null;
  paid_at: string | null;
  notes: string | null;
  journal_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceItem {
  id: string;
  invoice_id: string;
  sort_order: number;
  description: string;
  quantity: number;
  unit: string | null;
  unit_price: number;
  amount: number;
  tax_code: string | null;
  tax_amount: number;
}

export interface AutoRule {
  id: string;
  user_id: string;
  bank_account_id: string | null;
  is_income: boolean | null;
  match_text: string;
  match_type: "contains" | "starts" | "equals" | "regex";
  amount_min: number | null;
  amount_max: number | null;
  priority: number;
  action_type: "suggest_journal" | "suggest_transfer" | "ignore";
  account_code: string | null;
  account_name: string | null;
  tax_code: string | null;
  partner_id: string | null;
  applied_count: number;
  accepted_count: number;
  is_enabled: boolean;
  created_at: string;
}

export interface Account {
  code: string;
  name: string;
  category: "asset" | "liability" | "equity" | "revenue" | "expense";
  name_en: string;
  is_default: boolean;
}

export interface OcrResult {
  raw_text: string;
  vendor_name: string | null;
  amount: number | null;
  date: string | null;
  suggested_account_code: string | null;
  suggested_account_name: string | null;
}

// Phase 2: 口座・クレカ連携
export interface BankAccount {
  id: string;
  user_id: string;
  name: string;
  bank_name: string;
  account_type: "bank" | "credit_card";
  account_number_last4: string | null;
  balance: number;
  is_active: boolean;
  created_at: string;
}

export interface BankTransaction {
  id: string;
  bank_account_id: string;
  user_id: string;
  date: string;
  description: string;
  amount: number;
  balance_after: number | null;
  category: string | null;
  is_income: boolean;
  journal_id: string | null;
  status: "unmatched" | "matched" | "ignored";
  created_at: string;
}

// Phase 4: 源泉徴収票
export interface WithholdingSlip {
  id: string;
  user_id: string;
  year: number;
  payer_name: string | null;
  payer_address: string | null;
  payment_amount: number;
  withholding_tax: number;
  social_insurance: number;
  life_insurance_deduction: number;
  earthquake_insurance_deduction: number;
  housing_loan_deduction: number;
  dependents_count: number;
  image_url: string | null;
  ocr_text: string | null;
  created_at: string;
}

// Phase 5: 確定申告
export interface TaxReturn {
  id: string;
  user_id: string;
  year: number;
  return_type: "blue" | "white";
  status: "draft" | "calculated" | "submitted";
  revenue_total: number;
  expense_total: number;
  income_total: number;
  basic_deduction: number;
  social_insurance_deduction: number;
  life_insurance_deduction: number;
  earthquake_insurance_deduction: number;
  spouse_deduction: number;
  dependents_deduction: number;
  medical_deduction: number;
  small_business_deduction: number;
  blue_special_deduction: number;
  taxable_income: number;
  income_tax: number;
  reconstruction_tax: number;
  withholding_total: number;
  tax_due: number;
  consumption_tax_amount: number;
  consumption_tax_type: "exempt" | "simplified" | "standard" | "invoice";
  my_number_encrypted: string | null;
  etax_submission_id: string | null;
  etax_submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaxReturnExpense {
  id: string;
  tax_return_id: string;
  account_code: string;
  account_name: string;
  amount: number;
}
