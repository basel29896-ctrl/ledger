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
  ): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return work(tx);
    }) as Promise<T>;
  }

  async onModuleDestroy(): Promise<void> {
    await this.sql.end();
  }
}

@Global()
@Module({ providers: [Database], exports: [Database] })
export class DbModule {}
