-- ============================================================
-- Phase 2: 口座・クレカ連携
-- ============================================================

-- 連携口座テーブル
create table if not exists bank_accounts (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  bank_name text not null,
  account_type text default 'bank' check (account_type in ('bank', 'credit_card')),
  account_number_last4 text,
  balance integer default 0,
  is_active boolean default true,
  created_at timestamptz default now()
);

-- 口座明細テーブル
create table if not exists bank_transactions (
  id uuid default gen_random_uuid() primary key,
  bank_account_id uuid references bank_accounts(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  date date not null,
  description text not null,
  amount integer not null,
  balance_after integer,
  category text,
  is_income boolean default false,
  journal_id uuid references journals(id) on delete set null,
  status text default 'unmatched' check (status in ('unmatched', 'matched', 'ignored')),
  created_at timestamptz default now()
);

-- ============================================================
-- Phase 4: 源泉徴収票
-- ============================================================

create table if not exists withholding_slips (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  year integer not null,
  payer_name text,
  payer_address text,
  payment_amount integer default 0,
  withholding_tax integer default 0,
  social_insurance integer default 0,
  life_insurance_deduction integer default 0,
  earthquake_insurance_deduction integer default 0,
  housing_loan_deduction integer default 0,
  dependents_count integer default 0,
  image_url text,
  ocr_text text,
  created_at timestamptz default now()
);

-- ============================================================
-- Phase 5: 確定申告・e-Tax
-- ============================================================

create table if not exists tax_returns (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  year integer not null,
  return_type text default 'blue' check (return_type in ('blue', 'white')),
  status text default 'draft' check (status in ('draft', 'calculated', 'submitted')),

  -- 収入
  revenue_total integer default 0,
  -- 経費
  expense_total integer default 0,
  -- 所得
  income_total integer default 0,

  -- 所得控除
  basic_deduction integer default 480000,
  social_insurance_deduction integer default 0,
  life_insurance_deduction integer default 0,
  earthquake_insurance_deduction integer default 0,
  spouse_deduction integer default 0,
  dependents_deduction integer default 0,
  medical_deduction integer default 0,
  small_business_deduction integer default 0,
  blue_special_deduction integer default 650000,

  -- 税額計算
  taxable_income integer default 0,
  income_tax integer default 0,
  reconstruction_tax integer default 0,
  withholding_total integer default 0,
  tax_due integer default 0,

  -- 消費税
  consumption_tax_amount integer default 0,
  consumption_tax_type text default 'exempt' check (consumption_tax_type in ('exempt', 'simplified', 'standard', 'invoice')),

  -- マイナンバー
  my_number_encrypted text,

  -- e-Tax送信
  etax_submission_id text,
  etax_submitted_at timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 確定申告の経費内訳
create table if not exists tax_return_expenses (
  id uuid default gen_random_uuid() primary key,
  tax_return_id uuid references tax_returns(id) on delete cascade not null,
  account_code text not null,
  account_name text not null,
  amount integer default 0
);

-- ============================================================
-- RLS
-- ============================================================

alter table bank_accounts enable row level security;
alter table bank_transactions enable row level security;
alter table withholding_slips enable row level security;
alter table tax_returns enable row level security;
alter table tax_return_expenses enable row level security;

create policy "Users can manage own bank_accounts" on bank_accounts
  for all using (auth.uid() = user_id);
create policy "Users can manage own bank_transactions" on bank_transactions
  for all using (auth.uid() = user_id);
create policy "Users can manage own withholding_slips" on withholding_slips
  for all using (auth.uid() = user_id);
create policy "Users can manage own tax_returns" on tax_returns
  for all using (auth.uid() = user_id);
create policy "Users can manage own tax_return_expenses" on tax_return_expenses
  for all using (
    tax_return_id in (select id from tax_returns where user_id = auth.uid())
  );

-- インデックス
create index idx_bank_transactions_account on bank_transactions(bank_account_id, date);
create index idx_bank_transactions_user on bank_transactions(user_id, date);
create index idx_withholding_slips_user on withholding_slips(user_id, year);
create index idx_tax_returns_user on tax_returns(user_id, year);
