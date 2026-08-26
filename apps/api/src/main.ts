import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '@acct/shared';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ProblemFilter } from './common/problem.filter';

async function bootstrap(): Promise<void> {
  // Fail fast before the server binds.
  const env = loadEnv();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  app.use(helmet({ contentSecurityPolicy: env.NODE_ENV === 'production' }));
  // Attachments arrive base64-encoded in JSON, so the body limit has to clear
  // the 20 MB file cap with room for the encoding overhead — and no more.
  app.use(express.json({ limit: '30mb' }));
  app.use(cookieParser());
  // Strict allowlist: credentials are cookies, so a wildcard origin is unusable
  // anyway and a permissive one would hand sessions to any site.
  app.enableCors({
    origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-CSRF-Token'],
    exposedHeaders: ['Idempotent-Replay', 'X-Request-Id'],
  });
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
  // Every error leaves as RFC 9457 problem+json with a stable machine-readable code.
  app.useGlobalFilters(new ProblemFilter());

  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Accounting API')
      .setDescription('Double-entry accounting platform')
      .setVersion('1.0.0')
      .build(),
  );
  SwaggerModule.setup('api/v1/docs', app, doc);
  if (env.NODE_ENV === 'development') {
    writeFileSync(join(process.cwd(), 'openapi.json'), JSON.stringify(doc, null, 2));
  }

  await app.listen(env.API_PORT, '0.0.0.0');
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
