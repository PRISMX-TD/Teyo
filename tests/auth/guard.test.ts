import { describe, expect, it } from 'vitest';
import { AuthError, assertPermission } from '@/server/auth/guard';
import type { OrgContext } from '@/server/auth/guard';

function context(role: OrgContext['role']): OrgContext {
  return {
    userId: '00000000-0000-4000-8000-000000000001',
    organizationId: '00000000-0000-4000-8000-000000000002',
    orgSlug: 'acme',
    role,
    baseCurrency: 'MYR',
    lockedUntil: null,
  };
}

describe('assertPermission', () => {
  it('allows a permitted action', () => {
    expect(() => assertPermission(context('bookkeeper'), 'transaction:create')).not.toThrow();
  });

  it('throws AuthError with code forbidden for a denied action', () => {
    try {
      assertPermission(context('viewer'), 'transaction:create');
      throw new Error('expected assertPermission to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe('forbidden');
    }
  });

  it('blocks admin from owner-only actions', () => {
    expect(() => assertPermission(context('admin'), 'period:lock')).toThrow(AuthError);
    expect(() => assertPermission(context('admin'), 'organization:delete')).toThrow(AuthError);
  });

  it('blocks bookkeeper from editing records they do not own', () => {
    expect(() => assertPermission(context('bookkeeper'), 'transaction:edit:any')).toThrow(
      AuthError,
    );
    expect(() => assertPermission(context('bookkeeper'), 'member:manage')).toThrow(AuthError);
    expect(() => assertPermission(context('bookkeeper'), 'audit:read')).toThrow(AuthError);
  });

  it('allows owner everything in the matrix', () => {
    const actions = [
      'transaction:create',
      'account:manage',
      'member:manage',
      'audit:read',
      'period:lock',
      'organization:transfer',
      'organization:delete',
    ] as const;

    for (const action of actions) {
      expect(() => assertPermission(context('owner'), action)).not.toThrow();
    }
  });

  it('names the role and action in the error message', () => {
    // 报错要能直接看出是谁、做什么被拒，否则线上排查只能靠猜。
    expect(() => assertPermission(context('viewer'), 'period:lock')).toThrow(/viewer/);
    expect(() => assertPermission(context('viewer'), 'period:lock')).toThrow(/period:lock/);
  });
});

describe('AuthError', () => {
  it('carries a machine-readable code alongside the message', () => {
    const error = new AuthError('not_found', 'Company not found.');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('not_found');
    expect(error.name).toBe('AuthError');
    expect(error.message).toBe('Company not found.');
  });
});
