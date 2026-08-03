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

export function assertPeriodOpen(occurredOn: string, lockedUntil: string | null): void {
  if (isDateLocked(occurredOn, lockedUntil)) {
    throw new PeriodLockedError(
      `The books are locked through ${lockedUntil}. Unlock the period before changing this record.`,
    );
  }
}
