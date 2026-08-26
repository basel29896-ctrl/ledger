import { Global, Module } from '@nestjs/common';
import { loadEnv, type Env } from '@acct/shared';

export const ENV = Symbol('ENV');

/**
 * Env is parsed once at module construction. A bad value throws before the
 * HTTP server binds, so a mis-configured deployment never accepts a posting.
 */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv() }],
  exports: [ENV],
})
export class EnvModule {}
