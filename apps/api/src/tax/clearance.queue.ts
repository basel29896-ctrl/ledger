import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type JobsOptions } from 'bullmq';
import type { Env } from '@acct/shared';
import { ENV } from '../config/env.module';
import { TaxService } from './tax.service';
import { LedgerError } from '../common/problem.filter';

export interface ClearanceJob {
  tenantId: string;
  documentId: string;
  actorId: string;
}

const QUEUE_NAME = 'einvoice-clearance';

/**
 * Retrying e-invoice clearance.
 *
 * The national system being unavailable is a transport problem, not an
 * accounting one: the invoice is already posted and the ledger is unaffected.
 * The queue exists so a transient failure resolves itself without anyone
 * watching, while a rejection stays terminal — a rejected invoice needs
 * correcting, and retrying it forever would only bury that fact.
 *
 * Redis is optional at boot: if it cannot be reached the API still serves, and
 * clearance falls back to the manual submit endpoint.
 */
@Injectable()
export class ClearanceQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClearanceQueue.name);
  private queue: Queue<ClearanceJob> | null = null;
  private worker: Worker<ClearanceJob> | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly tax: TaxService,
  ) {}

  onModuleInit(): void {
    // Tests and offline development run without Redis; the API must not care.
    if (this.env.NODE_ENV === 'test' || !this.env.REDIS_URL) return;

    const connection = { url: this.env.REDIS_URL };
    try {
      this.queue = new Queue<ClearanceJob>(QUEUE_NAME, { connection });
      this.worker = new Worker<ClearanceJob>(
        QUEUE_NAME,
        async (job) => {
          const { tenantId, documentId, actorId } = job.data;
          try {
            return await this.tax.submitForClearance(tenantId, documentId, actorId);
          } catch (error) {
            // A rejection is the provider's final answer: do not retry it.
            if (error instanceof LedgerError && error.code !== 'CLEARANCE_RETRYABLE') {
              this.logger.warn(
                { documentId, code: error.code },
                'clearance rejected; no retry will be attempted',
              );
              return { status: 'rejected', code: error.code };
            }
            throw error;
          }
        },
        { connection, concurrency: 2 },
      );
      this.worker.on('failed', (job, error) => {
        this.logger.warn(
          { documentId: job?.data.documentId, attempts: job?.attemptsMade, err: error.message },
          'clearance attempt failed; it will be retried',
        );
      });
    } catch (error) {
      this.logger.warn({ err: error }, 'clearance queue unavailable; falling back to manual submit');
      this.queue = null;
      this.worker = null;
    }
  }

  /**
   * Queue a submission. Backoff is exponential and capped at five attempts:
   * beyond that a human should look, because the invoice is not yet a valid tax
   * document and quietly retrying for ever hides that.
   */
  async enqueue(job: ClearanceJob): Promise<{ queued: boolean }> {
    if (!this.queue) return { queued: false };
    const options: JobsOptions = {
      // The document id is the job id, so a double submit is one job.
      jobId: `${job.tenantId}:${job.documentId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    };
    await this.queue.add('submit', job, options);
    return { queued: true };
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
