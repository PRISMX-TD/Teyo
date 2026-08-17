import { can, type Role } from './permissions';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class PeriodLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeriodLockedError';
  }
}

/** Compares ISO date strings lexicographically, which is timezone-independent. */
export function isDateLocked(occurredOn: string, lockedUntil: string | null): boolean {
  if (!ISO_DATE.test(occurredOn)) {
    throw new PeriodLockedError(`Expected an ISO date (YYYY-MM-DD), received "${occurredOn}".`);
  }
  if (lockedUntil === null) return false;
  if (!ISO_DATE.test(lockedUntil)) {
    throw new PeriodLockedError(`Expected an ISO date (YYYY-MM-DD), received "${lockedUntil}".`);
  }
  return occurredOn <= lockedUntil;
}

/**
 * 期间封账后拒绝写入，并告诉这个人他自己能不能解锁。
 *
 * role 是必填参数，不是可选项。这句话原来一律写「Unlock the period before
 * changing this record.」——而 period:lock 只有 owner 有（见 permissions.ts
 * 的 MATRIX），admin、bookkeeper 读到的是一句让他去做一件他做不到的事。
 * 本分支还新把折旧与定期补记接到了这个检查上，非 owner 从此撞得到它。
 *
 * 判断由 can() 做而不是由调用方传一个布尔值：谁能解锁是权限矩阵的事，
 * 五个调用点各自记一遍迟早会有一处记错，而记错的那一处不会有任何报错。
 * 面向没有会计基础的用户，一句指向做不到的动作的提示就是缺陷本身——
 * 本分支 70 行外的 recurring.ts 已经立好了这个先例：说清楚该找谁。
 */
export function assertPeriodOpen(
  occurredOn: string,
  lockedUntil: string | null,
  role: Role,
): void {
  if (!isDateLocked(occurredOn, lockedUntil)) return;

  const remedy = can(role, 'period:lock')
    ? 'Unlock the period before changing this record.'
    : 'Ask an owner to unlock the period before this record can be changed.';

  throw new PeriodLockedError(`The books are locked through ${lockedUntil}. ${remedy}`);
}
