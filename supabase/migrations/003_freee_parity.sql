-- ============================================================
-- Phase 7: freeeキャッチアップ
--   - 税区分マスタ
--   - 取引先・品目・部門・メモタグ（管理項目）
--   - 仕訳行の拡張（税区分・取引先 etc）
--   - 家事按分
--   - 固定資産台帳
--   - 自動登録ルール
--   - 受領書類のタブ・重複ハッシュ
-- ============================================================

-- ------------------------------------------------------------
-- 1. 税区分マスタ
-- ------------------------------------------------------------
create table if not exists tax_classes (
  code text primary key,
  name text not null,
  rate numeric(5,2) not null default 0,           -- 例: 10.00 / 8.00 / 0
  kind text not null check (kind in ('taxable_sales','taxable_purchase','export','exempt','non_taxable','out_of_scope')),
  reduced boolean not null default false,         -- 軽減税率対象か
  sort_order integer not null default 0
);

insert into tax_classes (code, name, rate, kind, reduced, sort_order) values
  ('OUT',   '対象外',           0,  'out_of_scope',     false, 10),
  ('NT',    '不課税',           0,  'non_taxable',      false, 20),
  ('EXM',   '非課税',           0,  'exempt',           false, 30),
  ('EXP',   '輸出免税',         0,  'export',           false, 40),
  ('S10',   '課税売上10%',     10,  'taxable_sales',    false, 50),
  ('S08R',  '課税売上8%(軽)',   8,  'taxable_sales',    true,  60),
  ('S08',   '課税売上8%',       8,  'taxable_sales',    false, 70),
  ('P10',   '課対仕入10%',     10,  'taxable_purchase', false, 80),
  ('P08R',  '課対仕入8%(軽)',   8,  'taxable_purchase', true,  90),
  ('P08',   '課対仕入8%',       8,  'taxable_purchase', false,100)
on conflict (code) do nothing;

-- ------------------------------------------------------------
-- 2. 管理項目マスタ（取引先・品目・部門・メモタグ）
-- ------------------------------------------------------------
create table if not exists partners (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  name_kana text,
  registered_number text,        -- インボイス登録番号 T+13桁
  is_customer boolean default true,
  is_vendor boolean default true,
  email text,
  phone text,
  address text,
  default_account_code text,
  notes text,
  created_at timestamptz default now()
);

create table if not exists items (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  shortcut1 text,
  shortcut2 text,
  created_at timestamptz default now()
);

create table if not exists departments (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  parent_id uuid references departments(id) on delete set null,
  created_at timestamptz default now()
);

