import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import postgres from 'postgres';
import Redis from 'ioredis';
import { ENV } from '../config/env.module';
import { Public } from '../auth/auth.guard';
import type { Env } from '@acct/shared';

@ApiTags('health')
@Public()
@Controller()
export class HealthController {
  private readonly sql: postgres.Sql;
  private readonly redis: Redis;

  constructor(@Inject(ENV) env: Env) {
    this.sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
    this.redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  }

  /** Liveness: the process is up. Never touches dependencies. */
  @Get('health')
  @ApiOkResponse({ description: 'Process is alive' })
  health(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /** Readiness: dependencies required to serve a request are reachable. */
  @Get('ready')
  async ready(): Promise<{ status: 'ready'; checks: Record<string, 'up'> }> {
    const checks: Record<string, 'up'> = {};
    try {
      await this.sql`SELECT 1`;
      checks['postgres'] = 'up';
      if (this.redis.status !== 'ready') await this.redis.connect();
      await this.redis.ping();
      checks['redis'] = 'up';
    } catch (err) {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Dependency unavailable',
        status: 503,
        code: 'DEPENDENCY_UNAVAILABLE',
        detail: err instanceof Error ? err.message : 'unknown',
        checks,
      });
    }
    return { status: 'ready', checks };
  }
}
