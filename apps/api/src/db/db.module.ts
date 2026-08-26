import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import postgres from 'postgres';
import { ENV } from '../config/env.module';
import type { Env } from '@acct/shared';

/**
 * A single pooled connection to Postgres.
 *
 * Every ledger write goes through `transaction()`, because the balance
 * constraint is deferred to COMMIT: a write split across two connections would
 * be checked as two half-entries and could not balance.
 */
@Injectable()
export class Database implements OnModuleDestroy {
  readonly sql: postgres.Sql;

  constructor(@Inject(ENV) env: Env) {
    this.sql = postgres(env.DATABASE_URL, {
      max: env.DATABASE_MAX_CONNECTIONS,
      onnotice: () => {},
      transform: { undefined: null },
    });
  }

  /**
   * Run a unit of work in one transaction, with the tenant pinned for the
   * duration. `app.tenant_id` is what the M2 row-level security policies will
   * read, so every query already runs inside the right tenant scope.
   */
  async transaction<T>(
    tenantId: string,
    work: (tx: postgres.TransactionSql) => Promise<T>,
    context: { userId?: string | undefined; requestId?: string | undefined } = {},
  ): Promise<T> {
    return this.sql.begin(async (tx) => {
      // `app.tenant_id` drives the row-level security policies; the other two
      // are read by the audit trigger so every row change names its actor.
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`SELECT set_config('app.user_id', ${context.userId ?? ''}, true)`;
      await tx`SELECT set_config('app.request_id', ${context.requestId ?? ''}, true)`;
      return work(tx);
    }) as Promise<T>;
  }

  /**
   * A read that must still respect row-level security. Reads run in a
   * transaction too, because `app.tenant_id` is set with SET LOCAL.
   */
  async read<T>(tenantId: string, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return this.transaction(tenantId, work);
  }

  async onModuleDestroy(): Promise<void> {
    await this.sql.end();
  }
}

@Global()
@Module({ providers: [Database], exports: [Database] })
export class DbModule {}
