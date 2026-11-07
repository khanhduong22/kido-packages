/**
 * @kido/team-rbac - Permission Matrix
 * Granular workspace and team permission definitions, role-to-permission mappings,
 * and custom per-member override resolution (allow/deny).
 */

import type { CustomPermissions, PermissionDefinition, PermissionSlug, TeamRole } from './types';

export const ALL_PERMISSIONS: readonly PermissionDefinition[] = [
  // Workspace management
  {
    slug: 'workspace:view',
    displayName: 'View Workspace',
    description: 'View workspace profile, status, and general configuration.',
    module: 'workspace',
  },
  {
    slug: 'workspace:update',
    displayName: 'Update Workspace',
    description: 'Update workspace name, domain restrictions, and branding settings.',
    module: 'workspace',
  },
  {
    slug: 'workspace:lock',
    displayName: 'Lock Workspace',
    description: 'Lock workspace to freeze mutations, invitations, and modifications.',
    module: 'workspace',
  },
  {
    slug: 'workspace:archive',
    displayName: 'Archive Workspace',
    description: 'Archive workspace into read-only cold state.',
    module: 'workspace',
  },
  {
    slug: 'workspace:delete',
    displayName: 'Delete Workspace',
    description: 'Permanently destroy workspace and all associated data (Owner only).',
    module: 'workspace',
  },

  // Team membership
  {
    slug: 'team:view',
    displayName: 'View Team Members',
    description: 'List workspace members, pending invitations, and assigned roles.',
    module: 'team',
  },
  {
    slug: 'team:invite',
    displayName: 'Invite Members',
    description: 'Issue invitations to new collaborators to join the workspace.',
    module: 'team',
  },
  {
    slug: 'team:remove',
    displayName: 'Remove Members',
    description: 'Revoke invitations or remove existing members from the workspace.',
    module: 'team',
  },
  {
    slug: 'team:role_update',
    displayName: 'Update Member Roles',
    description: 'Promote, demote, or assign custom permissions to workspace members.',
    module: 'team',
  },

  // Billing
  {
    slug: 'billing:view',
    displayName: 'View Billing',
    description: 'View current plan, subscription status, usage quotas, and past invoices.',
    module: 'billing',
  },
  {
    slug: 'billing:manage',
    displayName: 'Manage Billing',
    description: 'Update payment methods, change billing contact details, and cancel subscriptions.',
    module: 'billing',
  },
  {
    slug: 'billing:upgrade',
    displayName: 'Upgrade Plan',
    description: 'Upgrade or change workspace tiers, add-ons, and member seat quotas.',
    module: 'billing',
  },

  // Resources
  {
    slug: 'resources:view',
    displayName: 'View Resources',
    description: 'Read workspace operational data, links, documents, and assets.',
    module: 'resources',
  },
  {
    slug: 'resources:create',
    displayName: 'Create Resources',
    description: 'Create new operational data, links, documents, and assets.',
    module: 'resources',
  },
  {
    slug: 'resources:update',
    displayName: 'Update Resources',
    description: 'Edit, update, and reconfigure operational data and assets.',
    module: 'resources',
  },
  {
    slug: 'resources:delete',
    displayName: 'Delete Resources',
    description: 'Delete or soft-delete operational resources within workspace.',
    module: 'resources',
  },

  // Reports
  {
    slug: 'reports:view',
    displayName: 'View Reports',
    description: 'View operational telemetry, performance metrics, and usage analytics.',
    module: 'reports',
  },
  {
    slug: 'reports:export',
    displayName: 'Export Reports',
    description: 'Export raw telemetry, CSV analytics, and summary reports.',
    module: 'reports',
  },

  // Audit
  {
    slug: 'audit:view',
    displayName: 'View Audit Trail',
    description: 'Inspect security logs, login activities, and administrative mutation events.',
    module: 'audit',
  },
] as const;

export const ROLE_PERMISSIONS_MATRIX: Record<TeamRole, readonly PermissionSlug[]> = {
  owner: ALL_PERMISSIONS.map((p) => p.slug),

  admin: [
    'workspace:view',
    'workspace:update',
    'workspace:lock',
    'workspace:archive',
    'team:view',
    'team:invite',
    'team:remove',
    'team:role_update',
    'billing:view',
    'billing:upgrade',
    'resources:view',
    'resources:create',
    'resources:update',
    'resources:delete',
    'reports:view',
    'reports:export',
    'audit:view',
  ],

  billing_manager: [
    'workspace:view',
    'team:view',
    'billing:view',
    'billing:manage',
    'billing:upgrade',
    'resources:view',
    'reports:view',
    'reports:export',
    'audit:view',
  ],

  member: [
    'workspace:view',
    'team:view',
    'resources:view',
    'resources:create',
    'resources:update',
    'reports:view',
  ],

  viewer: [
    'workspace:view',
    'team:view',
    'resources:view',
    'reports:view',
  ],
};

/**
 * Returns the default base permissions granted to a given role.
 */
export function getPermissionsForRole(role: TeamRole): PermissionSlug[] {
  return [...(ROLE_PERMISSIONS_MATRIX[role] ?? [])];
}

/**
 * Resolves the effective set of permissions for a user given their base role
 * and optional member-specific custom overrides (allow/deny).
 */
export function resolveUserPermissions(
  role: TeamRole,
  customPermissions?: CustomPermissions
): Set<PermissionSlug> {
  const base = new Set<PermissionSlug>(getPermissionsForRole(role));

  if (customPermissions?.allow && customPermissions.allow.length > 0) {
    for (const perm of customPermissions.allow) {
      base.add(perm);
    }
  }

  if (customPermissions?.deny && customPermissions.deny.length > 0) {
    for (const perm of customPermissions.deny) {
      base.delete(perm);
    }
  }

  return base;
}

/**
 * Checks whether a given role (with optional custom overrides) has a specific permission.
 */
export function hasPermission(
  role: TeamRole,
  permission: PermissionSlug,
  customPermissions?: CustomPermissions
): boolean {
  const effective = resolveUserPermissions(role, customPermissions);
  return effective.has(permission);
}

/**
 * Checks whether all specified permissions are satisfied.
 */
export function hasAllPermissions(
  role: TeamRole,
  permissions: PermissionSlug[],
  customPermissions?: CustomPermissions
): boolean {
  const effective = resolveUserPermissions(role, customPermissions);
  return permissions.every((p) => effective.has(p));
}

/**
 * Checks whether at least one of the specified permissions is satisfied.
 */
export function hasAnyPermission(
  role: TeamRole,
  permissions: PermissionSlug[],
  customPermissions?: CustomPermissions
): boolean {
  const effective = resolveUserPermissions(role, customPermissions);
  return permissions.some((p) => effective.has(p));
}
