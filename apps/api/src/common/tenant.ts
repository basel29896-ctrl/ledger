import { createParamDecorator, type ExecutionContext, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { LedgerError } from './problem.filter';

/**
 * M1 resolves the tenant from an explicit `X-Tenant-Id` header.
 *
 * This is a deliberate placeholder: M2 replaces it with the tenant claim on the
 * verified JWT, and the header is dropped. Nothing else in the ledger depends
 * on how the tenant is resolved, only that every query is scoped by it.
 */
export const TenantId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request>();
  const header = request.headers['x-tenant-id'];
  const tenantId = Array.isArray(header) ? header[0] : header;

  if (!tenantId) {
    throw new LedgerError(
      'TENANT_REQUIRED',
      'X-Tenant-Id header is required until authentication lands in M2',
      HttpStatus.BAD_REQUEST,
    );
  }
  return tenantId;
});

/** The idempotency key, if the caller supplied one. */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const header = request.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    return key && key.length > 0 ? key : undefined;
  },
);
