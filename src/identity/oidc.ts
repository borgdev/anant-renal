/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

// M17.A — OIDC (Authorization Code + PKCE) verifier.
//
// Real OIDC: state + nonce, PKCE code_verifier/challenge (S256),
// discovery via .well-known, token exchange, ID-token JWT verification
// using a JWKS fetched from the issuer. No external dependencies —
// uses only node:crypto and fetch.
//
// This is transport for authentication. Actual session issuance and
// principal creation are done by IdentityRegistry.upsertPrincipal
// with the resolved role/clearance from role-mapper.

import { createHash, randomBytes, createVerify } from 'node:crypto';
import type { IdentityProviderConfig, IdentityPrincipal } from './types.js';
import { IdentityRegistry } from './registry.js';

interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

interface AuthFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  providerId: string;
  createdAt: number;
}

const flowStates = new Map<string, AuthFlowState>();
const discoveryCache = new Map<string, { doc: DiscoveryDoc; fetchedAt: number }>();
const jwksCache = new Map<string, { keys: JsonWebKey[]; fetchedAt: number }>();
const DISCOVERY_TTL_MS = 5 * 60_000;
const JWKS_TTL_MS = 60 * 60_000;

interface JsonWebKey {
  kid?: string;
  kty: string;
  use?: string;
  alg?: string;
  n?: string; e?: string;      // RSA
  x?: string; y?: string; crv?: string; // EC
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function beginAuth(providerId: string): { url: string; state: string } {
  const provider = IdentityRegistry.getProvider(providerId);
  if (!provider || provider.kind !== 'oidc' || !provider.oidc) throw new Error(`oidc-provider-not-found:${providerId}`);
  if (!provider.enabled) throw new Error(`oidc-provider-disabled:${providerId}`);
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(16));
  const codeVerifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(codeVerifier).digest());
  flowStates.set(state, { state, nonce, codeVerifier, providerId, createdAt: Date.now() });

  const scopes = (provider.oidc.scopes ?? ['openid', 'email', 'profile', 'groups']).join(' ');
  const url = `${provider.oidc.issuer.replace(/\/$/, '')}/authorize?` + new URLSearchParams({
    client_id: provider.oidc.clientId,
    response_type: 'code',
    scope: scopes,
    redirect_uri: provider.oidc.redirectUri,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return { url, state };
}

async function fetchDiscovery(issuer: string): Promise<DiscoveryDoc> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.doc;
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`oidc-discovery-failed:${res.status}`);
  const doc = await res.json() as DiscoveryDoc;
  discoveryCache.set(issuer, { doc, fetchedAt: Date.now() });
  return doc;
}

async function fetchJwks(jwksUri: string): Promise<JsonWebKey[]> {
  const cached = jwksCache.get(jwksUri);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const res = await fetch(jwksUri);
  if (!res.ok) throw new Error(`oidc-jwks-failed:${res.status}`);
  const j = await res.json() as { keys: JsonWebKey[] };
  jwksCache.set(jwksUri, { keys: j.keys, fetchedAt: Date.now() });
  return j.keys;
}

function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: string; signature: Buffer } {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('jwt-malformed');
  const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  const signature = Buffer.from(parts[2]!, 'base64url');
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature };
}

/** Verify RS256 ID token against a JWKS. Returns payload if valid. */
function verifyRs256(jwt: string, jwks: JsonWebKey[]): Record<string, unknown> {
  const { header, payload, signingInput, signature } = decodeJwt(jwt);
  if (header['alg'] !== 'RS256') throw new Error(`unsupported-alg:${String(header['alg'])}`);
  const kid = header['kid'] as string | undefined;
  const key = jwks.find((k) => (kid ? k.kid === kid : true) && k.kty === 'RSA');
  if (!key || !key.n || !key.e) throw new Error('jwt-no-matching-key');

  // Build a PEM from JWK n,e using ASN.1 DER
  const nBuf = Buffer.from(key.n, 'base64url');
  const eBuf = Buffer.from(key.e, 'base64url');
  const pem = jwkRsaToPem(nBuf, eBuf);

  const verifier = createVerify('RSA-SHA256');
  verifier.update(signingInput);
  verifier.end();
  const ok = verifier.verify(pem, signature);
  if (!ok) throw new Error('jwt-signature-invalid');

  const now = Math.floor(Date.now() / 1000);
  const exp = Number(payload['exp']);
  const nbf = Number(payload['nbf'] ?? 0);
  if (exp && now > exp + 30) throw new Error('jwt-expired');
  if (nbf && now + 30 < nbf) throw new Error('jwt-not-yet-valid');
  return payload;
}