create table if not exists memo_tags (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null unique,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- 3. 仕訳行の拡張
-- ------------------------------------------------------------
alter table journal_lines
  add column if not exists tax_code text references tax_classes(code),
  add column if not exists tax_amount integer default 0,
  add column if not exists partner_id uuid references partners(id) on delete set null,
  add column if not exists item_id uuid references items(id) on delete set null,
  add column if not exists department_id uuid references departments(id) on delete set null,
  add column if not exists memo text;

-- 仕訳ヘッダの拡張
alter table journals
  add column if not exists number text,             -- 任意の管理番号
  add column if not exists is_adjustment boolean default false; -- 決算整理仕訳

-- ------------------------------------------------------------
-- 4. 家事按分
-- ------------------------------------------------------------
create table if not exists biz_allocations (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  account_code text not null,
  account_name text not null,
  item_id uuid references items(id) on delete set null,
  business_ratio integer not null check (business_ratio between 0 and 100),
  fiscal_year integer not null,
  last_calculated_at timestamptz,
  generated_journal_id uuid references journals(id) on delete set null,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- 5. 固定資産台帳
-- ------------------------------------------------------------
create table if not exists fixed_assets (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  asset_account_code text not null,         -- 工具器具備品 / 建物 / 土地 など
  acquisition_date date not null,
  acquisition_cost integer not null,
  useful_life_years integer,                -- 償却なしの場合 NULL
  depreciation_method text default 'straight_line' check (depreciation_method in ('straight_line','declining_balance','none')),
  business_ratio integer default 100 check (business_ratio between 0 and 100),
  residual_value integer default 0,
  status text default 'active' check (status in ('active','disposed','sold')),
  disposed_at date,
  notes text,
  created_at timestamptz default now()
);

-- 期別の償却履歴
create table if not exists fixed_asset_depreciations (
  id uuid default gen_random_uuid() primary key,
  fixed_asset_id uuid references fixed_assets(id) on delete cascade not null,
  fiscal_year integer not null,
  depreciation_amount integer not null,
  book_value_after integer not null,
  posted_journal_id uuid references journals(id) on delete set null,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- 6. 自動登録ルール
-- ------------------------------------------------------------
create table if not exists auto_rules (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  -- マッチ条件
  bank_account_id uuid references bank_accounts(id) on delete cascade,
  is_income boolean,                          -- NULL = 両方
  match_text text not null,
  match_type text default 'contains' check (match_type in ('contains','starts','equals','regex')),
  amount_min integer,
  amount_max integer,
  priority integer default 0,
  -- アクション
  action_type text default 'suggest_journal' check (action_type in ('suggest_journal','suggest_transfer','ignore')),
  account_code text,
  account_name text,
  tax_code text references tax_classes(code),
  partner_id uuid references partners(id) on delete set null,
  -- 学習
  applied_count integer default 0,
  accepted_count integer default 0,
  is_enabled boolean default true,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- 7. 受領書類（ファイルボックス）の拡張
-- ------------------------------------------------------------
alter table receipts
  add column if not exists doc_type text default 'receipt' check (doc_type in ('receipt','invoice','other')),
  add column if not exists file_hash text,                -- 重複検知用
  add column if not exists tax_code text references tax_classes(code),
  add column if not exists partner_id uuid references partners(id) on delete set null,
  add column if not exists tax_amount integer default 0,
  add column if not exists registered boolean default false; -- 仕訳に紐付けたか

create index if not exists idx_receipts_hash on receipts(user_id, file_hash);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table partners                  enable row level security;
alter table items                     enable row level security;
alter table departments               enable row level security;
alter table memo_tags                 enable row level security;
alter table biz_allocations           enable row level security;
alter table fixed_assets              enable row level security;
alter table fixed_asset_depreciations enable row level security;
alter table auto_rules                enable row level security;

create policy "Users can manage own partners"     on partners     for all using (auth.uid() = user_id);
create policy "Users can manage own items"        on items        for all using (auth.uid() = user_id);
create policy "Users can manage own departments"  on departments  for all using (auth.uid() = user_id);
create policy "Users can manage own memo_tags"    on memo_tags    for all using (auth.uid() = user_id);
create policy "Users can manage own biz_allocs"   on biz_allocations for all using (auth.uid() = user_id);
create policy "Users can manage own fixed_assets" on fixed_assets for all using (auth.uid() = user_id);
create policy "Users can manage own fa_depr"      on fixed_asset_depreciations for all using (
  fixed_asset_id in (select id from fixed_assets where user_id = auth.uid())
);
create policy "Users can manage own auto_rules"   on auto_rules   for all using (auth.uid() = user_id);

-- 税区分は読み取り専用マスタなので全員参照可
alter table tax_classes enable row level security;
create policy "tax_classes readable" on tax_classes for select using (true);

-- インデックス
create index if not exists idx_partners_user      on partners(user_id);
create index if not exists idx_items_user         on items(user_id);
create index if not exists idx_departments_user   on departments(user_id);
create index if not exists idx_biz_allocs_user_fy on biz_allocations(user_id, fiscal_year);
create index if not exists idx_fixed_assets_user  on fixed_assets(user_id);
create index if not exists idx_auto_rules_user    on auto_rules(user_id);
create index if not exists idx_journal_lines_partner on journal_lines(partner_id);
create index if not exists idx_journal_lines_tax  on journal_lines(tax_code);
