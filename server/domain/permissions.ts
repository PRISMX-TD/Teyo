export type Role = 'owner' | 'admin' | 'bookkeeper' | 'viewer';
export type MembershipStatus = 'active' | 'invited' | 'suspended';

export const ROLES: readonly Role[] = ['owner', 'admin', 'bookkeeper', 'viewer'] as const;

/**
 * 注意 `suspended` 不是角色而是成员状态（memberships.status）。
 * 停权的成员在数据库层根本进不来：app_is_member / app_has_role 都带
 * `and m.status = 'active'`，所以本文件不需要、也不应该为它留一行矩阵。
 */

export type Action =
  // ============================================================
  // 0002 以来就有的 12 个动作
  // ============================================================
  // 这一组被 112 处 requirePermission 引用（`grep -rn "requirePermission\|can(" server/ app/`），
  // 只能新增、不能删除或改名。下面新增的动作是对它们的补充而不是替代。
  | 'transaction:read'
  | 'transaction:create'
  | 'transaction:edit:own'
  | 'transaction:edit:any'
  | 'report:export'
  | 'account:manage'
  | 'category:manage'
  | 'member:manage'
  | 'audit:read'
  | 'period:lock'
  | 'organization:transfer'
  | 'organization:delete'
  // ============================================================
  // 0022 新增：0008/0009 那 22 张表的动作
  // ============================================================
  // 在此之前，「谁能对发票做什么」在代码里没有任何一处可查：应用层
  // server/actions/invoices.ts 用的是 transaction:read（viewer 也有），
  // 真正的闸门只在 0010 那条 `for all` 策略的 with check 里。于是同一个问题
  // 有两个互相不知道对方存在的答案，而且其中一个还只对 INSERT/UPDATE 生效
  // （DELETE 不看 with check——这就是 0022 要修的 P0）。
  //
  // 这五个动作的存在意义是让 0022 的迁移与这里逐字对应：迁移里每一条
  // app_has_role(...) 的角色数组，都必须等于 rolesFor(对应 Action)。
  | 'document:read'
  | 'document:create'
  | 'document:edit'
  | 'document:delete'
  | 'masterdata:manage';

const MATRIX: Record<Role, readonly Action[]> = {
  owner: [
    'transaction:read',
    'transaction:create',
    'transaction:edit:own',
    'transaction:edit:any',
    'report:export',
    'account:manage',
    'category:manage',
    'member:manage',
    'audit:read',
    'period:lock',
    'organization:transfer',
    'organization:delete',
    'document:read',
    'document:create',
    'document:edit',
    'masterdata:manage',
  ],
  admin: [
    'transaction:read',
    'transaction:create',
    'transaction:edit:own',
    'transaction:edit:any',
    'report:export',
    'account:manage',
    'category:manage',
    'member:manage',
    'audit:read',
    'document:read',
    'document:create',
    'document:edit',
    'masterdata:manage',
  ],
  // 记账员能记收付款、开发票、录账单——这是这个角色的全部工作内容。
  // 0010 把这批表的写入限死在 owner/admin，导致记账员点「记录收款」时
  // 应用层放行（server/actions/payments.ts 要的是 transaction:create，
  // 记账员有）、数据库拒绝，用户看到的是一句裸的 Postgres 报错。
  bookkeeper: [
    'transaction:read',
    'transaction:create',
    'transaction:edit:own',
    'report:export',
    'document:read',
    'document:create',
    'document:edit',
  ],
  // report:export 给 viewer 是刻意的，不是疏忽：
  // viewer 已经有 transaction:read，报表页面本来就逐页可见全部财务数据，
  // 导出改变的是取数的方便程度，不是授权边界。真正该防的是「谁在什么时候
  // 导出了什么」无人知晓，而那由审计日志承担——server/actions/export.ts
  // 已经 recordAudit。把 report:export 从 viewer 拿掉只会让只读用户用截图和
  // 复制粘贴完成同一件事，同时失去审计记录里那一条 export 事件。
  viewer: ['transaction:read', 'report:export', 'document:read'],
};

export function can(role: Role, action: Action): boolean {
  return MATRIX[role].includes(action);
}

export function canEditTransaction(role: Role, isOwnRecord: boolean): boolean {
  if (can(role, 'transaction:edit:any')) return true;
  return isOwnRecord && can(role, 'transaction:edit:own');
}

/**
 * 某个动作允许哪些角色。顺序固定按 ROLES 排列，供 0022 的迁移与
 * tests/db/rls-matrix.test.ts 逐字比对数据库策略里的角色数组。
 *
 * document:delete 会返回空数组——这是有意的，见下面 TABLE_ACCESS 的注释。
 */
export function rolesFor(action: Action): readonly Role[] {
  return ROLES.filter((role) => can(role, action));
}

// ============================================================
// 表 × 动作：数据库策略的单一事实来源
// ============================================================

export type Command = 'select' | 'insert' | 'update' | 'delete';

