import type { Tx } from '@/server/db/transaction';

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
      ${entry.before === undefined ? null : JSON.stringify(entry.before)},
      ${entry.after === undefined ? null : JSON.stringify(entry.after)},
      ${entry.ipAddress ?? null}
    )
  `;
}
