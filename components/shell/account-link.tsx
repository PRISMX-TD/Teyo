'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * 去「我的账号」的链接，带上 ?from=当前路径。
 *
 * /account 在公司外壳之外（没有标签栏），页面上唯一的出口是左上角的
 * 「‹ 返回」。原来它写死回 '/'，而 '/' 对只有一家公司的人会跳到概览——
 * 在流水页点了头像、看完账号再返回，人却落在了概览。外壳本身是服务端
 * 组件，拿不到当前路径，所以只把这一个链接做成客户端组件。
 * from 在 app/account/page.tsx 里用 safeNextPath 再校验一遍。
 */
export function AccountLink({
  className,
  label,
  children,
}: {
  className?: string;
  /** 只有图标、没有可见文字时传，作为 aria-label。 */
  label?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  return (
    <Link href={`/account?from=${encodeURIComponent(pathname)}`} className={className} aria-label={label}>
      {children}
    </Link>
  );
}
