import postgres from 'postgres';

/**
 * 超级用户连接，仅用于测试数据准备、断言与清理，绕过 RLS。
 * 被测代码本身必须走 withTransaction，不要用这个连接。
 */
export const admin = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

let counter = 0;

export async function createTestUser(displayName: string): Promise<{ id: string; email: string }> {
  counter += 1;
  const email = `test-${Date.now()}-${counter}@example.com`;
  const [row] = await admin`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role)
    values (gen_random_uuid(), ${email}, 'x', now(), 'authenticated', 'authenticated')
    returning id
  `;
  await admin`
    insert into app_users (id, email, display_name)
    values (${row.id}, ${email}, ${displayName})
  `;
  return { id: row.id as string, email };
}

export async function deleteTestUser(id: string): Promise<void> {
  await admin`delete from auth.users where id = ${id}`;
}

/** 删除测试期间建立的公司。organizations 的外键是 on delete cascade，子表会一并清掉。 */
export async function deleteTestOrganizations(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await admin`delete from organizations where id = any(${ids})`;
}
