-- 枚举
create type membership_role as enum ('owner', 'admin', 'bookkeeper', 'viewer');
create type membership_status as enum ('active', 'invited', 'suspended');
create type account_type as enum ('asset', 'liability', 'equity', 'revenue', 'expense');
create type category_kind as enum ('income', 'expense');
create type transaction_kind as enum ('income', 'expense', 'transfer');
create type journal_direction as enum ('debit', 'credit');
create type rate_source as enum ('auto', 'manual');

-- 用户资料（登录身份由 Supabase auth.users 管理）
create table app_users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text not null,
  locale text not null default 'en' check (locale in ('en', 'zh')),
  avatar_url text,
  created_at timestamptz not null default now()
);

-- 公司
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$'),
  base_currency char(3) not null check (base_currency ~ '^[A-Z]{3}$'),
  timezone text not null default 'Asia/Kuala_Lumpur',
  industry text,
  locked_until date,
  plan text not null default 'free',
  trial_ends_at timestamptz,
  created_by uuid not null references app_users (id),
  created_at timestamptz not null default now()
);

-- 成员关系
create table memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  role membership_role not null,
  status membership_status not null default 'active',
  joined_at timestamptz not null default now(),
  unique (user_id, organization_id)
);

-- 每家公司只能有一个 owner
create unique index memberships_single_owner
  on memberships (organization_id)
  where role = 'owner';

create index memberships_by_user on memberships (user_id);

-- 邀请
create table invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  email text not null,
  role membership_role not null check (role <> 'owner'),
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  invited_by uuid not null references app_users (id),
  created_at timestamptz not null default now()
);

-- 同一公司同一邮箱只能有一个待处理邀请
create unique index invitations_pending_unique
  on invitations (organization_id, lower(email))
  where accepted_at is null and revoked_at is null;

-- 科目表
create table accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  code text not null,
  name_en text,
  name_zh text,
  type account_type not null,
  is_money_account boolean not null default false,
  is_system boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (organization_id, code),
  constraint accounts_name_present check (
    coalesce(nullif(btrim(name_en), ''), nullif(btrim(name_zh), '')) is not null
  ),
  constraint accounts_money_is_asset check (not is_money_account or type = 'asset')
);

create index accounts_by_org on accounts (organization_id, type, sort_order);

-- 用户可见的分类
create table categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name_en text,
  name_zh text,
  kind category_kind not null,
  account_id uuid not null references accounts (id),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint categories_name_present check (
    coalesce(nullif(btrim(name_en), ''), nullif(btrim(name_zh), '')) is not null
  )
);

create index categories_by_org on categories (organization_id, kind, sort_order);

-- 交易
create table transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  kind transaction_kind not null,
  occurred_on date not null,
  description text not null default '',
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint not null check (amount_minor > 0),
  base_amount_minor bigint not null check (base_amount_minor > 0),
  exchange_rate numeric(20, 8) not null check (exchange_rate > 0),
  rate_source rate_source not null default 'auto',
  category_id uuid references categories (id),
  created_by uuid not null references app_users (id),
  client_uuid uuid not null,
  voided_at timestamptz,
  voided_by uuid references app_users (id),
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, client_uuid),
  -- 转账没有分类，收支必须有分类
  constraint transactions_category_matches_kind check (
    (kind = 'transfer' and category_id is null)
    or (kind <> 'transfer' and category_id is not null)
  ),
  -- 作废三字段必须同时存在
  constraint transactions_void_fields_together check (
    (voided_at is null and voided_by is null and void_reason is null)
    or (voided_at is not null and voided_by is not null and btrim(coalesce(void_reason, '')) <> '')
  )
);

create index transactions_by_org_date on transactions (organization_id, occurred_on desc, created_at desc);
create index transactions_by_category on transactions (organization_id, category_id);
create index transactions_by_creator on transactions (organization_id, created_by);

-- 分录行
create table journal_lines (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  account_id uuid not null references accounts (id),
  direction journal_direction not null,
  amount_minor bigint not null check (amount_minor > 0),
  base_amount_minor bigint not null check (base_amount_minor > 0)
);

create index journal_lines_by_transaction on journal_lines (transaction_id);
create index journal_lines_by_account on journal_lines (organization_id, account_id);

-- 借贷平衡：延迟到事务提交时校验
create or replace function assert_journal_balanced()
returns trigger
language plpgsql
as $$
declare
  target_id uuid := coalesce(new.transaction_id, old.transaction_id);
  debit_total bigint;
  credit_total bigint;
  debit_base bigint;
  credit_base bigint;
begin
  -- 交易已被删除时无需校验
  if not exists (select 1 from transactions where id = target_id) then
    return null;
  end if;

  select
    coalesce(sum(amount_minor) filter (where direction = 'debit'), 0),
    coalesce(sum(amount_minor) filter (where direction = 'credit'), 0),
    coalesce(sum(base_amount_minor) filter (where direction = 'debit'), 0),
    coalesce(sum(base_amount_minor) filter (where direction = 'credit'), 0)
  into debit_total, credit_total, debit_base, credit_base
  from journal_lines
  where transaction_id = target_id;

  if debit_total = 0 and credit_total = 0 then
    raise exception 'Transaction % has no journal lines', target_id;
  end if;

  if debit_total <> credit_total then
    raise exception 'Transaction % is unbalanced: debit % <> credit %',
      target_id, debit_total, credit_total;
  end if;

  if debit_base <> credit_base then
    raise exception 'Transaction % is unbalanced in base currency: debit % <> credit %',
      target_id, debit_base, credit_base;
  end if;

  return null;
end;
$$;

create constraint trigger journal_lines_balanced
  after insert or update or delete on journal_lines
  deferrable initially deferred
  for each row
  execute function assert_journal_balanced();

-- 附件
create table attachments (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  uploaded_by uuid not null references app_users (id),
  created_at timestamptz not null default now()
);

create index attachments_by_transaction on attachments (transaction_id);

-- 汇率缓存（全局共享，非租户数据）
create table exchange_rates (
  id uuid primary key default gen_random_uuid(),
  base_currency char(3) not null check (base_currency ~ '^[A-Z]{3}$'),
  quote_currency char(3) not null check (quote_currency ~ '^[A-Z]{3}$'),
  rate numeric(20, 8) not null check (rate > 0),
  rate_date date not null,
  source text not null,
  fetched_at timestamptz not null default now(),
  unique (base_currency, quote_currency, rate_date)
);

create index exchange_rates_lookup on exchange_rates (base_currency, quote_currency, rate_date desc);

-- 审计日志（只增）
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  actor_user_id uuid references app_users (id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);

create index audit_logs_by_org on audit_logs (organization_id, created_at desc);
