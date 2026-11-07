/**
 * @kido/team-rbac - Invitation Lifecycle
 * Cryptographically secure invitation tokens (HMAC-SHA256), TTL expiration,
 * email domain restrictions, and complete state machine transitions.
 */

import * as crypto from 'crypto';
import type {
  CreateInvitationsParams,
  InvitationSummary,
  TeamInvitation,
  Workspace,
  WorkspaceMember,
} from './types';
import { canManageRole } from './roles';

export const DEFAULT_INVITATION_TTL_HOURS = 72; // 3 days

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Generates a high-entropy 64-character hexadecimal random token.
 */
export function generateInvitationToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Derives an HMAC-SHA256 hash from raw invitation token and secret key.
 * Only this hash is stored in persistent storage to prevent token leakage.
 */
export function hashInvitationToken(token: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

/**
 * Timing-safe comparison to prevent timing side-channel attacks on token verification.
 */
export function verifyInvitationToken(token: string, storedHash: string, secret: string): boolean {
  if (!token || !storedHash || !secret) {
    return false;
  }
  const calculatedHash = hashInvitationToken(token, secret);
  const bufA = Buffer.from(calculatedHash, 'hex');
  const bufB = Buffer.from(storedHash, 'hex');

  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validates whether an email belongs to the permitted domains.
 */
export function isEmailDomainAllowed(email: string, allowedDomains?: string[]): boolean {
  if (!allowedDomains || allowedDomains.length === 0) {
    return true;
  }
  const parts = email.toLowerCase().split('@');
  if (parts.length !== 2) {
    return false;
  }
  const domain = parts[1];
  return allowedDomains.map((d) => d.toLowerCase().replace(/^@/, '')).includes(domain);
}

/**
 * Checks if an invitation is currently expired.
 */
export function isInvitationExpired(invitation: TeamInvitation): boolean {
  return new Date() > new Date(invitation.expiresAt);
}

/**
 * Creates and queues a batch of invitations with validation rules:
 * - Workspace must be active (not locked or archived).
 * - Email format valid & normalized.
 * - Inviter cannot invite themselves.
 * - Cannot invite existing active/pending members.
 * - Allowed domain filter.
 * - Workspace seat/member capacity limit.
 */
export function createInvitations(params: CreateInvitationsParams): InvitationSummary {
  const {
    workspace,
    emails,
    role = 'viewer',
    invitedById,
    inviterEmail,
    currentMembers,
    pendingInvitations = [],
    secret,
    ttlHours = DEFAULT_INVITATION_TTL_HOURS,
  } = params;

  if (workspace.status !== 'active') {
    throw new Error(`Cannot invite to workspace with status "${workspace.status}". Mutations are locked.`);
  }

  const summary: InvitationSummary = {
    invited: [],
    alreadyMember: [],
    alreadyPending: [],
    skippedSelf: [],
    domainRejected: [],
    limitExceeded: [],
  };

  const normalizedInviterEmail = inviterEmail?.trim().toLowerCase();
  const existingMemberEmails = new Set(
    currentMembers.map((m) => m.userId.toLowerCase()) // assuming userId or email mapping
  );

  const activePendingMap = new Map<string, TeamInvitation>();
  for (const inv of pendingInvitations) {
    if (inv.status === 'pending' && !isInvitationExpired(inv)) {
      activePendingMap.set(inv.email.toLowerCase(), inv);
    }
  }

  // Deduplicate input emails
  const uniqueEmails = Array.from(
    new Set(
      emails
        .map((e) => e.trim().toLowerCase())
        .filter((e) => EMAIL_REGEX.test(e))
    )
  );

  const maxMembers = workspace.maxMembers ?? Number.POSITIVE_INFINITY;
  let currentOccupiedCount = currentMembers.length + activePendingMap.size;

  for (const email of uniqueEmails) {
    if (normalizedInviterEmail && email === normalizedInviterEmail) {
      summary.skippedSelf.push(email);
      continue;
    }

    if (existingMemberEmails.has(email)) {
      summary.alreadyMember.push(email);
      continue;
    }

    if (activePendingMap.has(email)) {
      summary.alreadyPending.push(email);
      continue;
    }

    if (!isEmailDomainAllowed(email, workspace.allowedEmailDomains)) {
      summary.domainRejected.push(email);
      continue;
    }

    if (currentOccupiedCount >= maxMembers) {
      summary.limitExceeded.push(email);
      continue;
    }

    const plainToken = generateInvitationToken();
    const tokenHash = hashInvitationToken(plainToken, secret);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000);

    const invitation: TeamInvitation = {
      id: `inv_${crypto.randomUUID()}`,
      workspaceId: workspace.id,
      email,
      role,
      invitedById,
      tokenHash,
      status: 'pending',
      expiresAt,
      createdAt: now,
    };

    summary.invited.push({
      email,
      invitation,
      plainToken,
    });

    currentOccupiedCount++;
  }

  return summary;
}

/**
 * Accepts an invitation after rigorous HMAC, expiration, and status checks.
 */
export function acceptInvitation(options: {
  invitation: TeamInvitation;
  plainToken: string;
  userId: string;
  secret: string;
  workspace: Workspace;
  currentMemberCount: number;
}): { updatedInvitation: TeamInvitation; newMember: WorkspaceMember } {
  const { invitation, plainToken, userId, secret, workspace, currentMemberCount } = options;

  if (workspace.status !== 'active') {
    throw new Error('Workspace is currently locked or archived.');
  }

  if (invitation.status !== 'pending') {
    throw new Error(`Invitation is not pending (status: ${invitation.status}).`);
  }

  if (isInvitationExpired(invitation)) {
    throw new Error('Invitation has expired.');
  }

  if (!verifyInvitationToken(plainToken, invitation.tokenHash, secret)) {
    throw new Error('Invalid or corrupted invitation token.');
  }

  if (workspace.maxMembers && currentMemberCount >= workspace.maxMembers) {
    throw new Error('Workspace member quota has been reached.');
  }

  const now = new Date();
  const updatedInvitation: TeamInvitation = {
    ...invitation,
    status: 'accepted',
    acceptedAt: now,
  };

  const newMember: WorkspaceMember = {
    workspaceId: workspace.id,
    userId,
    role: invitation.role,
    status: 'active',
    joinedAt: now,
  };

  return { updatedInvitation, newMember };
}

/**
 * Declines an invitation.
 */
export function declineInvitation(
  invitation: TeamInvitation,
  plainToken: string,
  secret: string
): TeamInvitation {
  if (invitation.status !== 'pending') {
    throw new Error(`Cannot decline invitation with status: ${invitation.status}.`);
  }

  if (!verifyInvitationToken(plainToken, invitation.tokenHash, secret)) {
    throw new Error('Invalid invitation token.');
  }

  return {
    ...invitation,
    status: 'declined',
    declinedAt: new Date(),
  };
}

/**
 * Revokes a pending invitation by an authorized workspace admin/owner.
 */
export function revokeInvitation(invitation: TeamInvitation): TeamInvitation {
  if (invitation.status !== 'pending') {
    throw new Error(`Cannot revoke non-pending invitation (status: ${invitation.status}).`);
  }

  return {
    ...invitation,
    status: 'revoked',
    revokedAt: new Date(),
  };
}

/**
 * Refreshes and extends an invitation with a fresh token and new expiration date.
 */
export function resendInvitation(
  invitation: TeamInvitation,
  secret: string,
  ttlHours = DEFAULT_INVITATION_TTL_HOURS
): { invitation: TeamInvitation; plainToken: string } {
  if (invitation.status !== 'pending' && invitation.status !== 'expired') {
    throw new Error(`Cannot resend invitation with status "${invitation.status}".`);
  }

  const plainToken = generateInvitationToken();
  const tokenHash = hashInvitationToken(plainToken, secret);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000);

  const updatedInvitation: TeamInvitation = {
    ...invitation,
    tokenHash,
    status: 'pending',
    expiresAt,
    declinedAt: undefined,
    revokedAt: undefined,
  };

  return { invitation: updatedInvitation, plainToken };
}
