-- 0018: Add suspense category for the not-sure scenario.
--
-- The not-sure scenario routes uncertain transactions to the suspense account
-- with no preset transaction kind (income vs expense). Task 14 will resolve the
-- defaultAccountCode to a category id, which requires an existing category row.
--
-- This migration backfills the suspense category for existing organizations,
-- mirroring how 0015 backfilled the purchases category.

-- Backfill existing organizations: add suspense category
insert into categories (organization_id, name_en, name_zh, kind, account_id, sort_order)
select a.organization_id, 'Unsorted', '待确认', 'expense', a.id, 103
from accounts a
where a.code = 'suspense'
  and not exists (
    select 1 from categories c
    where c.organization_id = a.organization_id and c.account_id = a.id
  );
