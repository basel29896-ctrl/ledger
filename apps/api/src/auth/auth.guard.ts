import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService, type AccessTokenClaims } from './auth.service';
import { LedgerError } from '../common/problem.filter';

export const PUBLIC_KEY = 'auth:public';
export const PERMISSIONS_KEY = 'auth:permissions';

/** Marks an endpoint as reachable without a session (login, refresh, health). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/** Requires every listed permission. */
export const RequirePermissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export interface AuthenticatedRequest extends Request {
  auth?: AccessTokenClaims;
}

/**
 * Reads the access token from the httpOnly cookie (browser) or the
 * Authorization header (server-to-server), then enforces the permissions
 * declared on the handler.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractToken(request);
    if (!token) {
      throw new LedgerError('UNAUTHENTICATED', 'Sign in to continue', HttpStatus.UNAUTHORIZED);
    }

    const claims = this.auth.verifyAccessToken(token);
    request.auth = claims;

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required?.length) {
      const missing = required.filter((p) => !claims.perms.includes(p));
      if (missing.length > 0) {
        throw new LedgerError(
          'FORBIDDEN',
          `Missing permission: ${missing.join(', ')}`,
          HttpStatus.FORBIDDEN,
        );
      }
    }
    return true;
  }
}

function extractToken(request: Request): string | undefined {
  const cookies = (request as Request & { cookies?: Record<string, string> }).cookies;
  const fromCookie = cookies?.['access_token'];
  if (fromCookie) return fromCookie;

  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return undefined;
}

/** The authenticated principal. Tenant comes from the token, never the client. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenClaims => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.auth) {
      throw new LedgerError('UNAUTHENTICATED', 'Sign in to continue', HttpStatus.UNAUTHORIZED);
    }
    return request.auth;
  },
);

/**
 * The tenant of the authenticated user.
 * Replaces the M1 `X-Tenant-Id` header: a client can no longer choose which
 * tenant it reads, and RLS enforces the same boundary in the database.
 */
export const TenantId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.auth) {
    throw new LedgerError('UNAUTHENTICATED', 'Sign in to continue', HttpStatus.UNAUTHORIZED);
  }
  return request.auth.tid;
});
