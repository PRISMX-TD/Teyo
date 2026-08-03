import { describe, expect, it } from 'vitest';
import { ROLES, can, canEditTransaction, type Role } from '@/server/domain/permissions';

describe('can', () => {
  it('lets every role read and export', () => {
    for (const role of ROLES) {
      expect(can(role, 'transaction:read')).toBe(true);
      expect(can(role, 'report:export')).toBe(true);
    }
  });

  it('blocks viewer from creating transactions', () => {
    expect(can('viewer', 'transaction:create')).toBe(false);
    expect(can('bookkeeper', 'transaction:create')).toBe(true);
    expect(can('admin', 'transaction:create')).toBe(true);
    expect(can('owner', 'transaction:create')).toBe(true);
  });

  it('restricts settings management to owner and admin', () => {
    const settingsActions = ['account:manage', 'category:manage', 'member:manage'] as const;
    for (const action of settingsActions) {
      expect(can('owner', action)).toBe(true);
      expect(can('admin', action)).toBe(true);
      expect(can('bookkeeper', action)).toBe(false);
      expect(can('viewer', action)).toBe(false);
    }
  });

  it('restricts period locking, ownership transfer and org deletion to owner', () => {
    const ownerOnly = ['period:lock', 'organization:transfer', 'organization:delete'] as const;
    for (const action of ownerOnly) {
      expect(can('owner', action)).toBe(true);
      expect(can('admin', action)).toBe(false);
      expect(can('bookkeeper', action)).toBe(false);
      expect(can('viewer', action)).toBe(false);
    }
  });

  it('shows the audit log to owner and admin only', () => {
    expect(can('owner', 'audit:read')).toBe(true);
    expect(can('admin', 'audit:read')).toBe(true);
    expect(can('bookkeeper', 'audit:read')).toBe(false);
    expect(can('viewer', 'audit:read')).toBe(false);
  });
});

describe('canEditTransaction', () => {
  it('lets owner and admin edit any record', () => {
    for (const role of ['owner', 'admin'] as Role[]) {
      expect(canEditTransaction(role, true)).toBe(true);
      expect(canEditTransaction(role, false)).toBe(true);
    }
  });

  it('lets bookkeeper edit only their own records', () => {
    expect(canEditTransaction('bookkeeper', true)).toBe(true);
    expect(canEditTransaction('bookkeeper', false)).toBe(false);
  });

  it('never lets viewer edit', () => {
    expect(canEditTransaction('viewer', true)).toBe(false);
    expect(canEditTransaction('viewer', false)).toBe(false);
  });
});
