/**
 * @kido/team-rbac - Type Definitions
 * Multi-tenant workspace RBAC, permission matrix, invitation lifecycle, and context switcher.
 */

export type TeamRole = 'owner' | 'admin' | 'billing_manager' | 'member' | 'viewer';

export interface RoleMetadata {
  role: TeamRole;
  displayName: string;
  description: string;
  weight: number;
}

export type PermissionModule = 'workspace' | 'team' | 'billing' | 'resources' | 'reports' | 'audit';

export type PermissionSlug =
  // Workspace management
  | 'workspace:view'
  | 'workspace:update'
  | 'workspace:delete'
  | 'workspace:lock'
  | 'workspace:archive'
  // Team membership & invitation
  | 'team:view'
  | 'team:invite'
  | 'team:remove'
  | 'team:role_update'
  // Billing & subscriptions
  | 'billing:view'
  | 'billing:manage'
  | 'billing:upgrade'
  // Resources & items
  | 'resources:view'
  | 'resources:create'
  | 'resources:update'
  | 'resources:delete'
  // Reports & Analytics
  | 'reports:view'
  | 'reports:export'
  // Audit Trail & Logs
  | 'audit:view';

export interface PermissionDefinition {
  slug: PermissionSlug;
  displayName: string;
  description: string;
  module: PermissionModule;
}

export type WorkspaceStatus = 'active' | 'locked' | 'archived';

export type WorkspaceMemberStatus = 'active' | 'pending' | 'suspended';

export interface CustomPermissions {
  allow?: PermissionSlug[];
  deny?: PermissionSlug[];
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  role: TeamRole;
  status: WorkspaceMemberStatus;
  joinedAt: Date;
  customPermissions?: CustomPermissions;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  status: WorkspaceStatus;
  lockReason?: string;
  maxMembers?: number;
  allowedEmailDomains?: string[];
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked';

export interface TeamInvitation {
  id: string;
  workspaceId: string;
  email: string;
  role: TeamRole;
  invitedById: string;
  tokenHash: string;
  status: InvitationStatus;
  expiresAt: Date;
  createdAt: Date;
  acceptedAt?: Date;
  declinedAt?: Date;
  revokedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface InvitationSummary {
  invited: Array<{ email: string; invitation: TeamInvitation; plainToken: string }>;
  alreadyMember: string[];
  alreadyPending: string[];
  skippedSelf: string[];
  domainRejected: string[];
  limitExceeded: string[];
}

export interface CreateInvitationsParams {
  workspace: Workspace;
  emails: string[];
  role?: TeamRole;
  invitedById: string;
  inviterEmail?: string;
  currentMembers: WorkspaceMember[];
  pendingInvitations?: TeamInvitation[];
  secret: string;
  ttlHours?: number;
}

export interface ActiveWorkspaceContext {
  workspace: Workspace;
  membership: WorkspaceMember;
  role: TeamRole;
  permissions: PermissionSlug[];
  isOwner: boolean;
  can(permission: PermissionSlug): boolean;
  canAll(permissions: PermissionSlug[]): boolean;
  canAny(permissions: PermissionSlug[]): boolean;
}
