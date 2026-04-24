-- 領収書テーブル
create table if not exists receipts (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  image_url text not null,
  ocr_text text,
  vendor_name text,
  amount integer,
  date date,
  account_code text,
  account_name text,
  status text default 'pending' check (status in ('pending', 'processed', 'confirmed')),
  created_at timestamptz default now()
);

-- 仕訳テーブル
create table if not exists journals (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  date date not null,
  description text not null,
  receipt_id uuid references receipts(id) on delete set null,
  created_at timestamptz default now()
);

-- 仕訳明細テーブル（複式簿記）
create table if not exists journal_lines (
  id uuid default gen_random_uuid() primary key,
  journal_id uuid references journals(id) on delete cascade not null,
  account_code text not null,
  account_name text not null,
  debit_amount integer default 0,
  credit_amount integer default 0
);

-- RLS (Row Level Security) 有効化
alter table receipts enable row level security;
alter table journals enable row level security;
alter table journal_lines enable row level security;

-- ユーザーは自分のデータのみアクセス可
create policy "Users can manage own receipts" on receipts
  for all using (auth.uid() = user_id);

create policy "Users can manage own journals" on journals
  for all using (auth.uid() = user_id);

create policy "Users can manage own journal lines" on journal_lines
  for all using (
    journal_id in (select id from journals where user_id = auth.uid())
  );

-- インデックス
create index idx_receipts_user_date on receipts(user_id, date);
create index idx_journals_user_date on journals(user_id, date);
create index idx_journal_lines_journal on journal_lines(journal_id);
