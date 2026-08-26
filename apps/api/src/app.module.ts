import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { EnvModule } from './config/env.module';
import { DbModule } from './db/db.module';
import { LedgerModule } from './ledger/ledger.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    EnvModule,
    DbModule,
    LedgerModule,
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
})
export class AppModule {}
