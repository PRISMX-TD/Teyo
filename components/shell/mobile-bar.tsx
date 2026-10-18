import Link from 'next/link';
import type { Messages } from '@/lib/i18n';
import { CaretUpDown, UserCircle } from '@/components/ui/icons';
import { AccountLink } from './account-link';

type Props = {
  orgSlug: string;
  orgName: string;
  /** 用户属于几家公司。多于一家时公司名是一个「切换」入口。 */
  orgCount: number;
  i18n: Messages;
};

/**
 * 手机上页面最顶上的一条（≥768px 不显示，桌面由侧栏报头承担）。
 *
 * 侧栏在手机上整个隐藏，于是原来手机用户从头到尾看不到自己在哪家公司的
 * 账里——而「一个人管几套账」正是这个应用的卖点。这一条只放两样东西：
 * 左边公司名（有多家时点一下去换），右边一个去「我的账号」的头像。
 * 不吸顶：它是身份，不是导航，滚走之后把整屏留给内容。
 */
export function MobileBar({ orgSlug, orgName, orgCount, i18n }: Props) {
  const canSwitch = orgCount > 1;
  const identity = (
    <>
      <span className="brand-mark brand-mark--sm" aria-hidden="true">
        T
      </span>
      <span className="mobile-bar-name">{orgName}</span>
      {canSwitch ? <CaretUpDown className="mobile-bar-caret" size={14} weight="bold" aria-hidden="true" /> : null}
    </>
  );

  return (
    <header className="mobile-bar">
      {canSwitch ? (
        <Link href="/" className="mobile-bar-org">
          {identity}
          <span className="visually-hidden">{i18n.nav.switchCompany}</span>
        </Link>
      ) : (
        <Link href={`/${orgSlug}`} className="mobile-bar-org">
          {identity}
        </Link>
      )}
      <AccountLink className="mobile-bar-account" label={i18n.nav.account}>
        <UserCircle size={26} aria-hidden="true" />
      </AccountLink>
    </header>
  );
}
