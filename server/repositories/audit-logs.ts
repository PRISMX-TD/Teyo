import type { Tx } from '@/server/db/transaction';

/** 单页审计条数上限。limit 来自用户输入，无上界即为廉价的资源耗尽入口。 */
export const AUDIT_PAGE_MAX = 200;

export type AuditLogRow = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorDisplayName: string | null;
  before: unknown;
  after: unknown;
  createdAt: Date;
};

export type AuditEntry = {
  organizationId: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
};

/**
 * 必须与业务写入同事务调用，保证审计不可绕过：
 * 业务写入回滚时审计一起回滚，审计写入失败时业务也不落库。
 *
 * before/after 必须用 tx.json() 传入。若先 JSON.stringify 再传，驱动会把它
 * 当普通字符串再编码一次，jsonb 列里存下的是 JSON 标量字符串
 * （jsonb_typeof = 'string'）而非对象，之后 before->>'role' 之类的查询全部失效。
 * 加 ::jsonb 也没用，实测同样是字符串。
 */
export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx`
    insert into audit_logs
      (organization_id, actor_user_id, action, entity_type, entity_id, before, after, ip_address)
    values (
      ${entry.organizationId},
      ${entry.actorUserId},
      ${entry.action},
      ${entry.entityType},
      ${entry.entityId},
      ${entry.before === undefined ? null : tx.json(entry.before as never)},
      ${entry.after === undefined ? null : tx.json(entry.after as never)},
      ${entry.ipAddress ?? null}
    )
  `;
}

/**
 * 分页读取某公司的审计日志。
 *
 * 除 organization_id 收窄外，audit_logs 的 RLS 只允许 owner/admin 读取，
 * 因此 viewer 即便调到这里也只会拿到空结果——两层防护都在。
 */
export async function listAuditLogs(
  tx: Tx,
  organizationId: string,
  opts: { limit: number; offset: number },
): Promise<AuditLogRow[]> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1) {
    throw new Error(`listAuditLogs requires a positive integer limit, received ${opts.limit}.`);
  }
  if (!Number.isInteger(opts.offset) || opts.offset < 0) {
    throw new Error(
      `listAuditLogs requires a non-negative integer offset, received ${opts.offset}.`,
    );
  }

  const limit = Math.min(opts.limit, AUDIT_PAGE_MAX);

  const rows = await tx`
    select a.id, a.action, a.entity_type, a.entity_id, a.actor_user_id,
           u.display_name as actor_display_name, a.before, a.after, a.created_at
    from audit_logs a
    left join app_users u on u.id = a.actor_user_id
    where a.organization_id = ${organizationId}
    order by a.created_at desc, a.id desc
    limit ${limit} offset ${opts.offset}
  `;

  return rows.map((row) => ({
    id: row.id as string,
    action: row.action as string,
    entityType: row.entity_type as string,
    entityId: (row.entity_id as string | null) ?? null,
    actorUserId: (row.actor_user_id as string | null) ?? null,
    actorDisplayName: (row.actor_display_name as string | null) ?? null,
    before: row.before ?? null,
    after: row.after ?? null,
    createdAt: row.created_at as Date,
  }));
}
