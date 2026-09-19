import { describe, expect, it } from 'vitest';
import {
  ROLES,
  ROW_LEVEL_TABLES,
  TABLE_ACCESS,
  can,
  rolesFor,
  type Action,
  type Role,
} from '@/server/domain/permissions';

/**
 * 这个文件锁的是**矩阵本身**，不是某个调用方。
 *
 * tests/domain/permissions.test.ts 已经覆盖了「viewer 不能建交易」这类
 * 用例。这里补的是另一件事：0022 的迁移把数据库策略的角色数组写死成了
 * 这份矩阵的投影，所以任何对矩阵的改动都等于改数据库。下面每一条断言
 * 都对应迁移里的一处硬编码，改矩阵而不改迁移会在这里当场变红。
 */

const LEGACY_ACTIONS = [
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
] as const satisfies readonly Action[];

describe('既有 12 个动作的角色集合', () => {
  // 这 12 个被 112 处 requirePermission 引用（server/actions/ 下几乎每个文件）。
  // 逐条钉死，是为了让「为了让新表通过而顺手放宽了某个老动作」这种改动
  // 无法悄悄发生。
  const expected: Record<(typeof LEGACY_ACTIONS)[number], readonly Role[]> = {
    'transaction:read': ['owner', 'admin', 'bookkeeper', 'viewer'],
    'transaction:create': ['owner', 'admin', 'bookkeeper'],
    'transaction:edit:own': ['owner', 'admin', 'bookkeeper'],
    'transaction:edit:any': ['owner', 'admin'],
    'report:export': ['owner', 'admin', 'bookkeeper', 'viewer'],
    'account:manage': ['owner', 'admin'],
    'category:manage': ['owner', 'admin'],
    'member:manage': ['owner', 'admin'],
    'audit:read': ['owner', 'admin'],
    'period:lock': ['owner'],
    'organization:transfer': ['owner'],
    'organization:delete': ['owner'],
  };

  for (const action of LEGACY_ACTIONS) {
    it(`${action} 仍然只给 ${expected[action].join('/')}`, () => {
      expect(rolesFor(action)).toEqual(expected[action]);
    });
  }

  it('owner 与 admin 的差别只有三个动作', () => {
    const ownerOnly = rolesFor('period:lock');
    expect(ownerOnly).toEqual(['owner']);

    const diff = LEGACY_ACTIONS.filter((a) => can('owner', a) && !can('admin', a));
    // 锁期间、移交所有权、解散公司——这三件事的共同点是「不可撤销或影响公司存续」，
    // admin 不该独自完成。其余权限两者完全相同。
    expect(diff).toEqual(['period:lock', 'organization:transfer', 'organization:delete']);
  });
});

describe('0022 新增动作的角色集合', () => {
  it('document:read 等于全部四个角色', () => {
    // 迁移里 select 策略写的是 app_is_member(organization_id) 而不是列出四个角色。
    // 两种写法等价的前提就是这一条：成员必然持有四个角色之一，且四个角色都能读。
    // 哪天有人把某个角色从 document:read 拿掉，迁移里的 app_is_member 就不再等价，
    // 这条断言是那个等价关系的看门人。
    expect(rolesFor('document:read')).toEqual(ROLES);
  });

  it('document:create 与 document:edit 给 owner/admin/bookkeeper', () => {
    expect(rolesFor('document:create')).toEqual(['owner', 'admin', 'bookkeeper']);
    expect(rolesFor('document:edit')).toEqual(['owner', 'admin', 'bookkeeper']);
  });

  it('masterdata:manage 给 owner/admin', () => {
    expect(rolesFor('masterdata:manage')).toEqual(['owner', 'admin']);
  });

  it('document:delete 是空集——它表示「不建 delete 策略」', () => {
    expect(rolesFor('document:delete')).toEqual([]);
    for (const role of ROLES) {
      expect(can(role, 'document:delete')).toBe(false);
    }
  });

  it('记账员能开单据但不能动主数据', () => {
    // 这一条正是 0010 反着写的那一条：它把单据写入限死在 owner/admin，
    // 于是记账员点「记录收款」时应用层放行、数据库拒绝。
    expect(can('bookkeeper', 'document:create')).toBe(true);
    expect(can('bookkeeper', 'document:edit')).toBe(true);
    expect(can('bookkeeper', 'masterdata:manage')).toBe(false);
  });

  it('viewer 除了读什么都不能', () => {
    expect(can('viewer', 'document:read')).toBe(true);
    expect(can('viewer', 'document:create')).toBe(false);
    expect(can('viewer', 'document:edit')).toBe(false);
    expect(can('viewer', 'masterdata:manage')).toBe(false);
  });
});

