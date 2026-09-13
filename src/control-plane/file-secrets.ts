/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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

// Encrypted file-backed secrets (F1.4).
//
// The knowledge-layer registry (`src/knowledge/secrets.ts`) is a plaintext JSON
// file with `chmod 0600` and a comment saying production should use a KMS. That
// is defensible for an API key for a public reference dataset. It is NOT
// defensible for the private key that signs a SMART Backend Services
// client_assertion — that key is the entire authority of the integration, and
// holding it in cleartext on disk means a file read is a full impersonation.
//
// Design choices worth stating:
//
//   • **AES-256-GCM**, per-entry random IV, authentication tag verified on read.
//     GCM (not CBC) so a tampered ciphertext is a hard failure, not a silently
//     corrupted secret.
//   • **The key never comes from the file.** It comes from the environment (or a
//     mounted secret), so the file alone is not enough to decrypt anything.
//   • **Fail closed on USE, not on boot.** An unconfigured key produces a clear
//     error the first time a secret is actually needed — naming the environment
//     variable — rather than a process that refuses to start or, worse, one that
//     silently falls back to plaintext.
//   • **Atomic writes.** Temp file + rename, so a crash mid-write cannot leave a
//     truncated store that decrypts to nothing.

import {
  createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecretsProvider } from './secrets.js';

const FILE_VERSION = 1;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const SCRYPT_SALT_BYTES = 16;

export type Kdf = 'raw' | 'scrypt';

interface SecretEntry {
  iv: string;
  tag: string;
  ct: string;
  version: number;
  updatedAt: string;
}

interface SecretsFile {
  v: number;
  kdf: Kdf;
  salt: string;
  entries: Record<string, SecretEntry>;
}

export const SECRETS_KEY_ENV = 'HH_SECRETS_KEY';

export class SecretsStoreError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'SecretsStoreError';
  }
}

/**
 * Turn the configured key material into a 32-byte AES key.
 *
 * Accepts either a base64-encoded 32-byte key (the preferred form — high
 * entropy, no KDF needed) or a passphrase, which is stretched with scrypt. The
 * KDF choice is recorded in the file so a later key rotation knows how to read
 * what it is rotating.
 */
export function deriveKey(material: string, saltB64: string): { key: Buffer; kdf: Kdf } {
  const maybeRaw = Buffer.from(material, 'base64');
  if (maybeRaw.length === KEY_BYTES && /^[A-Za-z0-9+/=]+$/.test(material)) {
    return { key: maybeRaw, kdf: 'raw' };
  }
  const salt = Buffer.from(saltB64, 'base64');
  return { key: scryptSync(material, salt, KEY_BYTES), kdf: 'scrypt' };
}

export interface FileSecretsProviderOptions {
  /** Where the encrypted store lives. */
  readonly filePath: string;
  /** Key material. Defaults to `HH_SECRETS_KEY`. */
  readonly keyMaterial?: string;
  readonly now?: () => string;
}

/**
 * An encrypted, file-backed `SecretsProvider`.
 *
 * Construct it with no key and it will throw only when a secret is requested —
 * see the note on fail-closed above.
 */
export class FileSecretsProvider implements SecretsProvider {
  private readonly filePath: string;
  private readonly keyMaterial: string | undefined;
  private readonly nowFn: () => string;
  private loaded: SecretsFile | undefined;

  constructor(opts: FileSecretsProviderOptions) {
    this.filePath = opts.filePath;
    this.keyMaterial = opts.keyMaterial ?? process.env[SECRETS_KEY_ENV];
    this.nowFn = opts.now ?? (() => new Date().toISOString());
  }

  /** True when a key is configured. For the health panel, never for gating auth. */
  configured(): boolean {
    return typeof this.keyMaterial === 'string' && this.keyMaterial.length > 0;
  }

  private requireKey(): string {
    if (!this.configured()) {
      throw new SecretsStoreError(
        `secret-store-unavailable: set ${SECRETS_KEY_ENV} (a base64 32-byte key or a passphrase) to read or write secrets`,
        'secret-store-unavailable',
      );
    }
    return this.keyMaterial as string;
  }

