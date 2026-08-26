import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { EnvModule } from './config/env.module';
import { DbModule } from './db/db.module';
import { LedgerModule } from './ledger/ledger.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { ArModule } from './ar/ar.module';
import { ApModule } from './ap/ap.module';
import { BankModule } from './bank/bank.module';
import { AuthGuard } from './auth/auth.guard';
import { CsrfGuard } from './auth/csrf.guard';
import { APP_GUARD } from '@nestjs/core';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    EnvModule,
    DbModule,
    AuthModule,
    LedgerModule,
    ArModule,
    ApModule,
    BankModule,
    AdminModule,
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
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
