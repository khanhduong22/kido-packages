/**
 * @kido/team-rbac - Workspace & Context Switcher
 * Multi-tenant workspace lifecycle, member governance, and active workspace context switching.
 */

import * as crypto from 'crypto';
import type {
  ActiveWorkspaceContext,
  CustomPermissions,
  PermissionSlug,
  TeamRole,
  Workspace,
  WorkspaceMember,
} from './types';
import { canManageRole } from './roles';
import { hasAllPermissions, hasAnyPermission, hasPermission, resolveUserPermissions } from './permissions';

export interface CreateWorkspaceParams {
  name: string;
  ownerId: string;
  slug?: string;
  maxMembers?: number;
  allowedEmailDomains?: string[];
  metadata?: Record<string, unknown>;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Creates a new workspace and automatically designates the creator as Owner.
 */
export function createWorkspace(params: CreateWorkspaceParams): {
  workspace: Workspace;
  ownerMember: WorkspaceMember;
} {
  const now = new Date();
  const id = `ws_${crypto.randomUUID()}`;
  const slug = params.slug || `${slugify(params.name)}-${crypto.randomBytes(3).toString('hex')}`;

  const workspace: Workspace = {
    id,
    name: params.name.trim(),
    slug,
    ownerId: params.ownerId,
    status: 'active',
    maxMembers: params.maxMembers,
    allowedEmailDomains: params.allowedEmailDomains,
    createdAt: now,
    updatedAt: now,
    metadata: params.metadata,
  };

  const ownerMember: WorkspaceMember = {
    workspaceId: id,
    userId: params.ownerId,
    role: 'owner',
    status: 'active',
    joinedAt: now,
  };

  return { workspace, ownerMember };
}

/**
 * Updates workspace properties.
 */
export function updateWorkspace(
  workspace: Workspace,
  patch: Partial<Pick<Workspace, 'name' | 'slug' | 'maxMembers' | 'allowedEmailDomains' | 'metadata'>>
): Workspace {
  if (workspace.status === 'archived') {
    throw new Error('Cannot update an archived workspace.');
  }

  return {
    ...workspace,
    ...patch,
    name: patch.name ? patch.name.trim() : workspace.name,
    slug: patch.slug ? patch.slug.trim().toLowerCase() : workspace.slug,
    updatedAt: new Date(),
  };
}

/**
 * Locks workspace to freeze mutations.
 */
export function lockWorkspace(workspace: Workspace, reason = 'Administrative lock'): Workspace {
  if (workspace.status === 'archived') {
    throw new Error('Cannot lock an archived workspace.');
  }

  return {
    ...workspace,
    status: 'locked',
    lockReason: reason,
    updatedAt: new Date(),
  };
}

/**
 * Unlocks a locked workspace.
 */
export function unlockWorkspace(workspace: Workspace): Workspace {
  if (workspace.status === 'archived') {
    throw new Error('Cannot unlock an archived workspace.');
  }

  return {
    ...workspace,
    status: 'active',
    lockReason: undefined,
    updatedAt: new Date(),
  };
}

/**
 * Archives a workspace into cold storage.
 */
export function archiveWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    status: 'archived',
    updatedAt: new Date(),
  };
}

/**
 * Updates a member's role with strict hierarchy enforcement.
 */
export function updateMemberRole(params: {
  workspace: Workspace;
  actorRole: TeamRole;
  targetMember: WorkspaceMember;
  newRole: TeamRole;
  customPermissions?: CustomPermissions;
}): WorkspaceMember {
  const { workspace, actorRole, targetMember, newRole, customPermissions } = params;

  if (workspace.status !== 'active') {
    throw new Error('Cannot modify members when workspace is not active.');
  }

  if (targetMember.role === 'owner') {
    throw new Error('Cannot modify the workspace owner role directly. Use transferOwnership instead.');
  }

  if (newRole === 'owner') {
    throw new Error('Cannot promote to Owner directly. Use transferOwnership instead.');
  }

  if (!canManageRole(actorRole, targetMember.role)) {
    throw new Error(`Role "${actorRole}" does not have authority over "${targetMember.role}".`);
  }

  if (!canManageRole(actorRole, newRole)) {
    throw new Error(`Role "${actorRole}" does not have authority to assign "${newRole}".`);
  }

  return {
    ...targetMember,
    role: newRole,
    customPermissions: customPermissions ?? targetMember.customPermissions,
  };
}

