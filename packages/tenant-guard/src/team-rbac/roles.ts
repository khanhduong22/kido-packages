/**
 * @kido/team-rbac - Roles & Hierarchy
 * Defines team role ordering: Owner > Admin > BillingManager > Member > Viewer
 */

import type { RoleMetadata, TeamRole } from './types';

export const TEAM_ROLES = [
  'owner',
  'admin',
  'billing_manager',
  'member',
  'viewer',
] as const satisfies readonly TeamRole[];

export const ROLE_HIERARCHY: Record<TeamRole, number> = {
  owner: 100,
  admin: 80,
  billing_manager: 60,
  member: 40,
  viewer: 20,
};

export const ROLE_METADATA: Record<TeamRole, RoleMetadata> = {
  owner: {
    role: 'owner',
    displayName: 'Workspace Owner',
    description: 'Full authority including workspace deletion, ownership transfer and member governance.',
    weight: 100,
  },
  admin: {
    role: 'admin',
    displayName: 'Administrator',
    description: 'Can manage workspace resources, team invitations, and role assignments below Admin level.',
    weight: 80,
  },
  billing_manager: {
    role: 'billing_manager',
    displayName: 'Billing Manager',
    description: 'Manages subscription plans, invoices, payment methods, and financial reporting.',
    weight: 60,
  },
  member: {
    role: 'member',
    displayName: 'Member',
    description: 'Can create and modify operational resources, run reports, and collaborate within workspace.',
    weight: 40,
  },
  viewer: {
    role: 'viewer',
    displayName: 'Viewer',
    description: 'Read-only access to workspace resources, reports, and team lists.',
    weight: 20,
  },
};

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value);
}

/**
 * Checks if a given user role meets or exceeds the required role in hierarchy.
 * Owner (100) > Admin (80) > BillingManager (60) > Member (40) > Viewer (20)
 */
export function hasRoleAtLeast(currentRole: TeamRole, requiredRole: TeamRole): boolean {
  return (ROLE_HIERARCHY[currentRole] ?? 0) >= (ROLE_HIERARCHY[requiredRole] ?? 0);
}

/**
 * Checks whether an actor role has sufficient authority to assign, modify, or remove a target role.
 * - Owner can assign/modify Admin, BillingManager, Member, Viewer.
 * - Admin can assign/modify BillingManager, Member, Viewer (strictly below Admin).
 * - BillingManager, Member, and Viewer cannot manage roles.
 */
export function canManageRole(actorRole: TeamRole, targetRole: TeamRole): boolean {
  if (actorRole === 'owner') {
    // Owner can manage all subordinate roles; cannot demote owner via standard role change
    return targetRole !== 'owner';
  }
  if (actorRole === 'admin') {
    // Admin can only manage roles strictly lower than Admin
    return (ROLE_HIERARCHY[targetRole] ?? 0) < ROLE_HIERARCHY.admin;
  }
  return false;
}

/**
 * Returns all roles that the given actor role is permitted to invite or assign.
 */
export function getManageableRoles(actorRole: TeamRole): TeamRole[] {
  return TEAM_ROLES.filter((role) => canManageRole(actorRole, role));
}
