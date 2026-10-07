-- 0031 新加的两条外键处在「删公司」的级联闭包里，却既不是 cascade 也不是
-- 延迟检查，违反了 tests/db/rls-matrix.test.ts 钉住的那条规则（0022 末尾
-- 同一条断言）：闭包内的外键要么级联，要么延迟到提交时检查，删公司才不会
-- 因为表之间的删除先后顺序而中途失败。
--
-- on delete set null 的语义不变，只是改成 deferrable initially deferred，
-- 与仓库里其余同类外键一致。

alter table bills
  alter constraint bills_purchase_order_id_fkey deferrable initially deferred;

alter table fixed_assets
  alter constraint fixed_assets_disposal_transaction_id_fkey deferrable initially deferred;