/**
 * Safely transfers workspace ownership to another active member.
 */
export function transferOwnership(params: {
  workspace: Workspace;
  currentOwnerId: string;
  newOwnerId: string;
  members: WorkspaceMember[];
  demotedOwnerRole?: TeamRole;
}): { workspace: Workspace; updatedMembers: WorkspaceMember[] } {
  const { workspace, currentOwnerId, newOwnerId, members, demotedOwnerRole = 'admin' } = params;

  if (workspace.ownerId !== currentOwnerId) {
    throw new Error('Only current workspace owner can initiate ownership transfer.');
  }

  if (currentOwnerId === newOwnerId) {
    throw new Error('Cannot transfer ownership to yourself.');
  }

  const newOwnerMember = members.find((m) => m.userId === newOwnerId && m.status === 'active');
  if (!newOwnerMember) {
    throw new Error('Target user is not an active member of this workspace.');
  }

  const updatedWorkspace: Workspace = {
    ...workspace,
    ownerId: newOwnerId,
    updatedAt: new Date(),
  };

  const updatedMembers = members.map((m) => {
    if (m.userId === newOwnerId) {
      return { ...m, role: 'owner' as TeamRole };
    }
    if (m.userId === currentOwnerId) {
      return { ...m, role: demotedOwnerRole };
    }
    return m;
  });

  return { workspace: updatedWorkspace, updatedMembers };
}

/**
 * Creates an ActiveWorkspaceContext for a given workspace and member.
 */
export function buildWorkspaceContext(
  workspace: Workspace,
  membership: WorkspaceMember
): ActiveWorkspaceContext {
  const role = membership.role;
  const isOwner = workspace.ownerId === membership.userId || role === 'owner';
  const effectivePermissionsSet = resolveUserPermissions(role, membership.customPermissions);
  const permissions = Array.from(effectivePermissionsSet);

  return {
    workspace,
    membership,
    role,
    permissions,
    isOwner,
    can(permission: PermissionSlug): boolean {
      return hasPermission(role, permission, membership.customPermissions);
    },
    canAll(perms: PermissionSlug[]): boolean {
      return hasAllPermissions(role, perms, membership.customPermissions);
    },
    canAny(perms: PermissionSlug[]): boolean {
      return hasAnyPermission(role, perms, membership.customPermissions);
    },
  };
}

/**
 * Manages tenant switching across multiple workspaces for a user.
 */
export class WorkspaceContextSwitcher {
  private workspaces = new Map<string, Workspace>();
  private members = new Map<string, WorkspaceMember[]>(); // workspaceId -> members

  public registerWorkspace(workspace: Workspace, members: WorkspaceMember[]): void {
    this.workspaces.set(workspace.id, workspace);
    this.members.set(workspace.id, [...members]);
  }

  public getUserWorkspaces(userId: string): Array<{ workspace: Workspace; membership: WorkspaceMember }> {
    const result: Array<{ workspace: Workspace; membership: WorkspaceMember }> = [];

    for (const [workspaceId, members] of this.members.entries()) {
      const membership = members.find((m) => m.userId === userId && m.status === 'active');
      const ws = this.workspaces.get(workspaceId);
      if (membership && ws && ws.status !== 'archived') {
        result.push({ workspace: ws, membership });
      }
    }

    return result;
  }

  /**
   * Switches user's active context to the requested workspace.
   */
  public switchContext(userId: string, targetWorkspaceId: string): ActiveWorkspaceContext {
    const workspace = this.workspaces.get(targetWorkspaceId);
    if (!workspace) {
      throw new Error(`Workspace "${targetWorkspaceId}" not found.`);
    }

    if (workspace.status === 'archived') {
      throw new Error(`Workspace "${targetWorkspaceId}" is archived.`);
    }

    const members = this.members.get(targetWorkspaceId) || [];
    const membership = members.find((m) => m.userId === userId);

    if (!membership || membership.status !== 'active') {
      throw new Error(`User "${userId}" is not an active member of workspace "${targetWorkspaceId}".`);
    }

    return buildWorkspaceContext(workspace, membership);
  }
}
