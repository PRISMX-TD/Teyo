-- ============================================================
-- 0009: 税务 | 付款 | 贷项通知单 | 固定资产 | 库存 | 项目 | 采购订单 | 银行导入
-- ============================================================

-- 税率配置
create table tax_rates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name_en text not null,
  name_zh text not null,
  rate_bps integer not null check (rate_bps >= 0),
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table tax_rates enable row level security;
create policy "Tax rates: org isolation" on tax_rates for all
  using (organization_id = (select current_setting('app.current_org_id')::uuid))
  with check (organization_id = (select current_setting('app.current_org_id')::uuid));

-- 发票表加 partially_paid 状态
alter type invoice_status add value 'partially_paid';

-- 账单表加 partially_paid 状态
alter type bill_status add value 'partially_paid';

-- ============================================================
-- 付款追踪
-- ============================================================
create type payment_type as enum ('received', 'made');
create type payment_method as enum ('cash', 'bank_transfer', 'cheque', 'online', 'other');

create table payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  contact_id uuid not null references contacts(id),
  type payment_type not null,
  amount_minor bigint not null,
  currency text not null default 'USD',
  exchange_rate bigint not null default 100000000,
  base_amount_minor bigint not null,
  payment_date date not null,
  method payment_method not null default 'bank_transfer',
  reference text,
  notes text,
  transaction_id uuid references transactions(id),
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid not null references app_users(id)
);

alter table payments enable row level security;
create policy "Payments: org isolation" on payments for all
  using (organization_id = (select current_setting('app.current_org_id')::uuid))
  with check (organization_id = (select current_setting('app.current_org_id')::uuid));

create table payment_items (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id) on delete cascade,
  invoice_id uuid references invoices(id),
  bill_id uuid references bills(id),
  amount_minor bigint not null,
  constraint payment_items_one_target check (
    (invoice_id is not null and bill_id is null) or
    (invoice_id is null and bill_id is not null)
  )
);

alter table payment_items enable row level security;
create policy "Payment items: org isolation" on payment_items for all
  using (payment_id in (
    select id from payments
    where organization_id = (select current_setting('app.current_org_id')::uuid)
  ));

-- ============================================================
-- 贷项通知单
-- ============================================================
create type credit_note_status as enum ('draft', 'issued', 'applied', 'voided');

create table credit_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  invoice_id uuid references invoices(id),
  contact_id uuid not null references contacts(id),
  cn_number text not null,
  status credit_note_status not null default 'draft',
  issue_date date not null,
  currency text not null default 'USD',
  exchange_rate bigint not null default 100000000,
  base_amount_minor bigint not null,
  reason text,
  notes text,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid not null references app_users(id),
  constraint credit_notes_org_number unique (organization_id, cn_number)
);

alter table credit_notes enable row level security;
create policy "Credit notes: org isolation" on credit_notes for all
  using (organization_id = (select current_setting('app.current_org_id')::uuid))
  with check (organization_id = (select current_setting('app.current_org_id')::uuid));

create table credit_note_items (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references credit_notes(id) on delete cascade,
  description text not null,
  quantity numeric(12,4) not null default 1,
  unit_price_minor bigint not null,
  amount_minor bigint not null,
  tax_rate_id uuid references tax_rates(id)
);

alter table credit_note_items enable row level security;
create policy "CN items: org isolation" on credit_note_items for all
  using (credit_note_id in (
    select id from credit_notes
    where organization_id = (select current_setting('app.current_org_id')::uuid)
  ));

-- ============================================================
-- 固定资产
-- ============================================================
create type depreciation_method as enum ('straight_line', 'declining_balance');

create table fixed_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name text not null,
  description text,
  purchase_date date not null,
  cost_minor bigint not null,
  salvage_value_minor bigint not null default 0,
  useful_life_months integer not null check (useful_life_months > 0),
  method depreciation_method not null default 'straight_line',
  declining_rate_bps integer,  -- 余额递减法的百分比 (e.g. 20000 = 200%)
  asset_account_id uuid not null references accounts(id),
  depn_expense_account_id uuid not null references accounts(id),
  depn_accum_account_id uuid not null references accounts(id),
  is_active boolean not null default true,
  disposed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table fixed_assets enable row level security;
create policy "Fixed assets: org isolation" on fixed_assets for all
  using (organization_id = (select current_setting('app.current_org_id')::uuid))
  with check (organization_id = (select current_setting('app.current_org_id')::uuid));

create table depreciation_schedules (
  id uuid primary key default gen_random_uuid(),
  fixed_asset_id uuid not null references fixed_assets(id) on delete cascade,
  period date not null,  -- YYYY-MM-01
  depreciation_minor bigint not null,
  accumulated_minor bigint not null,
  book_value_minor bigint not null,
  is_posted boolean not null default false,
  transaction_id uuid references transactions(id),
  constraint depn_schedule_asset_period unique (fixed_asset_id, period)
);

