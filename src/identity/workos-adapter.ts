// M17.B — WorkOS adapter.
//
// Delegates SAML SSO and SCIM directory sync to WorkOS. This is the
// production path for the long-tail of IdPs (Ping, OneLogin, JumpCloud,
// ADFS, Okta, Entra ID, Google, ~40 providers) — the industry-standard
// approach for SSO in B2B SaaS.

import type { IdentityPrincipal, IdentityProviderConfig } from './types.js';
import { IdentityRegistry } from './registry.js';

interface WorkOSProfile {
  id: string;
  connection_id: string;
  organization_id?: string;
  email: string;
  first_name?: string;
  last_name?: string;
  groups?: string[];
  raw_attributes?: Record<string, unknown>;
}

interface WorkOSAuthResponse {
  profile: WorkOSProfile;
  access_token?: string;
}

/** Get the authorization URL for a WorkOS SSO connection. */
export function beginWorkOSSso(providerId: string, redirectUri: string): { url: string } {
  const provider = IdentityRegistry.getProvider(providerId);
  if (!provider?.workos?.apiKey || !provider.workos.connectionId) throw new Error(`workos-provider-not-configured:${providerId}`);
  const url = 'https://api.workos.com/sso/authorize?' + new URLSearchParams({
    client_id: provider.workos.apiKey,
    redirect_uri: redirectUri,
    response_type: 'code',
    connection: provider.workos.connectionId,
    state: providerId,
  }).toString();
  return { url };
}

/** Exchange a WorkOS code for a user profile and create a principal. */
export async function handleWorkOSCallback(providerId: string, code: string): Promise<IdentityPrincipal> {
  const provider = IdentityRegistry.getProvider(providerId);
  if (!provider?.workos?.apiKey) throw new Error(`workos-provider-not-configured:${providerId}`);

  const res = await fetch('https://api.workos.com/sso/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: provider.workos.apiKey,
      client_secret: provider.workos.apiKey, // WorkOS uses api key
      grant_type: 'authorization_code',
      code,
    }),
  });
  if (!res.ok) throw new Error(`workos-token-exchange-failed:${res.status}`);
  const body = await res.json() as WorkOSAuthResponse;
  return upsertFromWorkOSProfile(provider, body.profile);
}

function upsertFromWorkOSProfile(provider: IdentityProviderConfig, profile: WorkOSProfile): IdentityPrincipal {
  const groups = profile.groups ?? [];
  const resolved = IdentityRegistry.resolveRole(provider.orgId, groups);
  const displayName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.email;
  const principal: IdentityPrincipal = {
    subjectId: profile.id,
    email: profile.email,
    displayName,
    role: resolved.role,
    clearance: resolved.clearance,
    purposeOfUse: resolved.purposeOfUse,
    orgId: provider.orgId,
    ...(resolved.facilityIds ? { facilityIds: resolved.facilityIds } : {}),
    groups,
    source: 'workos',
    metadata: profile.connection_id ? { workosConnectionId: profile.connection_id } : {},
  };
  IdentityRegistry.upsertPrincipal(principal);
  IdentityRegistry.audit('workos.login', { subjectId: principal.subjectId, providerId: provider.providerId });
  return principal;
}

/** Pull-mode directory sync — used by cron or manual admin trigger. */
export async function syncWorkOSDirectory(providerId: string): Promise<{ upserted: number; deprovisioned: number }> {
  const provider = IdentityRegistry.getProvider(providerId);
  if (!provider?.workos?.apiKey || !provider.workos.directoryId) throw new Error(`workos-directory-not-configured:${providerId}`);

  // Fetch users
  const usersRes = await fetch(`https://api.workos.com/directory_users?directory=${provider.workos.directoryId}&limit=100`, {
    headers: { Authorization: `Bearer ${provider.workos.apiKey}` },
  });
  if (!usersRes.ok) throw new Error(`workos-users-fetch-failed:${usersRes.status}`);
  const usersJson = await usersRes.json() as { data: Array<{ id: string; emails: Array<{ value: string; primary?: boolean }>; first_name?: string; last_name?: string; state: string; groups?: Array<{ name: string }> }> };

  const seenSubjects = new Set<string>();
  let upserted = 0;
  for (const u of usersJson.data) {
    const email = u.emails.find((e) => e.primary)?.value ?? u.emails[0]?.value ?? '';
    const groups = (u.groups ?? []).map((g) => g.name);
    const profile: WorkOSProfile = {
      id: u.id,
      connection_id: provider.workos.directoryId!,
      email,
      first_name: u.first_name ?? '',
      last_name: u.last_name ?? '',
      groups,
    };
    if (u.state === 'active') {
      upsertFromWorkOSProfile(provider, profile);
      seenSubjects.add(u.id);
      upserted++;
    }
  }

  // Deprovision principals from this provider that are no longer active
  let deprovisioned = 0;
  for (const p of IdentityRegistry.listPrincipals(provider.orgId)) {
    if (p.source === 'workos' && !seenSubjects.has(p.subjectId)) {
      IdentityRegistry.deprovision(p.subjectId);
      deprovisioned++;
    }
  }
  IdentityRegistry.audit('workos.directory-sync', { providerId, note: `upserted=${upserted} deprovisioned=${deprovisioned}` });
  return { upserted, deprovisioned };
}
