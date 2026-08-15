import Link from 'next/link';
import type { JSX } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { can, type Role } from '@/server/domain/permissions';
import { CHECKLIST_ACTIONS } from '@/server/repositories/dashboard';

export type ChecklistState = {
  hasMoneyAccount: boolean;
  hasFirstTransaction: boolean;
  hasContact: boolean;
  hasInvitedSomeone: boolean;
};

type ChecklistItem = {
  key: keyof ChecklistState;
  label: string;
  href: string;
  done: boolean;
};

/**
 * 新公司建好后的引导清单：告诉零会计知识的用户接下来该做什么。
 * 四项全部完成后返回 null，清单自动消失——它是脚手架，不是常驻家具。
 *
 * 四个链接分别要求 account:manage / transaction:create / member:manage
 * 才打得开（settings/accounts、settings/contacts、settings/members 都
 * 卡在 account:manage 或 member:manage 后面，transactions/new 卡在
 * transaction:create 后面）。用 CHECKLIST_ACTIONS 这份和查询状态那边
 * 共用的权限映射先把当前角色做不到的项过滤掉，不然 bookkeeper/viewer
 * 会看到一条永远打不上勾、点进去还会被拒绝的死链接。
 */
export function FirstRunChecklist(props: {
  orgSlug: string;
  state: ChecklistState;
  locale: Locale;
  t: Messages;
  role: Role;
}): JSX.Element | null {
  const { orgSlug, state, t, role } = props;

  const allItems: ChecklistItem[] = [
    {
      key: 'hasMoneyAccount',
      label: t.overview.checklistStep1,
      href: `/${orgSlug}/settings/accounts`,
      done: state.hasMoneyAccount,
    },
    {
      key: 'hasFirstTransaction',
      label: t.overview.checklistStep2,
      href: `/${orgSlug}/transactions/new`,
      done: state.hasFirstTransaction,
    },
    {
      key: 'hasContact',
      label: t.overview.checklistStep3,
      href: `/${orgSlug}/settings/contacts`,
      done: state.hasContact,
    },
    {
      key: 'hasInvitedSomeone',
      label: t.overview.checklistStep4,
      href: `/${orgSlug}/settings/members`,
      done: state.hasInvitedSomeone,
    },
  ];

  const items = allItems.filter((item) => can(role, CHECKLIST_ACTIONS[item.key]));

  if (items.every((item) => item.done)) return null;

  return (
    <section className="first-run">
      <h2>{t.overview.checklistTitle}</h2>
      <ol>
        {items.map((item) => (
          <li key={item.key} className={item.done ? 'checklist-done' : undefined}>
            <span className="checklist-mark" aria-hidden="true">
              {item.done ? '✓' : '○'}
            </span>
            {item.done ? (
              <span>
                {item.label}
                <span className="visually-hidden"> — {t.overview.checklistDone}</span>
              </span>
            ) : (
              <Link href={item.href}>{item.label}</Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