  private read(): SecretsFile {
    if (this.loaded) return this.loaded;
    if (!existsSync(this.filePath)) {
      this.loaded = {
        v: FILE_VERSION,
        kdf: 'scrypt',
        salt: randomBytes(SCRYPT_SALT_BYTES).toString('base64'),
        entries: {},
      };
      return this.loaded;
    }
    let parsed: SecretsFile;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as SecretsFile;
    } catch (err) {
      throw new SecretsStoreError(
        `secret-store-unreadable: ${this.filePath} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
        'secret-store-unreadable',
      );
    }
    if (!parsed.entries || typeof parsed.entries !== 'object') {
      throw new SecretsStoreError('secret-store-corrupt: missing `entries`', 'secret-store-corrupt');
    }
    this.loaded = parsed;
    return parsed;
  }

  private write(file: SecretsFile): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    // Temp + rename so a crash cannot truncate the live store.
    renameSync(tmp, this.filePath);
    try { chmodSync(this.filePath, 0o600); } catch { /* platform without chmod semantics */ }
  }

  async get(key: string): Promise<string | undefined> {
    const file = this.read();
    const entry = file.entries[key];
    if (!entry) return undefined;
    const { key: aesKey } = deriveKey(this.requireKey(), file.salt);
    try {
      const decipher = createDecipheriv('aes-256-gcm', aesKey, Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(entry.ct, 'base64')), decipher.final()]);
      return plain.toString('utf8');
    } catch {
      // A tag mismatch means the key changed or the file was tampered with.
      // Either way the honest answer is "we cannot give you this".
      throw new SecretsStoreError(
        `secret-undecryptable: ${key} could not be decrypted (wrong ${SECRETS_KEY_ENV}, or the store was modified)`,
        'secret-undecryptable',
      );
    }
  }

  async set(key: string, value: string): Promise<void> {
    const file = this.read();
    const { key: aesKey } = deriveKey(this.requireKey(), file.salt);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    file.entries[key] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
      version: (file.entries[key]?.version ?? 0) + 1,
      updatedAt: this.nowFn(),
    };
    this.write(file);
  }

  async rotate(key: string, newValue: string): Promise<{ previousVersion: number; newVersion: number }> {
    const file = this.read();
    const previousVersion = file.entries[key]?.version ?? 0;
    await this.set(key, newValue);
    return { previousVersion, newVersion: previousVersion + 1 };
  }

  async list(prefix?: string): Promise<readonly string[]> {
    const file = this.read();
    const keys = Object.keys(file.entries);
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }

  /** Metadata only — never a value. Safe for an audit panel. */
  metadata(): readonly { key: string; version: number; updatedAt: string }[] {
    const file = this.read();
    return Object.entries(file.entries).map(([key, e]) => ({
      key,
      version: e.version,
      updatedAt: e.updatedAt,
    }));
  }

  /** Constant-time comparison for callers that must check a secret without using it. */
  async matches(key: string, candidate: string): Promise<boolean> {
    const actual = await this.get(key);
    if (actual === undefined) return false;
    const a = Buffer.from(actual, 'utf8');
    const b = Buffer.from(candidate, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

/**
 * A provider that refuses everything, with the remedy in the message.
 *
 * Used so the FHIR routes can be registered and exercised without a secrets key
 * while still failing closed the moment a credential is genuinely required.
 */
export class UnavailableSecretsProvider implements SecretsProvider {
  constructor(private readonly reason: string) {}

  async get(_key: string): Promise<string | undefined> {
    void _key;
    throw new SecretsStoreError(`secret-store-unavailable: ${this.reason}`, 'secret-store-unavailable');
  }

  async set(_key: string, _value: string): Promise<void> {
    void _key;
    void _value;
    throw new SecretsStoreError(`secret-store-unavailable: ${this.reason}`, 'secret-store-unavailable');
  }

  async rotate(_key: string, _newValue: string): Promise<{ previousVersion: number; newVersion: number }> {
    void _key;
    void _newValue;
    throw new SecretsStoreError(`secret-store-unavailable: ${this.reason}`, 'secret-store-unavailable');
  }

  async list(_prefix?: string): Promise<readonly string[]> {
    void _prefix;
    return [];
  }
}

/**
 * The process-wide FHIR secrets provider.
 *
 * Note the deliberate absence of a plaintext fallback: if no key is configured
 * this is `UnavailableSecretsProvider`, which fails on use with the remedy. A
 * silent fallback to cleartext is exactly the failure this file exists to
 * prevent, and it would be invisible until an audit.
 */
export function fhirSecretsProvider(storeDir: string): SecretsProvider {
  const keyMaterial = process.env[SECRETS_KEY_ENV];
  if (!keyMaterial) {
    return new UnavailableSecretsProvider(
      `no ${SECRETS_KEY_ENV} configured, so FHIR client credentials cannot be stored or read`,
    );
  }
  return new FileSecretsProvider({ filePath: `${storeDir}/fhir-secrets.json`, keyMaterial });
}
