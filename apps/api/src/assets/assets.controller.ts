import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AssetsService, type AssetDto } from './assets.service';
import { zodPipe } from '../common/zod.pipe';
import { CurrentUser, RequirePermissions, TenantId } from '../auth/auth.guard';
import type { AccessTokenClaims } from '../auth/auth.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const minor = z.string().regex(/^\d+$/, 'non-negative integer minor units');

const assetSchema = z.object({
  assetNo: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  costMinor: minor,
  residualMinor: minor.optional(),
  method: z.enum(['straight_line', 'reducing_balance', 'units_of_production']),
  usefulLifeMonths: z.number().int().positive(),
  annualRatePercent: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  totalExpectedUnits: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  acquiredOn: isoDate,
  inServiceOn: isoDate,
  assetAccountId: z.string().uuid(),
  accumulatedAccountId: z.string().uuid(),
  depreciationExpenseAccountId: z.string().uuid(),
  disposalGainAccountId: z.string().uuid().optional(),
  disposalLossAccountId: z.string().uuid().optional(),
});

const runSchema = z.object({
  periodEnd: isoDate,
  /** Units produced this period, per asset, for units-of-production assets. */
  units: z.record(z.string().uuid(), z.string().regex(/^\d+(\.\d+)?$/)).optional(),
});

const disposalSchema = z.object({
  disposedOn: isoDate,
  proceedsMinor: minor,
  proceedsAccountId: z.string().uuid(),
  memo: z.string().max(500).optional(),
});

@ApiTags('assets')
@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @RequirePermissions('asset.read')
  @ApiOperation({ summary: 'List fixed assets' })
  list(@TenantId() tenantId: string): Promise<AssetDto[]> {
    return this.assets.list(tenantId);
  }

  @Post()
  @RequirePermissions('asset.write')
  @ApiOperation({
    summary: 'Add an asset to the register',
    description: 'Reducing balance needs a rate and units of production needs an expected output.',
  })
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(assetSchema)) body: z.infer<typeof assetSchema>,
  ): Promise<AssetDto> {
    return this.assets.create(tenantId, body, user.sub);
  }

  @Get('register')
  @RequirePermissions('asset.read')
  @ApiOperation({ summary: 'The register: cost, accumulated depreciation and net book value' })
  register(@TenantId() tenantId: string) {
    return this.assets.register(tenantId);
  }

  @Get(':id/schedule')
  @RequirePermissions('asset.read')
  @ApiOperation({
    summary: 'Depreciation schedule for one asset',
    description: 'The whole life, month by month. Units of production has no schedule in advance.',
  })
  schedule(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.assets.schedule(tenantId, id);
  }

  @Post('depreciation-runs')
  @RequirePermissions('asset.write')
  @ApiOperation({
    summary: 'Run depreciation for a period',
    description:
      'Charges every in-service asset once and posts the total. Running the same period ' +
      'twice is refused: it would understate profit and nothing downstream would notice.',
  })
  @ApiOkResponse({ description: 'The run, its entry, and the charge per asset' })
  run(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(runSchema)) body: z.infer<typeof runSchema>,
  ) {
    return this.assets.runDepreciation(tenantId, body, user.sub);
  }

  @Post(':id/disposal')
  @RequirePermissions('asset.write')
  @ApiOperation({
    summary: 'Dispose of an asset',
    description:
      'Removes cost and accumulated depreciation in full and books the gain or loss. ' +
      'An asset is disposed of once.',
  })
  dispose(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(disposalSchema)) body: z.infer<typeof disposalSchema>,
  ) {
    return this.assets.dispose(tenantId, id, body, user.sub);
  }
}
