-- 联系人（客户 / 供应商）
create type contact_type as enum ('customer', 'vendor', 'both');

create table contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  type contact_type not null,
  name text not null,
  email text,
  phone text,
  address text,
  tax_id text,
  payment_terms text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table contacts enable row level security;
create policy "Contacts: org isolation" on contacts for all
  using (organization_id = (select current_setting('app.current_org_id')::uuid))
  with check (organization_id = (select current_setting('app.current_org_id')::uuid));

-- 发票
create type invoice_status as enum ('draft', 'sent', 'paid', 'overdue', 'voided');

create table invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  contact_id uuid not null references contacts(id),
  invoice_number text not null,
  status invoice_status not null default 'draft',
  issue_date date not null,
  due_date date not null,
  currency text not null default 'USD',
  subtotal_minor bigint not null default 0,
  tax_rate_bps integer not null default 0,
  tax_minor bigint not null default 0,
  total_minor bigint not null default 0,
  notes text,
  transaction_id uuid references transactions(id),
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoices_org_number unique (organization_id, invoice_number)
);

alter table invoices enable row level security;
create policy "Invoices: org isolation" on invoices for all
  using (organization_id = (select current_setting('app.current_org_id')::uuid))
  with check (organization_id = (select current_setting('app.current_org_id')::uuid));

create table invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  description text not null,
  quantity numeric(12,4) not null default 1,
  unit_price_minor bigint not null,
  amount_minor bigint not null
);

alter table invoice_items enable row level security;
create policy "Invoice items: org isolation" on invoice_items for all
  using (invoice_id in (
    select id from invoices
    where organization_id = (select current_setting('app.current_org_id')::uuid)
  ));

-- 账单（应付）
create type bill_status as enum ('draft', 'received', 'paid', 'overdue', 'voided');

create table bills (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  contact_id uuid not null references contacts(id),
  bill_number text,
  status bill_status not null default 'received',
  issue_date date not null,
  due_date date not null,
  currency text not null default 'USD',
  total_minor bigint not null default 0,
  notes text,
  transaction_id uuid references transactions(id),
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bills_org_number unique (organization_id, bill_number)
);

alter table bills enable row level security;
create policy "Bills: org isolation" on bills for all
  using (organization_id = (select current_setting('app.current_org_id')::uuid))
  with check (organization_id = (select current_setting('app.current_org_id')::uuid));

create table bill_items (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills(id) on delete cascade,
  description text not null,
  amount_minor bigint not null
);

alter table bill_items enable row level security;
create policy "Bill items: org isolation" on bill_items for all
  using (bill_id in (
    select id from bills
    where organization_id = (select current_setting('app.current_org_id')::uuid)
  ));

-- 银行对账
create table bank_reconciliations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  money_account_id uuid not null references accounts(id),
  statement_date date not null,
  statement_balance_minor bigint not null,
  reconciled_at timestamptz,
  created_by uuid not null references app_users(id),
  created_at timestamptz not null default now()
);

alter table bank_reconciliations enable row level security;
create policy "Reconciliations: org isolation" on bank_reconciliations for all
  using (organization_id = (select current_setting('app.current_org_id')::uuid))
  with check (organization_id = (select current_setting('app.current_org_id')::uuid));

create table reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null references bank_reconciliations(id) on delete cascade,
  transaction_id uuid references transactions(id),
  is_cleared boolean not null default false,
  adjustment_minor bigint not null default 0,
  note text
);

alter table reconciliation_items enable row level security;
create policy "Rec items: org isolation" on reconciliation_items for all
  using (reconciliation_id in (
    select id from bank_reconciliations
    where organization_id = (select current_setting('app.current_org_id')::uuid)
  ));

-- 定期交易
create type recurrence_frequency as enum ('daily', 'weekly', 'monthly', 'quarterly', 'yearly');

create table recurring_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  kind transaction_kind not null,
  description text,
  amount text not null,
  currency text not null default 'USD',
  debit_account_id uuid not null references accounts(id),
  credit_account_id uuid not null references accounts(id),
  category_id uuid references categories(id),
  frequency recurrence_frequency not null default 'monthly',
  interval integer not null default 1,
  start_date date not null default current_date,
  end_date date,
  next_due_date date not null default current_date,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table recurring_transactions enable row level security;
create policy "Recurring: org isolation" on recurring_transactions for all
  using (organization_id = (select current_setting('app.current_org_id')::uuid))
  with check (organization_id = (select current_setting('app.current_org_id')::uuid));

-- 预算
create table budgets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  account_id uuid not null references accounts(id),
  year integer not null,
  month integer not null check (month between 1 and 12),
  budget_minor bigint not null default 0,
  constraint budgets_org_account_period unique (organization_id, account_id, year, month)
);

alter table budgets enable row level security;
create policy "Budgets: org isolation" on budgets for all
  using (organization_id = (select current_setting('app.current_org_id')::uuid))
  with check (organization_id = (select current_setting('app.current_org_id')::uuid));
