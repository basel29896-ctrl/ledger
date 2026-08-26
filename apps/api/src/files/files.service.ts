import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '@acct/shared';
import { ENV } from '../config/env.module';
import { Database } from '../db/db.module';
import { LedgerError } from '../common/problem.filter';

/**
 * Attachments.
 *
 * Three rules, all enforced here rather than trusted to the caller:
 *  - the content type must be on the allowlist, matched against the *bytes*
 *    where the format announces itself, not just the header the client sent;
 *  - the size is capped before anything reaches storage;
 *  - nothing is served by a permanent link. Reads go through a short-lived
 *    signed URL, so a copied link stops working.
 *
 * Virus scanning is a hook, not a claim: with no scanner configured a file is
 * marked `skipped`, never `clean`, so nobody can mistake "not scanned" for
 * "scanned and safe".
 */

const ALLOWED_TYPES: Record<string, { extension: string; magic?: readonly number[] }> = {
  'application/pdf': { extension: 'pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  'image/png': { extension: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'image/jpeg': { extension: 'jpg', magic: [0xff, 0xd8, 0xff] },
  'text/csv': { extension: 'csv' },
  'application/xml': { extension: 'xml' },
  'text/xml': { extension: 'xml' },
};

const MAX_BYTES = 20 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 300;

export interface AttachmentDto {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanStatus: string;
  uploadedAt: string;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly s3: S3Client;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: Database,
  ) {
    this.s3 = new S3Client({
      region: env.S3_REGION ?? 'us-east-1',
      endpoint: env.S3_ENDPOINT,
      // MinIO addresses buckets by path, not by subdomain.
      forcePathStyle: true,
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    });
  }

  async upload(
    tenantId: string,
    input: {
      entityType: string;
      entityId: string;
      fileName: string;
      contentType: string;
      content: Buffer;
    },
    actorId?: string,
  ): Promise<AttachmentDto> {
    const allowed = ALLOWED_TYPES[input.contentType];
    if (!allowed) {
      throw new LedgerError(
        'FILE_TYPE_NOT_ALLOWED',
        `${input.contentType} is not an accepted attachment type`,
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      );
    }
    if (input.content.length === 0) {
      throw new LedgerError('FILE_EMPTY', 'The file is empty', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (input.content.length > MAX_BYTES) {
      throw new LedgerError(
        'FILE_TOO_LARGE',
        `The file is ${input.content.length} bytes; the limit is ${MAX_BYTES}`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    // A declared content type is a claim by the caller; where the format has a
    // signature, check the bytes agree with it.
    if (allowed.magic && !startsWith(input.content, allowed.magic)) {
      throw new LedgerError(
        'FILE_CONTENT_MISMATCH',
        `The file does not look like ${input.contentType}`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const checksum = createHash('sha256').update(input.content).digest('hex');
    const objectKey = `${tenantId}/${input.entityType}/${input.entityId}/${randomUUID()}.${allowed.extension}`;

    const scan = await this.scan(input.content);

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: objectKey,
        Body: input.content,
        ContentType: input.contentType,
        ChecksumSHA256: undefined,
        Metadata: { 'sha256': checksum },
      }),
    );

    const [row] = await this.db.transaction(
      tenantId,
      (tx) =>
        tx<
          {
            id: string;
            file_name: string;
            content_type: string;
            size_bytes: string;
            scan_status: string;
            uploaded_at: string;
          }[]
        >`
          INSERT INTO attachments (
            tenant_id, entity_type, entity_id, object_key, file_name, content_type,
            size_bytes, checksum_sha256, scan_status, scan_message, uploaded_by
          ) VALUES (
            ${tenantId}, ${input.entityType}, ${input.entityId}, ${objectKey},
            ${input.fileName}, ${input.contentType}, ${input.content.length}, ${checksum},
            ${scan.status}::scan_status, ${scan.message}, ${actorId ?? null}
          )
          RETURNING id, file_name, content_type, size_bytes::text, scan_status::text AS scan_status,
                    uploaded_at::text AS uploaded_at`,
      { userId: actorId },
    );

    return {
      id: row!.id,
      fileName: row!.file_name,
      contentType: row!.content_type,
      sizeBytes: Number(row!.size_bytes),
      scanStatus: row!.scan_status,
      uploadedAt: row!.uploaded_at,
    };
  }

  async list(tenantId: string, entityType: string, entityId: string): Promise<AttachmentDto[]> {
    const rows = await this.db.read(tenantId, (tx) =>
      tx<
        {
          id: string;
          file_name: string;
          content_type: string;
          size_bytes: string;
          scan_status: string;
          uploaded_at: string;
        }[]
      >`
        SELECT id, file_name, content_type, size_bytes::text, scan_status::text AS scan_status,
               uploaded_at::text AS uploaded_at
          FROM attachments
         WHERE entity_type = ${entityType} AND entity_id = ${entityId}
         ORDER BY uploaded_at DESC`,
    );
    return rows.map((r) => ({
      id: r.id,
      fileName: r.file_name,
      contentType: r.content_type,
      sizeBytes: Number(r.size_bytes),
      scanStatus: r.scan_status,
      uploadedAt: r.uploaded_at,
    }));
  }

  /** A short-lived signed URL. An infected file is never handed out. */
  async downloadUrl(tenantId: string, attachmentId: string): Promise<{ url: string; expiresIn: number }> {
    const [row] = await this.db.read(tenantId, (tx) =>
      tx<{ object_key: string; scan_status: string; file_name: string }[]>`
        SELECT object_key, scan_status::text AS scan_status, file_name
          FROM attachments WHERE id = ${attachmentId}`,
    );
    if (!row) {
      throw new LedgerError('ATTACHMENT_NOT_FOUND', `No attachment ${attachmentId}`, HttpStatus.NOT_FOUND);
    }
    if (row.scan_status === 'infected') {
      throw new LedgerError(
        'ATTACHMENT_INFECTED',
        'This file was flagged by the virus scanner and will not be served',
        HttpStatus.FORBIDDEN,
      );
    }

    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: row.object_key,
        ResponseContentDisposition: `attachment; filename="${row.file_name.replace(/"/g, '')}"`,
      }),
      { expiresIn: SIGNED_URL_TTL_SECONDS },
    );
    return { url, expiresIn: SIGNED_URL_TTL_SECONDS };
  }

  async remove(tenantId: string, attachmentId: string, actorId?: string): Promise<void> {
    const [row] = await this.db.transaction(
      tenantId,
      (tx) =>
        tx<{ object_key: string }[]>`
          DELETE FROM attachments WHERE id = ${attachmentId} RETURNING object_key`,
      { userId: actorId },
    );
    if (!row) {
      throw new LedgerError('ATTACHMENT_NOT_FOUND', `No attachment ${attachmentId}`, HttpStatus.NOT_FOUND);
    }
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.env.S3_BUCKET, Key: row.object_key }));
    } catch (error) {
      // The record is gone either way; a stranded object is a cleanup job, not
      // a failed request, and saying otherwise would invite a retry that
      // deletes nothing.
      this.logger.warn({ err: error, key: row.object_key }, 'attachment object not removed from storage');
    }
  }

  /**
   * The virus-scan hook. With no scanner configured the file is marked
   * `skipped` — never `clean` — so an unscanned file is visibly unscanned.
   */
  private async scan(content: Buffer): Promise<{ status: 'clean' | 'infected' | 'skipped'; message: string | null }> {
    const endpoint = this.env.VIRUS_SCAN_URL;
    if (!endpoint) return { status: 'skipped', message: 'No virus scanner configured' };
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(content),
      });
      const body = (await response.json()) as { infected?: boolean; message?: string };
      return body.infected
        ? { status: 'infected', message: body.message ?? 'Flagged by the scanner' }
        : { status: 'clean', message: null };
    } catch (error) {
      /*
       * A scanner that cannot be reached must not become a silent pass. The
       * upload is refused: an unscannable file is not worth the risk of it
       * being served later as though it had been checked.
       */
      throw new LedgerError(
        'VIRUS_SCAN_UNAVAILABLE',
        `The virus scanner could not be reached: ${String((error as Error).message)}`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}

function startsWith(buffer: Buffer, prefix: readonly number[]): boolean {
  if (buffer.length < prefix.length) return false;
  return prefix.every((byte, index) => buffer[index] === byte);
}
