'use client';

import { useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages, interpolate } from '@/lib/i18n';
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
  /**
   * 刚生成的那条邀请链接。
   *
   * 这一段存在的理由：inviteMember 返回 { token }，而这个组件原来把返回值
   * 直接丢掉了。库里存的是 token 的 sha256 哈希（见
   * server/repositories/invitations.ts——明文从不落库，这是对的），所以
   * **丢掉就再也拿不回来**。撤销重发也没用，那一样会被丢掉。
   *
   * 结果是邀请功能整个不通：能建出一条 invitations 记录，但世界上没有任何
   * 人能拿到那个链接去接受它。members.ts 里那句「邮件发送在 Task 21 接入」
   * 一直没有兑现，而界面这边也没有替代出口。
   *
   * 这里不引入邮件服务（那要一个这个项目没有的第三方密钥），而是把链接
   * 交回给邀请人自己发。对马来西亚的小生意来说这反而更贴合实际——他们
   * 本来就用 WhatsApp 联系同事和会计师。
   */
  const [invite, setInvite] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

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
                setError(null);
                setCopied(false);
                try {
                  const { token } = await inviteMember(orgSlug, {
                    email,
                    role: role as import('@/server/domain/permissions').Role,
                  });
                  // origin 取自浏览器而不是服务端的环境变量：本地开发、预览
                  // 部署、生产各有各的域名，而链接必须在用户此刻所在的那个
                  // 域名下才点得开。
                  setInvite({ email, url: `${window.location.origin}/invite/${token}` });
                  setEmail('');
                } catch (err) {
                  setError((err as Error).message);
                }
                finally { setPending(false); }
              }}
            >
              {t.members.invite}
            </button>
          </div>

          {invite ? (
            <div className="invite-link" role="status">
              <p className="invite-link-title">
                {interpolate(t.members.inviteLinkTitle, { email: invite.email })}
              </p>
              <p className="invite-link-hint">{t.members.inviteLinkHint}</p>
              <div className="invite-link-row">
                <input
                  type="text"
                  readOnly
                  value={invite.url}
                  aria-label={t.members.inviteLinkTitle}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(invite.url);
                      setCopied(true);
                    } catch {
                      // 剪贴板在非 HTTPS、或用户拒绝授权时会失败。输入框
                      // 是只读且可全选的，用户照样能手动复制——所以这里
                      // 不报错，只是不显示「已复制」。
                      setCopied(false);
                    }
                  }}
                >
                  {copied ? t.members.copied : t.members.copyLink}
                </button>
              </div>
              <p className="invite-link-once">{t.members.inviteLinkOnce}</p>
            </div>
          ) : null}
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
