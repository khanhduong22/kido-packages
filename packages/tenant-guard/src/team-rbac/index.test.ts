import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_PERMISSIONS,
  ROLE_HIERARCHY,
  ROLE_METADATA,
  TEAM_ROLES,
  WorkspaceContextSwitcher,
  acceptInvitation,
  archiveWorkspace,
  buildWorkspaceContext,
  canManageRole,
  createInvitations,
  createWorkspace,
  declineInvitation,
  generateInvitationToken,
  getManageableRoles,
  getPermissionsForRole,
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  hasRoleAtLeast,
  hashInvitationToken,
  isEmailDomainAllowed,
  isInvitationExpired,
  isTeamRole,
  lockWorkspace,
  resendInvitation,
  resolveUserPermissions,
  revokeInvitation,
  transferOwnership,
  unlockWorkspace,
  updateMemberRole,
  updateWorkspace,
  verifyInvitationToken,
} from '../index';
import type { TeamInvitation, Workspace, WorkspaceMember } from '../index';

function expect(actual: any) {
  return {
    toBe(expected: any) {
      assert.equal(actual, expected);
    },
    toEqual(expected: any) {
      assert.deepEqual(actual, expected);
    },
    toContain(item: any) {
      assert.ok(Array.isArray(actual) && actual.includes(item));
    },
    toBeDefined() {
      assert.notEqual(actual, undefined);
    },
    toThrow(msg?: string) {
      if (msg) {
        assert.throws(actual, new RegExp(msg, 'i'));
      } else {
        assert.throws(actual);
      }
    },
  };
}

const TEST_SECRET = 'ultra_secure_rbac_hmac_secret_2026';

