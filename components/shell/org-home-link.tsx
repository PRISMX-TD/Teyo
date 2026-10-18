'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * 回到当前公司概览的链接。not-found.tsx 拿不到路由参数，只能在客户端
 * 从 URL 里读 orgSlug；读不到（理论上不会）就退回 '/'，由它按公司数分流。
 */
export function OrgHomeLink({ className, children }: { className?: string; children: ReactNode }) {
  const params = useParams<{ orgSlug?: string }>();
  const slug = typeof params?.orgSlug === 'string' ? params.orgSlug : '';
  return (
    <Link href={slug ? `/${slug}` : '/'} className={className}>
      {children}
    </Link>
  );
}
