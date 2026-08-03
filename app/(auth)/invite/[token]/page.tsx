import { getInvitationPreview } from '@/server/actions/profile';
import { acceptInvitation } from '@/server/actions/members';
import { getMessages } from '@/lib/i18n';
import { requireUserId } from '@/server/auth/guard';
import { getUserLocale } from '@/server/repositories/organizations';

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const userId = await requireUserId();
  const locale = (await getUserLocale(userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const preview = await getInvitationPreview(token);

  return (
    <main className="invite-page">
      {preview.state === 'invalid' ? (
        <>
          <h1>{t.invite.invalid}</h1>
          <p>{t.invite.expired}</p>
        </>
      ) : preview.state === 'accepted' ? (
        <>
          <h1>{t.invite.alreadyMember}</h1>
          <p>{t.invite.body.replace('{org}', preview.organizationName)}</p>
        </>
      ) : preview.state === 'expired' ? (
        <h1>{t.invite.expired}</h1>
      ) : preview.state === 'revoked' ? (
        <h1>{t.invite.expired}</h1>
      ) : (
        <>
          <h1>{t.invite.title}</h1>
          <p>{t.invite.body.replace('{org}', preview.organizationName).replace('{role}', preview.role)}</p>
          <form
            action={async () => {
              'use server';
              await acceptInvitation(token);
            }}
          >
            <button type="submit">{t.invite.accept}</button>
          </form>
        </>
      )}
    </main>
  );
}
