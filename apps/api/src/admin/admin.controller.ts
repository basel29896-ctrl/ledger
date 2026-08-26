import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Database } from '../db/db.module';
import { AuthService } from '../auth/auth.service';
import { CurrentUser, RequirePermissions, TenantId } from '../auth/auth.guard';
import type { AccessTokenClaims } from '../auth/auth.service';
import { zodPipe } from '../common/zod.pipe';

const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(200),
  password: z.string().min(12, 'Use at least 12 characters'),
  roleCodes: z.array(z.string()).min(1),
});

const auditQuerySchema = z.object({
  entity: z.string().optional(),
  entityId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly db: Database,
    private readonly auth: AuthService,
  ) {}

  @Get('users')
  @RequirePermissions('admin.user.read')
  @ApiOperation({ summary: 'List users with their roles' })
  async listUsers(@TenantId() tenantId: string): Promise<readonly unknown[]> {
    return this.db.transaction(tenantId, async (tx) =>
      tx`
        SELECT u.id, u.email, u.display_name, u.is_active, u.totp_enabled,
               u.last_login_at::text,
               COALESCE(array_agg(r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
          FROM users u
          LEFT JOIN user_roles ur ON ur.user_id = u.id
          LEFT JOIN roles r ON r.id = ur.role_id
         WHERE u.tenant_id = ${tenantId}
         GROUP BY u.id ORDER BY u.email`,
    );
  }

  @Post('users')
  @RequirePermissions('admin.user.write')
  @ApiOperation({ summary: 'Create a user and grant roles' })
  async createUser(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AccessTokenClaims,
    @Body(zodPipe(createUserSchema)) body: z.infer<typeof createUserSchema>,
  ): Promise<{ id: string }> {
    const passwordHash = await AuthService.hashPassword(body.password);
    return this.db.transaction(tenantId, async (tx) => {
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO users (tenant_id, email, display_name, password_hash)
        VALUES (${tenantId}, ${body.email}, ${body.displayName}, ${passwordHash})
        RETURNING id`;
      for (const code of body.roleCodes) {
        await tx`
          INSERT INTO user_roles (user_id, role_id, tenant_id, granted_by)
          SELECT ${user!.id}, r.id, ${tenantId}, ${actor.sub}
            FROM roles r WHERE r.tenant_id = ${tenantId} AND r.code = ${code}`;
      }
      return { id: user!.id };
    });
  }

  @Get('roles')
  @RequirePermissions('admin.user.read')
  @ApiOperation({ summary: 'List roles and their permissions' })
  async listRoles(@TenantId() tenantId: string): Promise<readonly unknown[]> {
    return this.db.transaction(tenantId, async (tx) =>
      tx`
        SELECT r.id, r.code, r.name, r.description, r.is_system,
               COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code)
                        FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
          FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
         WHERE r.tenant_id = ${tenantId}
         GROUP BY r.id ORDER BY r.code`,
    );
  }

  @Get('audit-log')
  @RequirePermissions('admin.audit.read')
  @ApiOperation({ summary: 'Read the append-only audit trail' })
  async auditLog(
    @TenantId() tenantId: string,
    @Query(zodPipe(auditQuerySchema)) query: z.infer<typeof auditQuerySchema>,
  ): Promise<readonly unknown[]> {
    return this.db.transaction(tenantId, async (tx) =>
      tx`
        SELECT id, actor_id, action, entity, entity_id, before, after, occurred_at::text
          FROM audit_log
         WHERE tenant_id = ${tenantId}
           ${query.entity ? tx`AND entity = ${query.entity}` : tx``}
           ${query.entityId ? tx`AND entity_id = ${query.entityId}` : tx``}
         ORDER BY id DESC LIMIT ${query.limit}`,
    );
  }

  @Get('settings')
  @RequirePermissions('admin.user.read')
  @ApiOperation({ summary: 'Company settings' })
  async settings(@TenantId() tenantId: string): Promise<unknown> {
    const rows = await this.db.transaction(tenantId, async (tx) =>
      tx`SELECT * FROM company_settings WHERE tenant_id = ${tenantId}`,
    );
    return rows[0] ?? null;
  }

  @Get('users/:id/permissions')
  @RequirePermissions('admin.user.read')
  @ApiOperation({ summary: 'Effective permissions of one user' })
  permissions(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<string[]> {
    return this.auth.permissionsFor(tenantId, id);
  }
}
