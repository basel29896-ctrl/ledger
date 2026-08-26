import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { FilesService, type AttachmentDto } from './files.service';
import { zodPipe } from '../common/zod.pipe';
import { CurrentUser, RequirePermissions, TenantId } from '../auth/auth.guard';
import type { AccessTokenClaims } from '../auth/auth.service';

/*
 * The body carries base64 rather than multipart: it keeps the size cap and the
 * type check in one place, before a single byte reaches storage.
 */
const uploadSchema = z.object({
  entityType: z.string().min(1).max(50),
  entityId: z.string().uuid(),
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  contentBase64: z.string().min(1),
});

const listQuerySchema = z.object({
  entityType: z.string().min(1).max(50),
  entityId: z.string().uuid(),
});

@ApiTags('attachments')
@Controller('attachments')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get()
  @RequirePermissions('attachment.read')
  @ApiOperation({ summary: 'Attachments on one document' })
  list(
    @TenantId() tenantId: string,
    @Query(zodPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ): Promise<AttachmentDto[]> {
    return this.files.list(tenantId, query.entityType, query.entityId);
  }

  @Post()
  @RequirePermissions('attachment.write')
  @ApiOperation({
    summary: 'Attach a file to a document',
    description:
      'Type allowlist checked against the file signature, size capped, and passed to the ' +
      'virus-scan hook. With no scanner configured the file is marked skipped, never clean.',
  })
  upload(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(uploadSchema)) body: z.infer<typeof uploadSchema>,
  ): Promise<AttachmentDto> {
    return this.files.upload(
      tenantId,
      {
        entityType: body.entityType,
        entityId: body.entityId,
        fileName: body.fileName,
        contentType: body.contentType,
        content: Buffer.from(body.contentBase64, 'base64'),
      },
      user.sub,
    );
  }

  @Get(':id/url')
  @RequirePermissions('attachment.read')
  @ApiOperation({
    summary: 'A short-lived signed download URL',
    description: 'Nothing is served by a permanent link, and an infected file is never served at all.',
  })
  url(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ url: string; expiresIn: number }> {
    return this.files.downloadUrl(tenantId, id);
  }

  @Delete(':id')
  @RequirePermissions('attachment.write')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove an attachment' })
  remove(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.files.remove(tenantId, id, user.sub);
  }
}