describe('@kido/team-rbac', () => {
  describe('Roles & Hierarchy', () => {
    it('validates role membership and metadata', () => {
      expect(isTeamRole('owner')).toBe(true);
      expect(isTeamRole('admin')).toBe(true);
      expect(isTeamRole('superman')).toBe(false);
      expect(TEAM_ROLES.length).toBe(5);

      expect(ROLE_METADATA.owner.weight).toBe(100);
      expect(ROLE_METADATA.viewer.weight).toBe(20);
    });

    it('enforces role hierarchy comparison (hasRoleAtLeast)', () => {
      expect(hasRoleAtLeast('owner', 'admin')).toBe(true);
      expect(hasRoleAtLeast('admin', 'billing_manager')).toBe(true);
      expect(hasRoleAtLeast('billing_manager', 'member')).toBe(true);
      expect(hasRoleAtLeast('member', 'viewer')).toBe(true);

      expect(hasRoleAtLeast('member', 'admin')).toBe(false);
      expect(hasRoleAtLeast('viewer', 'member')).toBe(false);
    });

    it('governs role delegation authority (canManageRole)', () => {
      // Owner can manage all subordinate roles
      expect(canManageRole('owner', 'admin')).toBe(true);
      expect(canManageRole('owner', 'member')).toBe(true);
      expect(canManageRole('owner', 'owner')).toBe(false); // cannot self-demote directly

      // Admin can manage billing_manager, member, viewer, but NOT owner or admin
      expect(canManageRole('admin', 'billing_manager')).toBe(true);
      expect(canManageRole('admin', 'member')).toBe(true);
      expect(canManageRole('admin', 'viewer')).toBe(true);
      expect(canManageRole('admin', 'admin')).toBe(false);
      expect(canManageRole('admin', 'owner')).toBe(false);

      // Members cannot manage roles
      expect(canManageRole('member', 'viewer')).toBe(false);
      expect(canManageRole('viewer', 'viewer')).toBe(false);

      expect(getManageableRoles('admin')).toEqual(['billing_manager', 'member', 'viewer']);
    });
  });

  describe('Permission Matrix & Overrides', () => {
    it('grants full authority to Owner including destructive actions', () => {
      expect(hasPermission('owner', 'workspace:delete')).toBe(true);
      expect(hasPermission('owner', 'workspace:update')).toBe(true);
      expect(hasPermission('owner', 'team:invite')).toBe(true);
      expect(hasPermission('owner', 'billing:manage')).toBe(true);
    });

    it('protects destructive actions from Admin while keeping operational control', () => {
      expect(hasPermission('admin', 'workspace:delete')).toBe(false);
      expect(hasPermission('admin', 'workspace:update')).toBe(true);
      expect(hasPermission('admin', 'team:invite')).toBe(true);
      expect(hasPermission('admin', 'resources:create')).toBe(true);
    });

    it('restricts BillingManager, Member, and Viewer appropriately', () => {
      // BillingManager
      expect(hasPermission('billing_manager', 'billing:manage')).toBe(true);
      expect(hasPermission('billing_manager', 'resources:create')).toBe(false);

      // Member
      expect(hasPermission('member', 'resources:create')).toBe(true);
      expect(hasPermission('member', 'billing:manage')).toBe(false);
      expect(hasPermission('member', 'team:invite')).toBe(false);

      // Viewer
      expect(hasPermission('viewer', 'resources:view')).toBe(true);
      expect(hasPermission('viewer', 'resources:create')).toBe(false);
    });

    it('applies custom per-member permission overrides (allow and deny)', () => {
      // Allow extra permission for a member
      const canManageBilling = hasPermission('member', 'billing:manage', {
        allow: ['billing:manage'],
      });
      expect(canManageBilling).toBe(true);

      // Deny a default permission
      const canCreate = hasPermission('member', 'resources:create', {
        deny: ['resources:create'],
      });
      expect(canCreate).toBe(false);
    });

    it('checks composite permissions (hasAllPermissions / hasAnyPermission)', () => {
      expect(hasAllPermissions('admin', ['workspace:update', 'team:invite'])).toBe(true);
      expect(hasAllPermissions('member', ['resources:create', 'billing:manage'])).toBe(false);

      expect(hasAnyPermission('member', ['billing:manage', 'resources:create'])).toBe(true);
      expect(hasAnyPermission('viewer', ['billing:manage', 'workspace:delete'])).toBe(false);
    });
  });

  describe('Invitation Lifecycle with HMAC Security', () => {
    it('generates high entropy tokens and verifies with HMAC timing-safe equality', () => {
      const rawToken = generateInvitationToken();
      expect(rawToken.length).toBe(64);

      const hash = hashInvitationToken(rawToken, TEST_SECRET);
      expect(hash.length).toBe(64);

      expect(verifyInvitationToken(rawToken, hash, TEST_SECRET)).toBe(true);
      expect(verifyInvitationToken('tampered_token', hash, TEST_SECRET)).toBe(false);
      expect(verifyInvitationToken(rawToken, hash, 'wrong_secret')).toBe(false);
    });

    it('validates allowed email domains', () => {
      expect(isEmailDomainAllowed('dev@acme.com', ['acme.com', 'partner.io'])).toBe(true);
      expect(isEmailDomainAllowed('dev@gmail.com', ['acme.com'])).toBe(false);
      expect(isEmailDomainAllowed('dev@gmail.com', [])).toBe(true); // empty allowedDomains allows all
      expect(isEmailDomainAllowed('dev@gmail.com', undefined)).toBe(true);
    });

    it('creates batch invitations with filtering, deduplication and domain restrictions', () => {
      const { workspace, ownerMember } = createWorkspace({
        name: 'Acme Enterprise',
        ownerId: 'usr_owner_1',
        allowedEmailDomains: ['company.com'],
        maxMembers: 5,
      });

      const summary = createInvitations({
        workspace,
        emails: [
          'alice@company.com',
          'bob@company.com',
          'hacker@gmail.com', // domain rejected
          'usr_owner_1@company.com', // self invite
          'alice@company.com', // duplicate
        ],
        invitedById: ownerMember.userId,
        inviterEmail: 'usr_owner_1@company.com',
        currentMembers: [ownerMember],
        secret: TEST_SECRET,
        role: 'member',
      });

      expect(summary.invited.length).toBe(2);
      expect(summary.domainRejected).toContain('hacker@gmail.com');
      expect(summary.skippedSelf).toContain('usr_owner_1@company.com');

      const aliceInv = summary.invited.find((i) => i.email === 'alice@company.com');
      expect(aliceInv).toBeDefined();
      expect(aliceInv!.invitation.tokenHash).toBeDefined();
      expect(aliceInv!.plainToken.length).toBe(64);
    });

    it('enforces workspace member quota limits on invitation batches', () => {
      const { workspace, ownerMember } = createWorkspace({
        name: 'Small Startup',
        ownerId: 'usr_1',
        maxMembers: 2, // 1 owner + 1 slot available
      });

      const summary = createInvitations({
        workspace,
        emails: ['user1@test.com', 'user2@test.com'],
        invitedById: 'usr_1',
        currentMembers: [ownerMember],
        secret: TEST_SECRET,
      });

      expect(summary.invited.length).toBe(1);
      expect(summary.limitExceeded).toContain('user2@test.com');
    });

    it('handles full lifecycle: create -> accept -> decline -> resend -> revoke', () => {
      const { workspace, ownerMember } = createWorkspace({
        name: 'Workflow Workspace',
        ownerId: 'usr_owner',
      });

      const summary = createInvitations({
        workspace,
        emails: ['newhire@workflow.io'],
        invitedById: 'usr_owner',
        currentMembers: [ownerMember],
        secret: TEST_SECRET,
        role: 'member',
      });

      const item = summary.invited[0];

      // 1. Accept
      const { updatedInvitation, newMember } = acceptInvitation({
        invitation: item.invitation,
        plainToken: item.plainToken,
        userId: 'usr_newhire_99',
        secret: TEST_SECRET,
        workspace,
        currentMemberCount: 1,
      });

      expect(updatedInvitation.status).toBe('accepted');
      expect(newMember.userId).toBe('usr_newhire_99');
      expect(newMember.role).toBe('member');
      expect(newMember.status).toBe('active');

      // 2. Reject expired token
      const expiredInv: TeamInvitation = {
        ...item.invitation,
        expiresAt: new Date(Date.now() - 10000), // in the past
      };
      expect(isInvitationExpired(expiredInv)).toBe(true);
      expect(() =>
        acceptInvitation({
          invitation: expiredInv,
          plainToken: item.plainToken,
          userId: 'usr_2',
          secret: TEST_SECRET,
          workspace,
          currentMemberCount: 1,
        })
      ).toThrow('expired');

      // 3. Resend invitation
      const resent = resendInvitation(expiredInv, TEST_SECRET, 48);
      expect(resent.invitation.status).toBe('pending');
      expect(isInvitationExpired(resent.invitation)).toBe(false);
      expect(verifyInvitationToken(resent.plainToken, resent.invitation.tokenHash, TEST_SECRET)).toBe(true);

      // 4. Revoke
      const revoked = revokeInvitation(resent.invitation);
      expect(revoked.status).toBe('revoked');
    });
  });

  describe('Workspace Governance & Multi-Tenant Context Switcher', () => {
    it('manages workspace lifecycle (create, update, lock, unlock, archive)', () => {
      const { workspace, ownerMember } = createWorkspace({
        name: 'Alpha Corp',
        ownerId: 'usr_ceo',
      });

      expect(workspace.status).toBe('active');
      expect(ownerMember.role).toBe('owner');

      const updated = updateWorkspace(workspace, { name: 'Alpha Corp International' });
      expect(updated.name).toBe('Alpha Corp International');

      const locked = lockWorkspace(updated, 'Payment overdue');
      expect(locked.status).toBe('locked');
      expect(locked.lockReason).toBe('Payment overdue');

      const unlocked = unlockWorkspace(locked);
      expect(unlocked.status).toBe('active');

      const archived = archiveWorkspace(unlocked);
      expect(archived.status).toBe('archived');
      expect(() => updateWorkspace(archived, { name: 'New Name' })).toThrow('archived');
    });

    it('enforces member role updates and prevents illegal promotions', () => {
      const { workspace, ownerMember } = createWorkspace({
        name: 'Beta Team',
        ownerId: 'usr_owner',
      });

      const member1: WorkspaceMember = {
        workspaceId: workspace.id,
        userId: 'usr_member_1',
        role: 'member',
        status: 'active',
        joinedAt: new Date(),
      };

      const adminMember: WorkspaceMember = {
        workspaceId: workspace.id,
        userId: 'usr_admin',
        role: 'admin',
        status: 'active',
        joinedAt: new Date(),
      };

      // Owner can promote member to admin
      const promotedByOwner = updateMemberRole({
        workspace,
        actorRole: ownerMember.role,
        targetMember: member1,
        newRole: 'admin',
      });
      expect(promotedByOwner.role).toBe('admin');

      // Admin CANNOT promote member to owner
      expect(() =>
        updateMemberRole({
          workspace,
          actorRole: adminMember.role,
          targetMember: member1,
          newRole: 'owner',
        })
      ).toThrow();

      // Admin CANNOT promote member to admin
      expect(() =>
        updateMemberRole({
          workspace,
          actorRole: adminMember.role,
          targetMember: member1,
          newRole: 'admin',
        })
      ).toThrow();
    });

    it('transfers workspace ownership cleanly', () => {
      const { workspace, ownerMember } = createWorkspace({
        name: 'Transferable WS',
        ownerId: 'usr_old_owner',
      });

      const targetMember: WorkspaceMember = {
        workspaceId: workspace.id,
        userId: 'usr_new_owner',
        role: 'admin',
        status: 'active',
        joinedAt: new Date(),
      };

      const { workspace: newWs, updatedMembers } = transferOwnership({
        workspace,
        currentOwnerId: 'usr_old_owner',
        newOwnerId: 'usr_new_owner',
        members: [ownerMember, targetMember],
      });

      expect(newWs.ownerId).toBe('usr_new_owner');
      const newOwner = updatedMembers.find((m) => m.userId === 'usr_new_owner');
      const oldOwner = updatedMembers.find((m) => m.userId === 'usr_old_owner');
      expect(newOwner?.role).toBe('owner');
      expect(oldOwner?.role).toBe('admin');
    });

    it('switches active workspace context with permission resolution', () => {
      const switcher = new WorkspaceContextSwitcher();

      const ws1 = createWorkspace({ name: 'Workspace A', ownerId: 'usr_alice' });
      const ws2 = createWorkspace({ name: 'Workspace B', ownerId: 'usr_bob' });

      // Alice is Owner in WS1, and Member in WS2
      const aliceInWs2: WorkspaceMember = {
        workspaceId: ws2.workspace.id,
        userId: 'usr_alice',
        role: 'member',
        status: 'active',
        joinedAt: new Date(),
      };

      switcher.registerWorkspace(ws1.workspace, [ws1.ownerMember]);
      switcher.registerWorkspace(ws2.workspace, [ws2.ownerMember, aliceInWs2]);

      const userWorkspaces = switcher.getUserWorkspaces('usr_alice');
      expect(userWorkspaces.length).toBe(2);

      // Switch to Workspace A (Owner)
      const contextA = switcher.switchContext('usr_alice', ws1.workspace.id);
      expect(contextA.isOwner).toBe(true);
      expect(contextA.role).toBe('owner');
      expect(contextA.can('workspace:delete')).toBe(true);
      expect(contextA.can('team:invite')).toBe(true);

      // Switch to Workspace B (Member)
      const contextB = switcher.switchContext('usr_alice', ws2.workspace.id);
      expect(contextB.isOwner).toBe(false);
      expect(contextB.role).toBe('member');
      expect(contextB.can('resources:create')).toBe(true);
      expect(contextB.can('workspace:delete')).toBe(false);
      expect(contextB.can('team:invite')).toBe(false);

      // Switch to non-existent or un-enrolled workspace throws
      expect(() => switcher.switchContext('usr_alice', 'ws_random_unknown')).toThrow();
    });
  });
});