export type TableAccess = {
  readonly select: Action;
  readonly insert: Action;
  readonly update: Action;
  /**
   * delete 取 'document:delete' 时表示**不建 delete 策略**。
   *
   * 该动作的角色集合是空的，这不是填错：0002 对 transactions 就是这么做的
   * （「不提供 delete 策略：软删除通过 update 完成，硬删除在数据库层就不可能」）。
   * 把「谁都不行」写成一个有名字的动作，好处是它在类型系统里是一个可断言的值，
   * 而不是一个需要靠注释解释的 undefined。
   */
  readonly delete: Action;
  /**
   * 明细表没有自己的 organization_id，其策略经父表子查询约束。
   * 这一列存在是为了让迁移与测试都能从同一处知道父表是谁、外键叫什么，
   * 而不是各写一份。
   */
  readonly parent?: { readonly table: string; readonly foreignKey: string };
};

/**
 * 0010 管辖的 22 张表。行数必须正好 22——tests/db/rls-matrix.test.ts 会把这里
 * 的表名与库里实际启用了 RLS 的表求差集，少一张就红，所以下次加表时漏登记
 * 会当场被发现，而不是悄悄沿用某条宽松策略。
 *
 * ------------------------------------------------------------
 * 为什么绝大多数表的 delete 是「谁都不行」
 * ------------------------------------------------------------
 * 不是按直觉分配的，是按 `grep -rn "delete from" server/` 的结果分配的。
 * 全仓对这 22 张表的硬删除只有五处：
 *
 *   server/repositories/invoices.ts:246        delete from invoice_items
 *   server/repositories/bills.ts:215           delete from bill_items
 *   server/repositories/purchase_orders.ts:180 delete from po_items
 *   server/repositories/credit_notes.ts:248    delete from credit_note_items
 *   server/repositories/bank_import.ts:157     delete from imported_transactions
 *
 * 前四处是同一个模式：改单据时把明细整批删掉再重写。第五处是清理未匹配的
 * 导入暂存行。除此之外，这批表全部走软删除：
 *   - invoices / bills / payments / credit_notes / purchase_orders 有 voided_at
 *   - contacts / tax_rates / projects / inventory_items / fixed_assets /
 *     recurring_transactions 有 is_active
 *   - server/repositories/tax.ts 的 deleteTaxRate 名字叫 delete，实现是先查引用
 *     再 `update tax_rates set is_active = false`——连应用层都没打算真删。
 *
 * 所以主数据的 delete 也不给 owner/admin。给一个没有任何调用方的能力，换来的
 * 只是攻击面：真要硬删主数据，那个功能自己带一条迁移来，顺便把「引用还在时
 * 怎么办」一起想清楚。
 *
 * 明细表统一给 delete（哪怕 payment_items 今天没人删）：删了重写是明细表的
 * 通用模式，留一处例外只会让下一个人在加「编辑收款」时撞上一句裸的 RLS 报错，
 * 而那正是本次要根除的那类故障。
 */
