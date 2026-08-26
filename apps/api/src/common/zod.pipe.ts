import { HttpStatus, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { LedgerError } from './problem.filter';

/**
 * Validates a request payload against the shared Zod schema and reports every
 * failure at once, as RFC 9457 `errors[]`, so a bookkeeper fixes one form pass.
 */
@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new LedgerError(
      'VALIDATION_FAILED',
      'The request payload is not valid',
      HttpStatus.BAD_REQUEST,
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
}

export function zodPipe<T extends ZodTypeAny>(schema: T): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
