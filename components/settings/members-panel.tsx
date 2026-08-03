'use client';

import { useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import type { MemberRow } from '@/server/repositories/memberships';
import type { InvitationRow } from '@/server/repositories/invitations';
import { inviteMember, changeMemberRole, setMemberStatus, revokeInvitation, transferOwnership } from '@/server/actions/members';

type Props = {
  orgSlug: string;
  members: MemberRow[];
  invitations: InvitationRow[];
  currentUserId: string;
  locale: Locale;
};

export function MembersPanel({ orgSlug, members, invitations, currentUserId, locale }: Props) {
  const t = getMessages(locale);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('bookkeeper');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const currentMember = members.find((m) => m.userId === currentUserId);
  const isOwner = currentMember?.role === 'owner';

  const roleLabels: Record<string, string> = {
    owner: t.members.roleOwner,
    admin: t.members.roleAdmin,
    bookkeeper: t.members.roleBookkeeper,
    viewer: t.members.roleViewer,
  };

  return (
    <div className="members-panel">
      <section>
        <h2>{t.settings.members}</h2>
        <ul>
          {members.map((m) => (
            <li key={m.membershipId}>
              <span>{m.displayName}</span>
              <span className="text-muted">{m.email}</span>
              <span>({roleLabels[m.role] ?? m.role})</span>
              {m.status === 'suspended' ? <span className="badge">{t.members.statusSuspended}</span> : null}

              {isOwner && m.userId !== currentUserId ? (
                <>
                  <select
                    defaultValue={m.role}
                    onChange={async (e) => {
                      try { await changeMemberRole(orgSlug, m.membershipId, e.target.value as import('@/server/domain/permissions').Role); } catch (err) { setError((err as Error).message); }
                    }}
                  >
                    <option value="admin">{t.members.roleAdmin}</option>
                    <option value="bookkeeper">{t.members.roleBookkeeper}</option>
                    <option value="viewer">{t.members.roleViewer}</option>
                  </select>
                  <button onClick={async () => {
                    try {
                      if (m.status === 'active') await setMemberStatus(orgSlug, m.membershipId, 'suspended');
                      else await setMemberStatus(orgSlug, m.membershipId, 'active');
                    } catch (err) { setError((err as Error).message); }
                  }}>
                    {m.status === 'active' ? t.members.suspend : t.members.reactivate}
                  </button>

                  {m.role !== 'owner' ? (
                    <button onClick={async () => {
                      if (!confirm(t.members.transferConfirm)) return;
                      try { await transferOwnership(orgSlug, m.membershipId); } catch (err) { setError((err as Error).message); }
                    }}>
                      {t.members.transferOwnership}
                    </button>
                  ) : null}
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {isOwner ? (
        <section>
          <h2>{t.members.invite}</h2>
          <div className="invite-form">
            <input
              type="email"
              placeholder={t.members.inviteEmail}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="admin">{t.members.roleAdmin}</option>
              <option value="bookkeeper">{t.members.roleBookkeeper}</option>
              <option value="viewer">{t.members.roleViewer}</option>
            </select>
            <button
              disabled={pending || !email}
              onClick={async () => {
                setPending(true);
                try { await inviteMember(orgSlug, { email, role: role as import('@/server/domain/permissions').Role }); setEmail(''); } catch (err) { setError((err as Error).message); }
                finally { setPending(false); }
              }}
            >
              {t.members.invite}
            </button>
          </div>
        </section>
      ) : null}

      {invitations.length > 0 ? (
        <section>
          <h2>{t.members.pendingInvites}</h2>
          <ul>
            {invitations.map((inv) => (
              <li key={inv.id}>
                <span>{inv.email}</span>
                <span>({roleLabels[inv.role] ?? inv.role})</span>
                {isOwner ? (
                  <button onClick={async () => {
                    try { await revokeInvitation(orgSlug, inv.id); } catch (err) { setError((err as Error).message); }
                  }}>
                    {t.members.revoke}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {error ? <p role="alert" className="form-error">{error}</p> : null}
    </div>
  );
}