alter table depreciation_schedules enable row level security;
create policy "Depn schedules: org isolation" on depreciation_schedules for all
  using (fixed_asset_id in (
    select id from fixed_assets
    where organization_id = (select current_setting('app.current_org_id')::uuid)
  ));

-- ============================================================
-- 库存管理
-- ============================================================
create type cost_method as enum ('fifo', 'average');

create table inventory_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  sku text not null,
  name_en text not null,
  name_zh text not null,
  unit text not null default 'pcs',
  cost_method cost_method not null default 'average',
  current_quantity numeric(12,4) not null default 0,
  current_avg_cost_minor bigint not null default 0,
  reorder_level numeric(12,4) not null default 0,
  cogs_account_id uuid references accounts(id),
  inventory_account_id uuid references accounts(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint inventory_org_sku unique (organization_id, sku)
);

alter table inventory_items enable row level security;
create policy "Inventory items: org isolation" on inventory_items for all
  using (organization_id = (select current_setting('app.current_org_id')::uuid))
  with check (organization_id = (select current_setting('app.current_org_id')::uuid));

create type inventory_txn_type as enum ('purchase', 'sale', 'adjustment', 'return');

create table inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  inventory_item_id uuid not null references inventory_items(id),
  type inventory_txn_type not null,
  quantity numeric(12,4) not null,
  unit_cost_minor bigint not null,
  total_cost_minor bigint not null,
  reference_type text,
  reference_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid not null references app_users(id)
);

alter table inventory_transactions enable row level security;
create policy "Inventory txns: org isolation" on inventory_transactions for all
  using (organization_id = (select current_setting('app.current_org_id')::uuid))
  with check (organization_id = (select current_setting('app.current_org_id')::uuid));

-- ============================================================
-- 项目 / 成本核算
-- ============================================================
create type project_status as enum ('active', 'completed', 'cancelled');

create table projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name text not null,
  description text,
  contact_id uuid references contacts(id),
  status project_status not null default 'active',
  budget_minor bigint,
  start_date date,
  end_date date,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table projects enable row level security;
create policy "Projects: org isolation" on projects for all
  using (organization_id = (select current_setting('app.current_org_id')::uuid))
  with check (organization_id = (select current_setting('app.current_org_id')::uuid));

-- 交易表加 project_id
alter table transactions add column project_id uuid references projects(id);

-- ============================================================
-- 采购订单
-- ============================================================
create type po_status as enum ('draft', 'sent', 'received', 'billed', 'closed', 'voided');

create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  contact_id uuid not null references contacts(id),
  po_number text not null,
  status po_status not null default 'draft',
  issue_date date not null,
  expected_date date,
  currency text not null default 'USD',
  exchange_rate bigint not null default 100000000,
  base_total_minor bigint not null default 0,
  notes text,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid not null references app_users(id),
  constraint po_org_number unique (organization_id, po_number)
);

alter table purchase_orders enable row level security;
create policy "PO: org isolation" on purchase_orders for all
  using (organization_id = (select current_setting('app.current_org_id')::uuid))
  with check (organization_id = (select current_setting('app.current_org_id')::uuid));

create table po_items (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references purchase_orders(id) on delete cascade,
  description text not null,
  quantity numeric(12,4) not null default 1,
  unit_price_minor bigint not null,
  amount_minor bigint not null,
  tax_rate_id uuid references tax_rates(id)
);

alter table po_items enable row level security;
create policy "PO items: org isolation" on po_items for all
  using (po_id in (
    select id from purchase_orders
    where organization_id = (select current_setting('app.current_org_id')::uuid)
  ));

-- ============================================================
-- 银行交易导入
-- ============================================================
create type import_source as enum ('csv', 'ofx', 'qif');
create type import_status as enum ('pending', 'matched', 'ignored');

create table imported_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  money_account_id uuid not null references accounts(id),
  source import_source not null,
  raw_data jsonb not null default '{}',
  transaction_date date not null,
  description text,
  amount_minor bigint not null,
  matched_transaction_id uuid references transactions(id),
  status import_status not null default 'pending',
  created_at timestamptz not null default now(),
  created_by uuid not null references app_users(id)
);

alter table imported_transactions enable row level security;
create policy "Imported txns: org isolation" on imported_transactions for all
  using (organization_id = (select current_setting('app.current_org_id')::uuid))
  with check (organization_id = (select current_setting('app.current_org_id')::uuid));

-- ============================================================
-- 索引
-- ============================================================
create index idx_payments_org_contact on payments(organization_id, contact_id);
create index idx_payments_date on payments(organization_id, payment_date);
create index idx_credit_notes_org_invoice on credit_notes(organization_id, invoice_id);
create index idx_fixed_assets_org on fixed_assets(organization_id);
create index idx_depreciation_asset on depreciation_schedules(fixed_asset_id);
create index idx_inventory_items_org on inventory_items(organization_id);
create index idx_inventory_txns_item on inventory_transactions(inventory_item_id);
create index idx_projects_org on projects(organization_id);
create index idx_purchase_orders_org_contact on purchase_orders(organization_id, contact_id);
create index idx_imported_txns_org on imported_transactions(organization_id);
