import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { LedgerError } from '../common/problem.filter';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Double-submit CSRF protection for cookie-authenticated mutations.
 *
 * A cross-site form post carries the cookies but cannot read them, so it
 * cannot echo the token back in a header. Requests authenticated with a
 * Bearer token are exempt: those are not driven by ambient credentials.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { cookies?: Record<string, string> }>();
    const res = context.switchToHttp().getResponse<Response>();

    if (SAFE_METHODS.has(req.method)) {
      // Hand the client a token it can echo back on the next mutation.
      if (!req.cookies?.[CSRF_COOKIE]) {
        res.cookie(CSRF_COOKIE, randomBytes(32).toString('base64url'), {
          httpOnly: false,
          sameSite: 'strict',
          path: '/',
        });
      }
      return true;
    }

    if (req.headers.authorization?.startsWith('Bearer ')) return true;
    if (!req.cookies?.['access_token']) return true;

    const cookie = req.cookies[CSRF_COOKIE];
    const header = req.headers[CSRF_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;

    if (!cookie || !provided || !equals(cookie, provided)) {
      throw new LedgerError(
        'CSRF_TOKEN_INVALID',
        'Missing or invalid CSRF token',
        HttpStatus.FORBIDDEN,
      );
    }
    return true;
  }
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