// Minimal RSA-JWK → PEM (DER SEQUENCE(modulus, exponent) → PKCS#1)
function jwkRsaToPem(n: Buffer, e: Buffer): string {
  function encodeLen(len: number): Buffer {
    if (len < 0x80) return Buffer.from([len]);
    const bytes: number[] = [];
    let x = len;
    while (x > 0) { bytes.unshift(x & 0xff); x >>= 8; }
    return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)]);
  }
  function encodeInt(buf: Buffer): Buffer {
    // Pad if high bit is set so it's parsed as positive
    const body = buf[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf;
    return Buffer.concat([Buffer.from([0x02]), encodeLen(body.length), body]);
  }
  const modulus = encodeInt(n);
  const exponent = encodeInt(e);
  const seqContent = Buffer.concat([modulus, exponent]);
  const rsaPubKey = Buffer.concat([Buffer.from([0x30]), encodeLen(seqContent.length), seqContent]);

  // Wrap in SubjectPublicKeyInfo (X.509) with rsaEncryption OID
  const algIdent = Buffer.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const bitString = Buffer.concat([Buffer.from([0x03]), encodeLen(rsaPubKey.length + 1), Buffer.from([0x00]), rsaPubKey]);
  const spkiContent = Buffer.concat([algIdent, bitString]);
  const spki = Buffer.concat([Buffer.from([0x30]), encodeLen(spkiContent.length), spkiContent]);
  const b64 = spki.toString('base64');
  return `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

export interface OidcCallbackParams { code: string; state: string; }

export async function handleCallback(params: OidcCallbackParams): Promise<IdentityPrincipal> {
  const s = flowStates.get(params.state);
  if (!s) throw new Error('oidc-state-invalid');
  flowStates.delete(params.state);
  if (Date.now() - s.createdAt > 10 * 60_000) throw new Error('oidc-state-expired');

  const provider = IdentityRegistry.getProvider(s.providerId);
  if (!provider?.oidc) throw new Error('oidc-provider-missing');
  const disc = await fetchDiscovery(provider.oidc.issuer);

  // Token exchange
  const tokenRes = await fetch(disc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: provider.oidc.redirectUri,
      client_id: provider.oidc.clientId,
      client_secret: provider.oidc.clientSecret,
      code_verifier: s.codeVerifier,
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`oidc-token-exchange-failed:${tokenRes.status}`);
  const tokens = await tokenRes.json() as { id_token: string; access_token: string };

  const jwks = await fetchJwks(disc.jwks_uri);
  const idPayload = verifyRs256(tokens.id_token, jwks);
  if (idPayload['iss'] !== provider.oidc.issuer) throw new Error('oidc-issuer-mismatch');
  if (idPayload['aud'] !== provider.oidc.clientId && !(Array.isArray(idPayload['aud']) && (idPayload['aud'] as string[]).includes(provider.oidc.clientId))) {
    throw new Error('oidc-aud-mismatch');
  }
  if (idPayload['nonce'] !== s.nonce) throw new Error('oidc-nonce-mismatch');

  const groupsClaim = provider.oidc.groupsClaim ?? 'groups';
  const groups = Array.isArray(idPayload[groupsClaim]) ? (idPayload[groupsClaim] as string[]) : [];
  const resolved = IdentityRegistry.resolveRole(provider.orgId, groups);

  const displayName = idPayload['name'] as string | undefined;
  const principal: IdentityPrincipal = {
    subjectId: String(idPayload['sub']),
    email: String(idPayload['email'] ?? ''),
    ...(displayName ? { displayName } : {}),
    role: resolved.role,
    clearance: resolved.clearance,
    purposeOfUse: resolved.purposeOfUse,
    orgId: provider.orgId,
    ...(resolved.facilityIds ? { facilityIds: resolved.facilityIds } : {}),
    groups,
    source: 'oidc',
  };
  IdentityRegistry.upsertPrincipal(principal);
  IdentityRegistry.audit('oidc.login', { subjectId: principal.subjectId, providerId: provider.providerId });
  return principal;
}
