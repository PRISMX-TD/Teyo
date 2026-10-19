'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 动作成功后的 router.refresh()，放进 transition 里并记下是哪一行触发的。
 *
 * 列表上的「开具 / 接收 / 作废」原来在 finally 里清掉在途状态、再裸调
 * router.refresh()：服务端那一轮重渲染回来之前，按钮已经重新可点，而行上
 * 显示的还是旧状态（草稿）。再点一次，服务端回一句「已经开具过了」。
 * 用 isRefreshing(id) 把按钮一直禁用到新数据真的到了为止。
 */
export function useRefreshAfter() {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [target, setTarget] = useState<string | null>(null);

  const refresh = useCallback(
    (id: string | null = null) => {
      setTarget(id);
      startRefresh(() => router.refresh());
    },
    [router],
  );

  const isRefreshing = useCallback(
    (id: string) => refreshing && target === id,
    [refreshing, target],
  );

  return { refresh, refreshing, isRefreshing };
}
