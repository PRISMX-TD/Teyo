'use client';

import { useSyncExternalStore } from 'react';
import { todayLocalISO } from '@/lib/date';

const noopSubscribe = () => () => {};
const serverSnapshot = () => '';

/**
 * 用户设备上的「今天」（YYYY-MM-DD），服务端渲染与水合期间是空串。
 *
 * 表单的日期默认值原来直接在渲染里调 todayLocalISO()。客户端组件在服务端
 * 也会渲染一遍，而服务器跑在 UTC：对 UTC+8 的用户，每天 00:00–08:00 服务端
 * 算出的是**昨天**。水合时 React 不会改写受控 <input> 的 value（避免覆盖
 * 用户在 JS 到达前已经打的字），于是框里一直显示服务端那个日期，而 state
 * 里是客户端的今天——显示与提交对不上；直接读 FormData 的表单则会把昨天
 * 原样提交上去。lib/date.ts 要修的正是这个八小时窗口。
 *
 * useSyncExternalStore 的 getServerSnapshot 在服务端和水合时都返回 ''，
 * 水合完成后 React 自动用客户端的值重渲染一次，两边始终一致。客户端导航
 * 直接挂载时没有水合，第一帧就是正确的日期。
 */
export function useLocalToday(): string {
  return useSyncExternalStore(noopSubscribe, todayLocalISO, serverSnapshot);
}

/** 把 YYYY-MM-DD 解析成本地午夜的 Date，供 addMonthsLocalISO 之类以它为起点。 */
export function localDateFromISO(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day);
}
