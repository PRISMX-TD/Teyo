'use server';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { Locale } from '@/lib/i18n';
import { sql } from '@/server/db/client';
import { withoutUserContext } from '@/server/db/transaction';
import { requireUserId } from '@/server/auth/guard';
import type { Role } from '@/server/domain/permissions';

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  locale: z.enum(['en', 'zh']),
});

export async function updateProfile(input: {
  displayName: string;
  locale: Locale;
}): Promise<void> {
  const userId = await requireUserId();
  const parsed = profileSchema.parse(input);

  await sql`
    update app_users
    set display_name = ${parsed.displayName}, locale = ${parsed.locale}
    where id = ${userId}
  `;

  revalidatePath('/account');
}

export type InvitationPreview = {
  organizationName: string;
  role: Role | 'viewer';
  state: 'valid' | 'expired' | 'revoked' | 'accepted' | 'invalid';
};

export async function getInvitationPreview(token: string): Promise<InvitationPreview> {
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const rows = await withoutUserContext(
    (tx) => tx`select * from app_find_invitation(${tokenHash})`,
  );

  if (rows.length === 0) {
    return { organizationName: '', role: 'viewer', state: 'invalid' };
  }

  const invitation = rows[0];
  const state = invitation.revoked_at
    ? 'revoked'
    : invitation.accepted_at
      ? 'accepted'
      : new Date(invitation.expires_at as string) <= new Date()
        ? 'expired'
        : 'valid';

  return {
    organizationName: (invitation.organization_name as string) ?? '',
    role: (invitation.role as Role) ?? 'viewer',
    state,
  };
}
