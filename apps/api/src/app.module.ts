import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { EnvModule } from './config/env.module';
import { DbModule } from './db/db.module';
import { LedgerModule } from './ledger/ledger.module';
import { AuthModule } from './auth/auth.module';
import { BudgetModule } from './budget/budget.module';
import { AssetsModule } from './assets/assets.module';
import { InventoryModule } from './inventory/inventory.module';
import { CloseModule } from './close/close.module';
import { ReportsModule } from './reports/reports.module';
import { FilesModule } from './files/files.module';
import { AdminModule } from './admin/admin.module';
import { ArModule } from './ar/ar.module';
import { ApModule } from './ap/ap.module';
import { BankModule } from './bank/bank.module';
import { TaxModule } from './tax/tax.module';
import { AuthGuard } from './auth/auth.guard';
import { CsrfGuard } from './auth/csrf.guard';
import { APP_GUARD } from '@nestjs/core';
import { HealthController } from './health/health.controller';

/** A limit from the environment, relaxed under test. */
function rateLimit(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return process.env['NODE_ENV'] === 'test' ? 1_000_000 : fallback;
}

@Module({
  imports: [
    EnvModule,
    DbModule,
    AuthModule,
    LedgerModule,
    ArModule,
    ApModule,
    BankModule,
    TaxModule,
    ReportsModule,
    CloseModule,
    InventoryModule,
    AssetsModule,
    BudgetModule,
    FilesModule,
    AdminModule,
    /*
     * Rate limiting. The ceiling is per IP and deliberately generous for normal
     * use — a bookkeeper posting a batch must not be throttled — while still
     * capping credential stuffing and scripted abuse. The limits are read from
     * the environment so a deployment behind its own gateway can raise them,
     * and so the integration suite, which hammers a single loopback address,
     * is not measuring the throttler instead of the ledger.
     */
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1_000, limit: rateLimit('RATE_LIMIT_BURST', 30) },
      { name: 'long', ttl: 60_000, limit: rateLimit('RATE_LIMIT_PER_MINUTE', 600) },
    ]),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        genReqId: (req, res) => {
          const existing = req.headers['x-request-id'];
          const id = typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),
  ],
  controllers: [HealthController],
  // Authentication is on by default; endpoints opt out with @Public().
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
