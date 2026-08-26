import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ProblemDto } from '@acct/shared';

/** A domain failure that maps to a specific HTTP status and stable code. */
export class LedgerError extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(message, status);
  }
}

/**
 * Every error leaves the API as RFC 9457 problem+json with a stable `code`.
 *
 * PostgreSQL messages are mapped rather than leaked: a trigger raising
 * "out of balance in JOD" becomes ENTRY_UNBALANCED, which the UI can act on.
 */
const PG_MESSAGE_CODES: readonly { pattern: RegExp; code: string; status: HttpStatus }[] = [
  { pattern: /out of balance/i, code: 'ENTRY_UNBALANCED', status: HttpStatus.UNPROCESSABLE_ENTITY },
  { pattern: /at least two lines/i, code: 'ENTRY_TOO_FEW_LINES', status: HttpStatus.UNPROCESSABLE_ENTITY },
  { pattern: /posted and immutable/i, code: 'ENTRY_IMMUTABLE', status: HttpStatus.CONFLICT },
  { pattern: /cannot be deleted; post a reversing entry/i, code: 'ENTRY_IMMUTABLE', status: HttpStatus.CONFLICT },
  { pattern: /cannot be modified or deleted/i, code: 'ENTRY_IMMUTABLE', status: HttpStatus.CONFLICT },
  { pattern: /will not accept postings/i, code: 'PERIOD_CLOSED', status: HttpStatus.CONFLICT },
  { pattern: /is outside period/i, code: 'ENTRY_DATE_OUTSIDE_PERIOD', status: HttpStatus.UNPROCESSABLE_ENTITY },
  { pattern: /summary account and cannot be posted to/i, code: 'ACCOUNT_NOT_POSTABLE', status: HttpStatus.UNPROCESSABLE_ENTITY },
  { pattern: /only accepts/i, code: 'ACCOUNT_CURRENCY_MISMATCH', status: HttpStatus.UNPROCESSABLE_ENTITY },
  { pattern: /is inactive/i, code: 'ACCOUNT_INACTIVE', status: HttpStatus.UNPROCESSABLE_ENTITY },
  { pattern: /greater than zero/i, code: 'LINE_AMOUNT_INVALID', status: HttpStatus.UNPROCESSABLE_ENTITY },
  { pattern: /Base-currency line must have fx_rate 1/i, code: 'LINE_FX_INVALID', status: HttpStatus.UNPROCESSABLE_ENTITY },
  { pattern: /still has \d+ draft entries/i, code: 'PERIOD_HAS_DRAFTS', status: HttpStatus.CONFLICT },
  { pattern: /journal_entries_idempotency_unique/i, code: 'DUPLICATE_EXTERNAL_ID', status: HttpStatus.CONFLICT },
  { pattern: /must have normal balance/i, code: 'ACCOUNT_NORMAL_BALANCE_INVALID', status: HttpStatus.UNPROCESSABLE_ENTITY },
  { pattern: /accounts_tenant_code_key|accounts_tenant_id_code_key/i, code: 'ACCOUNT_CODE_TAKEN', status: HttpStatus.CONFLICT },
  { pattern: /amount_minor/i, code: 'LINE_AMOUNT_INVALID', status: HttpStatus.UNPROCESSABLE_ENTITY },
];

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const problem = this.toProblem(exception, request.url);

    if (problem.status >= 500) {
      this.logger.error({ err: exception, problem }, 'unhandled error');
    } else {
      this.logger.warn({ problem }, 'request rejected');
    }

    response.status(problem.status).type('application/problem+json').send(problem);
  }

  private toProblem(exception: unknown, instance: string): ProblemDto {
    if (exception instanceof LedgerError) {
      return {
        type: 'about:blank',
        title: exception.message,
        status: exception.getStatus(),
        code: exception.code,
        instance,
        ...(exception.errors ? { errors: exception.errors } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const detail = typeof body === 'string' ? body : ((body as { message?: unknown }).message ?? '');
      return {
        type: 'about:blank',
        title: exception.message,
        status: exception.getStatus(),
        code: typeof body === 'object' && body !== null && 'code' in body
          ? String((body as { code: unknown }).code)
          : httpCodeName(exception.getStatus()),
        detail: Array.isArray(detail) ? detail.join('; ') : String(detail),
        instance,
      };
    }

    const message = exception instanceof Error ? exception.message : String(exception);
    const mapped = PG_MESSAGE_CODES.find((m) => m.pattern.test(message));
    if (mapped) {
      return {
        type: 'about:blank',
        title: mapped.code.replaceAll('_', ' ').toLowerCase(),
        status: mapped.status,
        code: mapped.code,
        detail: message,
        instance,
      };
    }

    return {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      instance,
    };
  }
}

function httpCodeName(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'UNPROCESSABLE_ENTITY';
    default:
      return 'ERROR';
  }
}
