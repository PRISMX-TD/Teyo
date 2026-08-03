export type Role = 'owner' | 'admin' | 'bookkeeper' | 'viewer';
export type MembershipStatus = 'active' | 'invited' | 'suspended';

export const ROLES: readonly Role[] = ['owner', 'admin', 'bookkeeper', 'viewer'] as const;

export type Action =
  | 'transaction:read'
  | 'transaction:create'
  | 'transaction:edit:own'
  | 'transaction:edit:any'
  | 'report:export'
  | 'account:manage'
  | 'category:manage'
  | 'member:manage'
  | 'audit:read'
  | 'period:lock'
  | 'organization:transfer'
  | 'organization:delete';

const MATRIX: Record<Role, readonly Action[]> = {
  owner: [
    'transaction:read',
    'transaction:create',
    'transaction:edit:own',
    'transaction:edit:any',
    'report:export',
    'account:manage',
    'category:manage',
    'member:manage',
    'audit:read',
    'period:lock',
    'organization:transfer',
    'organization:delete',
  ],
  admin: [
    'transaction:read',
    'transaction:create',
    'transaction:edit:own',
    'transaction:edit:any',
    'report:export',
    'account:manage',
    'category:manage',
    'member:manage',
    'audit:read',
  ],
  bookkeeper: ['transaction:read', 'transaction:create', 'transaction:edit:own', 'report:export'],
  viewer: ['transaction:read', 'report:export'],
};

export function can(role: Role, action: Action): boolean {
  return MATRIX[role].includes(action);
}

export function canEditTransaction(role: Role, isOwnRecord: boolean): boolean {
  if (can(role, 'transaction:edit:any')) return true;
  return isOwnRecord && can(role, 'transaction:edit:own');
}
