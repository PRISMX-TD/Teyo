-- 0010: Fix RLS policies for tables created in 0008 and 0009
-- These were using current_setting('app.current_org_id') which is never set.
-- Existing tables use app_is_member(organization_id) and app_has_role().

-- ===== 0008 tables =====

-- contacts
drop policy if exists "Contacts: org isolation" on contacts;
create policy "Contacts: org isolation" on contacts for all
  using (app_is_member(organization_id))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

-- invoices
drop policy if exists "Invoices: org isolation" on invoices;
create policy "Invoices: org isolation" on invoices for all
  using (app_is_member(organization_id))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

drop policy if exists "Invoice items: org isolation" on invoice_items;
create policy "Invoice items: org isolation" on invoice_items for all
  using (invoice_id in (select id from invoices where app_is_member(organization_id)))
  with check (invoice_id in (select id from invoices where app_has_role(organization_id, array['owner', 'admin']::membership_role[])));

-- bills
drop policy if exists "Bills: org isolation" on bills;
create policy "Bills: org isolation" on bills for all
  using (app_is_member(organization_id))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

drop policy if exists "Bill items: org isolation" on bill_items;
create policy "Bill items: org isolation" on bill_items for all
  using (bill_id in (select id from bills where app_is_member(organization_id)))
  with check (bill_id in (select id from bills where app_has_role(organization_id, array['owner', 'admin']::membership_role[])));

-- bank_reconciliations
drop policy if exists "Bank recons: org isolation" on bank_reconciliations;
create policy "Bank recons: org isolation" on bank_reconciliations for all
  using (app_is_member(organization_id))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

drop policy if exists "Recon items: org isolation" on reconciliation_items;
create policy "Recon items: org isolation" on reconciliation_items for all
  using (reconciliation_id in (select id from bank_reconciliations where app_is_member(organization_id)))
  with check (reconciliation_id in (select id from bank_reconciliations where app_has_role(organization_id, array['owner', 'admin']::membership_role[])));

-- recurring_transactions
drop policy if exists "Recurring txns: org isolation" on recurring_transactions;
create policy "Recurring txns: org isolation" on recurring_transactions for all
  using (app_is_member(organization_id))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

-- budgets
drop policy if exists "Budgets: org isolation" on budgets;
create policy "Budgets: org isolation" on budgets for all
  using (app_is_member(organization_id))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

-- ===== 0009 tables =====

-- tax_rates
drop policy if exists "Tax rates: org isolation" on tax_rates;
create policy "Tax rates: org isolation" on tax_rates for all
  using (app_is_member(organization_id))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

-- payments
drop policy if exists "Payments: org isolation" on payments;
create policy "Payments: org isolation" on payments for all
  using (app_is_member(organization_id))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

drop policy if exists "Payment items: org isolation" on payment_items;
create policy "Payment items: org isolation" on payment_items for all
  using (payment_id in (select id from payments where app_is_member(organization_id)))
  with check (payment_id in (select id from payments where app_has_role(organization_id, array['owner', 'admin']::membership_role[])));

-- credit_notes
drop policy if exists "Credit notes: org isolation" on credit_notes;
create policy "Credit notes: org isolation" on credit_notes for all
  using (app_is_member(organization_id))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

drop policy if exists "CN items: org isolation" on credit_note_items;
create policy "CN items: org isolation" on credit_note_items for all
  using (credit_note_id in (select id from credit_notes where app_is_member(organization_id)))
  with check (credit_note_id in (select id from credit_notes where app_has_role(organization_id, array['owner', 'admin']::membership_role[])));

-- fixed_assets
drop policy if exists "Fixed assets: org isolation" on fixed_assets;
create policy "Fixed assets: org isolation" on fixed_assets for all
  using (app_is_member(organization_id))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

drop policy if exists "Depn schedules: org isolation" on depreciation_schedules;
create policy "Depn schedules: org isolation" on depreciation_schedules for all
  using (fixed_asset_id in (select id from fixed_assets where app_is_member(organization_id)))
  with check (fixed_asset_id in (select id from fixed_assets where app_has_role(organization_id, array['owner', 'admin']::membership_role[])));

-- inventory_items
drop policy if exists "Inventory items: org isolation" on inventory_items;
create policy "Inventory items: org isolation" on inventory_items for all
  using (app_is_member(organization_id))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

drop policy if exists "Inventory txns: org isolation" on inventory_transactions;
create policy "Inventory txns: org isolation" on inventory_transactions for all
  using (app_is_member(organization_id))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

-- projects
drop policy if exists "Projects: org isolation" on projects;
create policy "Projects: org isolation" on projects for all
  using (app_is_member(organization_id))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

-- purchase_orders
drop policy if exists "PO: org isolation" on purchase_orders;
create policy "PO: org isolation" on purchase_orders for all
  using (app_is_member(organization_id))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

drop policy if exists "PO items: org isolation" on po_items;
create policy "PO items: org isolation" on po_items for all
  using (po_id in (select id from purchase_orders where app_is_member(organization_id)))
  with check (po_id in (select id from purchase_orders where app_has_role(organization_id, array['owner', 'admin']::membership_role[])));

-- imported_transactions
drop policy if exists "Imported txns: org isolation" on imported_transactions;
create policy "Imported txns: org isolation" on imported_transactions for all
  using (app_is_member(organization_id))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));
