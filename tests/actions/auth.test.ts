import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/server/db/client';
import { admin } from '@/tests/helpers/db';
import { ensureAppUser } from '@/server/actions/auth';

let authUserId: string;
let otherUserId: string;

beforeAll(async () => {
  authUserId = randomUUID();
  otherUserId = randomUUID();

  await admin`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at,
                            aud, role, raw_app_meta_data, raw_user_meta_data,
                            created_at, updated_at)
    values (${authUserId}, 'fresh@example.com', 'test-not-a-real-hash', now(),
            'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now(), now())
  `;

  await admin`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at,
                            aud, role, raw_app_meta_data, raw_user_meta_data,
                            created_at, updated_at)
    values (${otherUserId}, 'nodisplay@example.com', 'test-not-a-real-hash', now(),
            'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now(), now())
  `;
});

afterAll(async () => {
  await admin`delete from app_users where id in (${authUserId}, ${otherUserId})`;
  await admin`delete from auth.users where id in (${authUserId}, ${otherUserId})`;
  await sql.end();
  await admin.end();
});

describe('ensureAppUser', () => {
  it('creates the profile row on first call', async () => {
    await ensureAppUser(authUserId, 'fresh@example.com', 'Fresh Boss', 'zh');

    const [row] = await sql`select email, display_name, locale from app_users where id = ${authUserId}`;
    expect(row.email).toBe('fresh@example.com');
    expect(row.display_name).toBe('Fresh Boss');
    expect(row.locale).toBe('zh');
  });

  it('is idempotent and does not duplicate the row', async () => {
    await ensureAppUser(authUserId, 'fresh@example.com', 'Fresh Boss', 'zh');
    await ensureAppUser(authUserId, 'fresh@example.com', 'Fresh Boss', 'zh');

    const rows = await sql`select id from app_users where id = ${authUserId}`;
    expect(rows).toHaveLength(1);
  });

  it('does not overwrite an existing display name with a blank one', async () => {
    await ensureAppUser(authUserId, 'fresh@example.com', '', 'en');

    const [row] = await sql`select display_name from app_users where id = ${authUserId}`;
    expect(row.display_name).toBe('Fresh Boss');
  });

  it('falls back to the email local part when no display name is given', async () => {
    await ensureAppUser(otherUserId, 'nodisplay@example.com', '', 'en');

    const [row] = await sql`select display_name from app_users where id = ${otherUserId}`;
    expect(row.display_name).toBe('nodisplay');
  });
});
