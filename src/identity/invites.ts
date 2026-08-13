// M17.D — Magic-link invites (free-tier / small-clinic path).
//
// Signed tokens (HMAC-SHA256) with configurable secret & TTL. Admin
// creates invites; recipient claims by presenting the token; a
// principal is created from the invite metadata. Idempotent claim
// (same token reused → same principal).

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type { IdentityPrincipal, IdentityRole, Clearance, PurposeOfUse } from './types.js';
import { IdentityRegistry } from './registry.js';

let inviteSecret = process.env['INVITE_SECRET'] || 'change-me-in-prod-please';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;

export function setInviteSecret(secret: string): void { inviteSecret = secret; }

interface InvitePayload {
  invId: string;
  orgId: string;
  email: string;
  role: IdentityRole;
  clearance: Clearance;
  purposeOfUse: PurposeOfUse[];
  facilityIds?: string[];
  invitedBy?: string;
  createdAt: number;
  expiresAt: number;
}

interface InviteRecord extends InvitePayload {
  status: 'pending' | 'claimed' | 'revoked';
  claimedAt?: number;
  claimedBySubjectId?: string;
  token?: string;
}

const invites = new Map<string, InviteRecord>();

function sign(payload: InvitePayload): string {
  const json = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', inviteSecret).update(json).digest('base64url');
  return `${json}.${mac}`;
}

function verify(token: string): InvitePayload {
  const [json, mac] = token.split('.');
  if (!json || !mac) throw new Error('invite-token-malformed');
  const expected = createHmac('sha256', inviteSecret).update(json).digest();
  const actual = Buffer.from(mac, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('invite-token-signature-invalid');
  const payload = JSON.parse(Buffer.from(json, 'base64url').toString('utf8')) as InvitePayload;
  if (Date.now() > payload.expiresAt) throw new Error('invite-token-expired');
  return payload;
}

export function createInvite(input: {
  orgId: string;
  email: string;
  role: IdentityRole;
  clearance?: Clearance;
  purposeOfUse?: PurposeOfUse[];
  facilityIds?: string[];
  invitedBy?: string;
  ttlMs?: number;
}): { invId: string; token: string; url: string; expiresAt: string } {
  const now = Date.now();
  const invId = `inv-${now}-${randomBytes(3).toString('hex')}`;
  const payload: InvitePayload = {
    invId,
    orgId: input.orgId,
    email: input.email,
    role: input.role,
    clearance: input.clearance ?? 'internal',
    purposeOfUse: input.purposeOfUse ?? ['operations'],
    ...(input.facilityIds ? { facilityIds: input.facilityIds } : {}),
    ...(input.invitedBy ? { invitedBy: input.invitedBy } : {}),
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
  };
  const token = sign(payload);
  const record: InviteRecord = { ...payload, status: 'pending', token };
  invites.set(invId, record);
  IdentityRegistry.audit('invite.created', { subjectId: input.email, note: `orgId=${input.orgId} role=${input.role}` });
  return {
    invId,
    token,
    url: `/invites/claim?token=${encodeURIComponent(token)}`,
    expiresAt: new Date(payload.expiresAt).toISOString(),
  };
}

export function listInvites(orgId?: string): InviteRecord[] {
  const all = [...invites.values()];
  return orgId ? all.filter((i) => i.orgId === orgId) : all;
}

export function getInvite(invId: string): InviteRecord | undefined { return invites.get(invId); }

export function revokeInvite(invId: string): boolean {
  const rec = invites.get(invId);
  if (!rec || rec.status !== 'pending') return false;
  rec.status = 'revoked';
  invites.set(invId, rec);
  IdentityRegistry.audit('invite.revoked', { subjectId: rec.email });
  return true;
}

export function claimInvite(token: string, opts: { displayName?: string } = {}): IdentityPrincipal {
  const payload = verify(token);
  const rec = invites.get(payload.invId);
  if (!rec) throw new Error('invite-not-found');
  if (rec.status === 'revoked') throw new Error('invite-revoked');
  if (rec.status === 'claimed' && rec.claimedBySubjectId) {
    const existing = IdentityRegistry.getPrincipal(rec.claimedBySubjectId);
    if (existing) return existing;
  }
  const subjectId = `local-${payload.email}`;
  const principal: IdentityPrincipal = {
    subjectId,
    email: payload.email,
    ...(opts.displayName ? { displayName: opts.displayName } : {}),
    role: payload.role,
    clearance: payload.clearance,
    purposeOfUse: payload.purposeOfUse,
    orgId: payload.orgId,
    ...(payload.facilityIds ? { facilityIds: payload.facilityIds } : {}),
    source: 'invite',
    metadata: { invId: payload.invId, ...(payload.invitedBy ? { invitedBy: payload.invitedBy } : {}) },
  };
  IdentityRegistry.upsertPrincipal(principal);
  rec.status = 'claimed';
  rec.claimedAt = Date.now();
  rec.claimedBySubjectId = subjectId;
  invites.set(payload.invId, rec);
  IdentityRegistry.audit('invite.claimed', { subjectId, note: `invId=${payload.invId}` });
  return principal;
}
