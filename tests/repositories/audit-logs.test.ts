import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, createTestUser, deleteTestOrganizations, deleteTestUser } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { AUDIT_PAGE_MAX, listAuditLogs, recordAudit } from '@/server/repositories/audit-logs';

let ownerId: string;
let viewerId: string;
let orgId: string;
let otherOrgId: string;

beforeAll(async () => {
  const owner = await createTestUser('AuditOwner');
  ownerId = owner.id;
  const viewer = await createTestUser('AuditViewer');
  viewerId = viewer.id;

  const [org] = await admin`
    insert into organizations (name, slug, base_currency, created_by)
    values ('Audit Co', 'audit-co', 'MYR', ${ownerId}) returning id
  `;
  orgId = org.id as string;
  await admin`
    insert into memberships (user_id, organization_id, role, status)
    values (${ownerId}, ${orgId}, 'owner', 'active'),
           (${viewerId}, ${orgId}, 'viewer', 'active')
  `;

  // 第二家公司，用于验证审计日志不会跨公司泄漏。
  const [other] = await admin`
    insert into organizations (name, slug, base_currency, created_by)
    values ('Other Audit Co', 'other-audit-co', 'MYR', ${ownerId}) returning id
  `;
  otherOrgId = other.id as string;
  await admin`
    insert into memberships (user_id, organization_id, role, status)
    values (${ownerId}, ${otherOrgId}, 'owner', 'active')
  `;
});

afterAll(async () => {
  await deleteTestOrganizations([orgId, otherOrgId]);
  await deleteTestUser(viewerId);
  await deleteTestUser(ownerId);
  await admin.end();
});

describe('recordAudit', () => {
  it('stores the action with before and after snapshots', async () => {
    await withTransaction(ownerId, (tx) =>
      recordAudit(tx, {
        organizationId: orgId,
        actorUserId: ownerId,
        action: 'account.updated',
        entityType: 'account',
        entityId: null,
        before: { name: 'Old' },
        after: { name: 'New' },
      }),
    );

    const [row] = await admin`
      select action, before, after from audit_logs
      where organization_id = ${orgId} and action = 'account.updated'
    `;
    expect(row.before).toEqual({ name: 'Old' });
    expect(row.after).toEqual({ name: 'New' });
  });

  it('leaves before and after null when omitted', async () => {
    await withTransaction(ownerId, (tx) =>
      recordAudit(tx, {
        organizationId: orgId,
        actorUserId: ownerId,
        action: 'report.exported',
        entityType: 'report',
        entityId: null,
      }),
    );

    const [row] = await admin`
      select before, after from audit_logs
      where organization_id = ${orgId} and action = 'report.exported'
    `;
    expect(row.before).toBeNull();
    expect(row.after).toBeNull();
  });

  it('rolls back with the business write it accompanies', async () => {
    // 审计必须与业务写入同生共死，否则日志可以被绕过。
    await expect(
      withTransaction(ownerId, async (tx) => {
        await recordAudit(tx, {
          organizationId: orgId,
          actorUserId: ownerId,
          action: 'category.created',
          entityType: 'category',
          entityId: null,
        });
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');

    const rows = await admin`
      select id from audit_logs where organization_id = ${orgId} and action = 'category.created'
    `;
    expect(rows).toHaveLength(0);
  });
});

describe('listAuditLogs', () => {
  beforeAll(async () => {
    await admin`delete from audit_logs where organization_id in (${orgId}, ${otherOrgId})`;
    // 25 条本公司记录，时间递增，用于验证排序与分页。
    for (let i = 0; i < 25; i += 1) {
      await admin`
        insert into audit_logs
          (organization_id, actor_user_id, action, entity_type, entity_id, created_at)
        values (${orgId}, ${ownerId}, ${`transaction.created`}, 'transaction', null,
                now() - make_interval(mins => ${25 - i}))
      `;
    }
    await admin`
      insert into audit_logs (organization_id, actor_user_id, action, entity_type, entity_id)
      values (${otherOrgId}, ${ownerId}, 'organization.created', 'organization', null)
    `;
  });

  it('returns newest entries first with the actor name resolved', async () => {
    const rows = await withTransaction(ownerId, (tx) =>
      listAuditLogs(tx, orgId, { limit: 10, offset: 0 }),
    );

    expect(rows).toHaveLength(10);
    expect(rows[0].actorDisplayName).toBe('AuditOwner');
    const times = rows.map((r) => r.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('pages through results without overlap', async () => {
    const first = await withTransaction(ownerId, (tx) =>
      listAuditLogs(tx, orgId, { limit: 10, offset: 0 }),
    );
    const second = await withTransaction(ownerId, (tx) =>
      listAuditLogs(tx, orgId, { limit: 10, offset: 10 }),
    );

    const overlap = first.map((r) => r.id).filter((id) => second.some((s) => s.id === id));
    expect(overlap).toHaveLength(0);
  });

  it('never returns entries from another company', async () => {
    const rows = await withTransaction(ownerId, (tx) =>
      listAuditLogs(tx, orgId, { limit: AUDIT_PAGE_MAX, offset: 0 }),
    );
    expect(rows.every((r) => r.action === 'transaction.created')).toBe(true);
  });

  it('caps an oversized limit instead of running an unbounded scan', async () => {
    // limit 来自用户输入，不设上界就是一个廉价的资源耗尽入口。
    const rows = await withTransaction(ownerId, (tx) =>
      listAuditLogs(tx, orgId, { limit: 100_000, offset: 0 }),
    );
    expect(rows.length).toBeLessThanOrEqual(AUDIT_PAGE_MAX);
  });

  it('rejects a negative or non-integer limit', async () => {
    await expect(
      withTransaction(ownerId, (tx) => listAuditLogs(tx, orgId, { limit: -1, offset: 0 })),
    ).rejects.toThrow(/limit/i);
    await expect(
      withTransaction(ownerId, (tx) => listAuditLogs(tx, orgId, { limit: 1.5, offset: 0 })),
    ).rejects.toThrow(/limit/i);
  });

  it('rejects a negative or non-integer offset', async () => {
    await expect(
      withTransaction(ownerId, (tx) => listAuditLogs(tx, orgId, { limit: 10, offset: -5 })),
    ).rejects.toThrow(/offset/i);
    await expect(
      withTransaction(ownerId, (tx) => listAuditLogs(tx, orgId, { limit: 10, offset: 2.5 })),
    ).rejects.toThrow(/offset/i);
  });

  it('returns nothing to a viewer, because RLS restricts audit reads to owner and admin', async () => {
    // viewer 没有 audit:read。即便调用方漏检权限，RLS 也必须挡住。
    const rows = await withTransaction(viewerId, (tx) =>
      listAuditLogs(tx, orgId, { limit: 10, offset: 0 }),
    );
    expect(rows).toHaveLength(0);
  });
});