describe('矩阵的结构性质', () => {
  it('角色是全序的：上级角色拥有下级角色的全部权限', () => {
    // 不是为了好看。0022 的迁移用角色数组表达权限，
    // `array['owner','admin','bookkeeper']` 这种写法只有在全序成立时才读得懂——
    // 否则「给了 bookkeeper 却没给 admin」这种洞可以藏在任何一个数组里。
    const allActions = new Set<Action>(LEGACY_ACTIONS);
    for (const table of Object.values(TABLE_ACCESS)) {
      allActions.add(table.select);
      allActions.add(table.insert);
      allActions.add(table.update);
      allActions.add(table.delete);
    }

    // ROLES 的顺序就是权限从高到低的顺序，相邻两级逐对比较即可覆盖全序。
    for (let i = 0; i < ROLES.length - 1; i += 1) {
      const higher = ROLES[i];
      const lower = ROLES[i + 1];
      const leaked = [...allActions].filter((a) => can(lower, a) && !can(higher, a));
      expect(leaked, `${lower} 有 ${higher} 没有的权限`).toEqual([]);
    }
  });

  it('0010 管辖的那 22 张表一张都没从 TABLE_ACCESS 里掉出去', () => {
    // 这一条原来写的是 `toHaveLength(22)`。那个数字守的是「别把表删掉」，
    // 但它同时也禁止**加**表——0024 新增 fiscal_year_closings 时它就是这样
    // 红的，而报错只说 "expected 22 got 23"，看不出该做什么。
    //
    // 改成逐张点名 0010 那一批：删掉任何一张仍然会红（这是要守的），
    // 而新增一张不会（那是正常演进，覆盖完整性由
    // tests/db/rls-matrix.test.ts 对着 pg_class 的全称断言守着）。
    const zeroTenTables = [
      'bank_reconciliations', 'bill_items', 'bills', 'budgets', 'contacts',
      'credit_note_items', 'credit_notes', 'depreciation_schedules', 'fixed_assets',
      'imported_transactions', 'inventory_items', 'inventory_transactions',
      'invoice_items', 'invoices', 'payment_items', 'payments', 'po_items',
      'projects', 'purchase_orders', 'reconciliation_items', 'recurring_transactions',
      'tax_rates',
    ];
    expect(zeroTenTables).toHaveLength(22);
    const missing = zeroTenTables.filter((table) => !(table in TABLE_ACCESS));
    expect(missing, '这些表从 TABLE_ACCESS 里掉出去了，它们的策略会变成无人断言').toEqual([]);
  });

  it('明细表的父表也在 TABLE_ACCESS 里，且父表本身不是明细表', () => {
    for (const [table, access] of Object.entries(TABLE_ACCESS)) {
      if (!access.parent) continue;
      const parent = TABLE_ACCESS[access.parent.table];
      expect(parent, `${table} 的父表 ${access.parent.table} 未登记`).toBeDefined();
      // 只允许一层。两层嵌套会让 RLS 的子查询变成嵌套子查询，
      // 而每张明细表的每次读取都要跑一次它。
      expect(parent.parent, `${access.parent.table} 自己也是明细表`).toBeUndefined();
    }
  });

  it('TABLE_ACCESS 与 ROW_LEVEL_TABLES 不相交', () => {
    // 两个清单合起来必须是库里全部启用 RLS 的表（那一条由
    // tests/db/rls-matrix.test.ts 对着 pg_class 断言）。这里先保证不重叠，
    // 否则同一张表会同时声称「纯角色判断」和「含行级条件」。
    const overlap = Object.keys(TABLE_ACCESS).filter((t) => ROW_LEVEL_TABLES.includes(t));
    expect(overlap).toEqual([]);
  });

  it('每张表的 select 都是 document:read', () => {
    // 这批表没有一张需要按角色隐藏行：成员看不看得见由 organization_id 决定，
    // 不由角色决定。哪天要加「记账员看不到成本价」之类的规则，那是列级安全，
    // 不是往这里塞一个新角色集合。
    for (const [table, access] of Object.entries(TABLE_ACCESS)) {
      expect(access.select, table).toBe('document:read');
    }
  });

  it('允许硬删的只有七张表', () => {
    const deletable = Object.entries(TABLE_ACCESS)
      .filter(([, access]) => rolesFor(access.delete).length > 0)
      .map(([table]) => table)
      .sort();

    // 与 0022 迁移里「断言 3」的白名单逐字对应，外加 0024 的年结登记。
    //
    // 名单是显式的、不是数出来的：这一条守的正是「不要再多一张表可以被
    // 硬删」——账本里的东西一律软删除，能硬删的必须逐个说得出理由。
    //   六张 *_items      单据编辑时整体重建明细，删的是自己的行
    //   imported_transactions  银行对账单的暂存区，不是账
    //   fiscal_year_closings   撤销年结就是删这一行（它没有 update 策略，
    //                          一次年结的内容在发生那一刻就定死了）
    expect(deletable).toEqual([
      'bill_items',
      'credit_note_items',
      'fiscal_year_closings',
      'imported_transactions',
      'invoice_items',
      'payment_items',
      'po_items',
      'reconciliation_items',
    ]);
  });

  it('可硬删的表，其 delete 角色集合与 update 相同（除非它根本不允许 update）', () => {
    // 能改却不能删、或能删却不能改，都是两次独立判断留下的缝。
    //
    // 唯一的例外是「连 update 都没有」的表：那不是缝，是一个更严的选择。
    // fiscal_year_closings 就是这样——一次年结的内容（期间、净利润、产生的
    // 那笔分录）在它发生的那一刻就定死了，允许 update 等于允许把「去年
    // 结转了多少利润」事后改成另一个数字而对应的分录一动不动。要改只能
    // 撤销重做，而撤销是 delete。
    //
    // 所以这条不变量的准确说法是：**delete 不得宽于 update，除非 update
    // 是空集**。写成「相等或 update 为空」而不是干脆放宽成「不得更宽」，
    // 是因为后者会放过「能删不能改」以外的另一种缝：update 给了 bookkeeper
    // 而 delete 只给 owner——那种不对称同样是两次独立判断的产物。
    for (const [table, access] of Object.entries(TABLE_ACCESS)) {
      const deleteRoles = rolesFor(access.delete);
      if (deleteRoles.length === 0) continue;

      const updateRoles = rolesFor(access.update);
      if (updateRoles.length === 0) continue;

      expect(deleteRoles, table).toEqual(updateRoles);
    }
  });

  it('不允许 update 的表，必须是有意为之的那几张', () => {
    // 上一条给「update 为空」开了口子，这一条把那个口子收住：不是任何表
    // 都可以靠「我不允许 update」绕过一致性检查。
    const noUpdate = Object.entries(TABLE_ACCESS)
      .filter(([, access]) => rolesFor(access.update).length === 0)
      .map(([table]) => table)
      .sort();
    expect(noUpdate).toEqual(['fiscal_year_closings']);
  });
});
