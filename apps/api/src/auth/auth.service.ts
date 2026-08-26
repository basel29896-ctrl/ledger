import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual, createHmac } from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import type { Env } from '@acct/shared';
import { ENV } from '../config/env.module';
import { Database } from '../db/db.module';
import { LedgerError } from '../common/problem.filter';

export interface AccessTokenClaims {
  sub: string;
  tid: string;
  email: string;
  perms: string[];
  sid: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; email: string; displayName: string; tenantId: string; permissions: string[] };
}

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB — OWASP minimum for argon2id
  timeCost: 2,
  parallelism: 1,
} as const;

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AuthService {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  static hashPassword(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  /**
   * Password login.
   *
   * Failures are deliberately indistinguishable: an unknown email, a wrong
   * password and a user with no password set all return the same error, so the
   * endpoint cannot be used to enumerate accounts.
   */
  async login(params: {
    email: string;
    password: string;
    totpCode?: string | undefined;
    tenantSlug?: string | undefined;
    ip?: string | undefined;
    userAgent?: string | undefined;
  }): Promise<LoginResult> {
    // Login runs before any tenant is known, so it cannot use a tenant-scoped
    // query: it goes through the narrow SECURITY DEFINER lookup instead.
    const [user] = await this.db.sql<
      {
        id: string;
        tenant_id: string;
        email: string;
        display_name: string;
        password_hash: string | null;
        totp_secret: string | null;
        totp_enabled: boolean;
        is_active: boolean;
        failed_logins: number;
        locked_until: string | null;
      }[]
    >`SELECT * FROM auth_find_user(${params.email}, ${params.tenantSlug ?? null})`;

    const invalid = (): never => {
      throw new LedgerError('INVALID_CREDENTIALS', 'Email or password is incorrect', HttpStatus.UNAUTHORIZED);
    };

    if (!user || !user.password_hash || !user.is_active) {
      // Spend comparable time so absence of a user is not observable by timing.
      await argon2.hash(params.password, ARGON2_OPTIONS).catch(() => undefined);
      return invalid();
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new LedgerError(
        'ACCOUNT_LOCKED',
        `Too many failed attempts. Try again after ${user.locked_until}`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const ok = await argon2.verify(user.password_hash, params.password).catch(() => false);
    if (!ok) {
      await this.recordFailedLogin(user.id, user.failed_logins + 1);
      return invalid();
    }

    if (user.totp_enabled) {
      if (!params.totpCode) {
        throw new LedgerError('TOTP_REQUIRED', 'A one-time code is required', HttpStatus.UNAUTHORIZED);
      }
      if (!user.totp_secret || !verifyTotp(user.totp_secret, params.totpCode)) {
        await this.recordFailedLogin(user.id, user.failed_logins + 1);
        throw new LedgerError('TOTP_INVALID', 'The one-time code is not valid', HttpStatus.UNAUTHORIZED);
      }
    }

    await this.db.sql`SELECT auth_record_login_success(${user.id}::uuid)`;

    const permissions = await this.permissionsFor(user.tenant_id, user.id);
    return this.issueSession({
      userId: user.id,
      tenantId: user.tenant_id,
      email: user.email,
      displayName: user.display_name,
      permissions,
      familyId: randomUUID(),
      ip: params.ip,
      userAgent: params.userAgent,
    });
  }

  /** The companies this user may sign in to, home first. */
  async tenantsFor(userId: string): Promise<
    { tenantId: string; slug: string; name: string; baseCurrency: string; isHome: boolean }[]
  > {
    const rows = await this.db.sql<
      { tenant_id: string; slug: string; name: string; base_currency: string; is_home: boolean }[]
    >`SELECT * FROM auth_tenants_for_user(${userId}::uuid)`;
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      slug: r.slug,
      name: r.name,
      baseCurrency: r.base_currency,
      isHome: r.is_home,
    }));
  }

  /**
   * Switch the session to another company.
   *
   * Membership is checked in the database before a token is minted, so a tenant
   * id taken from a request body can never become a session in a company the
   * user was not granted a role in. The old session is revoked: one session,
   * one company, so an access token always names the company it may act in.
   */
  async switchTenant(
    claims: AccessTokenClaims,
    tenantId: string,
    context: { ip?: string | undefined; userAgent?: string | undefined },
  ): Promise<LoginResult> {
    const [allowed] = await this.db.sql<{ auth_user_belongs_to_tenant: boolean }[]>`
      SELECT auth_user_belongs_to_tenant(${claims.sub}::uuid, ${tenantId}::uuid)`;
    if (!allowed?.auth_user_belongs_to_tenant) {
      throw new LedgerError(
        'NOT_A_MEMBER',
        'You do not hold a role in that company',
        HttpStatus.FORBIDDEN,
      );
    }

    const [user] = await this.db.sql<{ email: string; display_name: string }[]>`
      SELECT email, display_name FROM auth_user_by_id(${claims.sub}::uuid)`;
    if (!user) {
      throw new LedgerError('USER_NOT_FOUND', 'No such user', HttpStatus.UNAUTHORIZED);
    }

    await this.logoutSession(claims.sid);
    const permissions = await this.permissionsFor(tenantId, claims.sub);
    return this.issueSession({
      userId: claims.sub,
      tenantId,
      email: user.email,
      displayName: user.display_name,
      permissions,
      familyId: randomUUID(),
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  /**
   * Refresh-token rotation.
   *
   * Each refresh token may be used exactly once. Presenting one that has
   * already been rotated means the token leaked, so the entire family is
   * revoked rather than just that one token.
   */
  async refresh(
    refreshToken: string,
    context: { ip?: string | undefined; userAgent?: string | undefined },
  ): Promise<LoginResult> {
    const hash = hashToken(refreshToken);
    const [session] = await this.db.sql<
      {
        id: string;
        tenant_id: string;
        user_id: string;
        family_id: string;
        expires_at: string;
        rotated_at: string | null;
        revoked_at: string | null;
        user_email: string;
        user_name: string;
        user_active: boolean;
      }[]
    >`SELECT * FROM auth_find_session(${hash})`;

    if (!session) {
      throw new LedgerError('REFRESH_INVALID', 'The refresh token is not recognised', HttpStatus.UNAUTHORIZED);
    }

    if (session.rotated_at || session.revoked_at) {
      await this.db.sql`SELECT auth_revoke_family(${session.family_id}::uuid, 'token reuse detected')`;
      throw new LedgerError(
        'REFRESH_REUSED',
        'This refresh token was already used; all sessions in the family have been revoked',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (new Date(session.expires_at) <= new Date()) {
      throw new LedgerError('REFRESH_EXPIRED', 'The refresh token has expired', HttpStatus.UNAUTHORIZED);
    }

    if (!session.user_active) {
      throw new LedgerError('USER_INACTIVE', 'This account is no longer active', HttpStatus.UNAUTHORIZED);
    }

    await this.db.sql`SELECT auth_mark_session_rotated(${session.id}::uuid)`;

    const permissions = await this.permissionsFor(session.tenant_id, session.user_id);
    return this.issueSession({
      userId: session.user_id,
      tenantId: session.tenant_id,
      email: session.user_email,
      displayName: session.user_name,
      permissions,
      familyId: session.family_id,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  private async logoutSession(sessionId: string): Promise<void> {
    await this.db.sql`SELECT auth_revoke_session_by_id(${sessionId}::uuid, 'tenant_switch')`;
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    await this.db.sql`SELECT auth_revoke_session_by_hash(${hashToken(refreshToken)}, 'logout')`;
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    try {
      return jwt.verify(token, this.env.JWT_ACCESS_SECRET, {
        algorithms: ['HS256'],
      }) as AccessTokenClaims;
    } catch {
      throw new LedgerError('TOKEN_INVALID', 'The access token is missing or invalid', HttpStatus.UNAUTHORIZED);
    }
  }

  /** Start TOTP enrolment. The secret is only armed once a code is confirmed. */
  async beginTotpEnrolment(
    tenantId: string,
    userId: string,
    email: string,
  ): Promise<{ secret: string; otpauthUrl: string }> {
    const secret = base32Encode(randomBytes(20));
    await this.db.transaction(tenantId, async (tx) => {
      await tx`SELECT auth_set_totp_secret(${userId}::uuid, ${secret})`;
    });
    const label = encodeURIComponent(`${this.env.TOTP_ISSUER}:${email}`);
    return {
      secret,
      otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(this.env.TOTP_ISSUER)}&algorithm=SHA1&digits=6&period=30`,
    };
  }

  async confirmTotpEnrolment(tenantId: string, userId: string, code: string): Promise<void> {
    const [row] = await this.db.sql<{ auth_totp_secret: string | null }[]>`
      SELECT auth_totp_secret(${userId}::uuid)`;
    const secret = row?.auth_totp_secret;
    if (!secret || !verifyTotp(secret, code)) {
      throw new LedgerError('TOTP_INVALID', 'The one-time code is not valid', HttpStatus.BAD_REQUEST);
    }
    await this.db.transaction(tenantId, async (tx) => {
      await tx`SELECT auth_enable_totp(${userId}::uuid)`;
    });
  }

  async permissionsFor(tenantId: string, userId: string): Promise<string[]> {
    const rows = await this.db.sql<{ permission_code: string }[]>`
      SELECT permission_code FROM auth_permissions_for(${tenantId}::uuid, ${userId}::uuid)`;
    return rows.map((r) => r.permission_code);
  }

  private async recordFailedLogin(userId: string, attempts: number): Promise<void> {
    const lockMinutes = attempts >= MAX_FAILED_LOGINS ? LOCKOUT_MINUTES : 0;
    await this.db.sql`SELECT auth_record_login_failure(${userId}::uuid, ${attempts}, ${lockMinutes})`;
  }

  private async issueSession(params: {
    userId: string;
    tenantId: string;
    email: string;
    displayName: string;
    permissions: string[];
    familyId: string;
    ip?: string | undefined;
    userAgent?: string | undefined;
  }): Promise<LoginResult> {
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.env.JWT_REFRESH_TTL_SECONDS * 1000);

    const [created] = await this.db.sql<{ auth_create_session: string }[]>`
      SELECT auth_create_session(
        ${params.tenantId}::uuid, ${params.userId}::uuid, ${hashToken(refreshToken)},
        ${params.familyId}::uuid, ${expiresAt.toISOString()}::timestamptz,
        ${params.ip ?? null}, ${params.userAgent ?? null})`;
    const sessionId = created!.auth_create_session;

    const claims: AccessTokenClaims = {
      sub: params.userId,
      tid: params.tenantId,
      email: params.email,
      perms: params.permissions,
      sid: sessionId,
    };
    const accessToken = jwt.sign(claims, this.env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: this.env.JWT_ACCESS_TTL_SECONDS,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.env.JWT_ACCESS_TTL_SECONDS,
      user: {
        id: params.userId,
        email: params.email,
        displayName: params.displayName,
        tenantId: params.tenantId,
        permissions: params.permissions,
      },
    };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// --- TOTP (RFC 6238) ---------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of input.toUpperCase().replace(/=+$/, '')) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * Accepts the current 30-second step and one step either side, which covers
 * ordinary clock drift without widening the window enough to matter.
 */
export function verifyTotp(secret: string, code: string, atSeconds = Math.floor(Date.now() / 1000)): boolean {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) return false;
  const step = Math.floor(atSeconds / 30);
  for (const counter of [step - 1, step, step + 1]) {
    const expected = Buffer.from(generateTotp(secret, counter));
    const actual = Buffer.from(trimmed);
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return true;
  }
  return false;
}
