// M17 — Identity types
//
// Roles map to Presence roles used throughout the harness; clearance
// and purposeOfUse are already enforced by governance in each realm.

export type IdentityRole = 'admin' | 'md' | 'nurse' | 'pharmacist' | 'coder' | 'auditor' | 'facilities-tech' | 'safety';
export type Clearance = 'internal' | 'phi' | 'break-glass';
export type PurposeOfUse = 'operations' | 'treatment' | 'billing' | 'quality' | 'research';

export interface IdentityPrincipal {
  subjectId: string;               // stable IdP subject id
  email: string;
  displayName?: string;
  role: IdentityRole;
  clearance: Clearance;
  purposeOfUse: PurposeOfUse[];
  orgId: string;                   // ProviderOrg
  facilityIds?: string[];          // scope to specific realms; empty = org-wide
  groups?: string[];               // raw IdP groups (for audit)
  source: IdentitySource;
  metadata?: Record<string, string>;
}

export type IdentitySource = 'oidc' | 'saml' | 'workos' | 'scim' | 'invite' | 'break-glass' | 'ldap' | 'local';

export interface IdentityProviderConfig {
  providerId: string;
  displayName: string;
  kind: IdentitySource;
  enabled: boolean;
  orgId: string;
  // OIDC
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes?: string[];
    redirectUri: string;
    groupsClaim?: string;
  };
  // SAML (delegated to WorkOS in practice)
  saml?: {
    entityId: string;
    ssoUrl: string;
    certificate: string;
    workosConnectionId?: string; // when using WorkOS
  };
  // WorkOS SSO / SCIM
  workos?: {
    apiKey: string;
    connectionId?: string;
    directoryId?: string;
  };
  // LDAP (opt-in)
  ldap?: {
    url: string;
    bindDn: string;
    bindPassword: string;
    baseDn: string;
    userFilter: string;
    groupFilter: string;
  };
}

export interface RoleMapping {
  orgId: string;
  entries: Array<{
    idpGroup: string;
    role: IdentityRole;
    clearance: Clearance;
    purposeOfUse: PurposeOfUse[];
    facilityIds?: string[];
  }>;
  defaultRole?: IdentityRole; // used when no mapping matches
}