export const TABLE_ACCESS: Readonly<Record<string, TableAccess>> = {
  // ---------- 主数据：owner/admin 维护，成员皆可读，谁都不能硬删 ----------
  contacts: {
    select: 'document:read',
    insert: 'masterdata:manage',
    update: 'masterdata:manage',
    delete: 'document:delete',
  },
  tax_rates: {
    select: 'document:read',
    insert: 'masterdata:manage',
    update: 'masterdata:manage',
    delete: 'document:delete',
  },
  projects: {
    select: 'document:read',
    insert: 'masterdata:manage',
    update: 'masterdata:manage',
    delete: 'document:delete',
  },
  inventory_items: {
    select: 'document:read',
    insert: 'masterdata:manage',
    update: 'masterdata:manage',
    delete: 'document:delete',
  },
  budgets: {
    select: 'document:read',
    insert: 'masterdata:manage',
    update: 'masterdata:manage',
    delete: 'document:delete',
  },
  fixed_assets: {
    select: 'document:read',
    insert: 'masterdata:manage',
    update: 'masterdata:manage',
    delete: 'document:delete',
  },
  // 折旧表是从固定资产派生出来的，不是用户直接录入的。
  // server/repositories/fixed_assets.ts:331 用 `insert ... on conflict do update`
  // 重算，所以重新生成不需要 delete。
  depreciation_schedules: {
    select: 'document:read',
    insert: 'masterdata:manage',
    update: 'masterdata:manage',
    delete: 'document:delete',
    parent: { table: 'fixed_assets', foreignKey: 'fixed_asset_id' },
  },

  // ---------- 单据：记账员可建可改，作废走 voided_at，不能硬删 ----------
  invoices: {
    select: 'document:read',
    insert: 'document:create',
    update: 'document:edit',
    delete: 'document:delete',
  },
  bills: {
    select: 'document:read',
    insert: 'document:create',
    update: 'document:edit',
    delete: 'document:delete',
  },
  payments: {
    select: 'document:read',
    insert: 'document:create',
    update: 'document:edit',
    delete: 'document:delete',
  },
  credit_notes: {
    select: 'document:read',
    insert: 'document:create',
    update: 'document:edit',
    delete: 'document:delete',
  },
  purchase_orders: {
    select: 'document:read',
    insert: 'document:create',
    update: 'document:edit',
    delete: 'document:delete',
  },
  bank_reconciliations: {
    select: 'document:read',
    insert: 'document:create',
    update: 'document:edit',
    delete: 'document:delete',
  },
  // 周期交易是「将来会生成分录」的模板，建它与建一笔交易是同一件事，
  // 所以 insert 跟单据走；停用用 is_active，不硬删。
  recurring_transactions: {
    select: 'document:read',
    insert: 'document:create',
    update: 'document:edit',
    delete: 'document:delete',
  },
  // 存货流水是库存的账，和分录一样只增不删。
  inventory_transactions: {
    select: 'document:read',
    insert: 'document:create',
    update: 'document:edit',
    delete: 'document:delete',
  },
  // 导入的银行流水是暂存数据，不是账；清理未匹配行是正常操作。
  imported_transactions: {
    select: 'document:read',
    insert: 'document:create',
    update: 'document:edit',
    delete: 'document:edit',
  },

  // ---------- 明细表：权限跟随父单据，删了重写是正常写入路径 ----------
  invoice_items: {
    select: 'document:read',
    insert: 'document:create',
    update: 'document:edit',
    delete: 'document:edit',
    parent: { table: 'invoices', foreignKey: 'invoice_id' },
  },
  bill_items: {
    select: 'document:read',
    insert: 'document:create',
    update: 'document:edit',
    delete: 'document:edit',
    parent: { table: 'bills', foreignKey: 'bill_id' },
  },
  po_items: {
    select: 'document:read',
    insert: 'document:create',
    update: 'document:edit',
    delete: 'document:edit',
    parent: { table: 'purchase_orders', foreignKey: 'po_id' },
  },
  payment_items: {
    select: 'document:read',
    insert: 'document:create',
    update: 'document:edit',
    delete: 'document:edit',
    parent: { table: 'payments', foreignKey: 'payment_id' },
  },
  credit_note_items: {
    select: 'document:read',
    insert: 'document:create',
    update: 'document:edit',
    delete: 'document:edit',
    parent: { table: 'credit_notes', foreignKey: 'credit_note_id' },
  },
  reconciliation_items: {
    select: 'document:read',
    insert: 'document:create',
    update: 'document:edit',
    delete: 'document:edit',
    parent: { table: 'bank_reconciliations', foreignKey: 'reconciliation_id' },
  },

  // ---------- 年结 ----------
  //
  // 与上面所有表都不同的一张：它**没有 update 策略**，而且这是有意的。
  // 一次年结的内容（期间、净利润、产生的那笔分录）在它发生的那一刻就
  // 定死了；要改只能撤销重做，而撤销是 delete。允许 update 等于允许把
  // 「去年结转了多少利润」事后改成另一个数字，而对应的分录一动不动。
  //
  // update 取 'document:delete' 这个空角色集合的哨兵值——含义与 delete 那
  // 一列上的用法相同：不建这条策略。0024 末尾有一条断言钉住了这件事
  // （fiscal_year_closings 不得有 UPDATE 或 FOR ALL 策略）。
  //
  // insert/delete 用 period:lock 而不是新造一个 Action：两者都是 owner 独有，
  // 而且做的是同一类事——把某一段时间的账定下来/放开。年结之后通常紧接着
  // 就是把那个期间封掉。
  fiscal_year_closings: {
    select: 'document:read',
    insert: 'period:lock',
    update: 'document:delete',
    delete: 'period:lock',
  },
};

/**
 * 0002 自己管辖、且谓词不是纯角色判断的表。
 *
 * 它们不在 TABLE_ACCESS 里不是漏了，而是它们的策略含行级条件，压不进
 * 「表 × 动作 → 角色集合」这个形状：
 *   transactions   bookkeeper 只能改 created_by = 自己的行
 *   memberships    自己的记录永远可读；接受邀请时可以插自己那一行
 *   organizations  insert 的条件是 created_by = 自己，与角色无关
 *   app_users      本人可写，同公司可读
 *   audit_logs     不可改删由表权限（revoke update, delete）保证，不是策略
 *   exchange_rates 全局共享数据，与组织无关
 * 这些由 tests/db/rls.test.ts 覆盖。
 *
 * 这个清单存在的唯一目的，是让 rls-matrix 的覆盖率断言可以是全称的：
 * 库里每一张启用了 RLS 的表，要么在 TABLE_ACCESS 里，要么在这里。
 */
export const ROW_LEVEL_TABLES: readonly string[] = [
  'app_users',
  'organizations',
  'memberships',
  'invitations',
  'accounts',
  'categories',
  'transactions',
  'journal_lines',
  'attachments',
  'exchange_rates',
  'audit_logs',
] as const;
