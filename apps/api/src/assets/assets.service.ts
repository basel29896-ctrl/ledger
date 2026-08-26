import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AssetError,
  buildDepreciationSchedule,
  depreciationForPeriod,
  disposalResult,
  Money,
  type AssetTerms,
  type DepreciationMethod,
  type ScheduleRow,
} from '@acct/domain';
import type { MoneyDto } from '@acct/shared';
import type postgres from 'postgres';
import { Database } from '../db/db.module';
import { LedgerError } from '../common/problem.filter';
import { insertLines, requirePeriodFor } from '../ledger/ledger.service';

export interface AssetDto {
  id: string;
  assetNo: string;
  name: string;
  category: string | null;
  status: string;
  method: DepreciationMethod;
  cost: MoneyDto;
  residual: MoneyDto;
  accumulated: MoneyDto;
  netBookValue: MoneyDto;
  usefulLifeMonths: number;
  inServiceOn: string;
  disposedOn: string | null;
}

interface AssetRow {
  id: string;
  asset_no: string;
  name: string;
  category: string | null;
  status: string;
  currency_code: string;
  cost_minor: string;
  residual_minor: string;
  accumulated_minor: string;
  method: DepreciationMethod;
  useful_life_months: number;
  annual_rate_percent: string | null;
  total_expected_units: string | null;
  in_service_on: string;
  disposed_on: string | null;
  asset_account_id: string;
  accumulated_account_id: string;
  depreciation_expense_account_id: string;
  disposal_gain_account_id: string | null;
  disposal_loss_account_id: string | null;
}

const ASSET_COLUMNS = `
  id, asset_no, name, category, status, currency_code, cost_minor::text, residual_minor::text,
  accumulated_minor::text, method, useful_life_months, annual_rate_percent::text,
  total_expected_units::text, to_char(in_service_on,'YYYY-MM-DD') AS in_service_on,
  to_char(disposed_on,'YYYY-MM-DD') AS disposed_on, asset_account_id, accumulated_account_id,
  depreciation_expense_account_id, disposal_gain_account_id, disposal_loss_account_id`;

/**
 * The fixed asset register. Depreciation is charged once per asset per month —
 * enforced by a unique index, because charging a month twice understates profit
 * and nothing downstream would notice.
 */
@Injectable()
export class AssetsService {
  constructor(private readonly db: Database) {}

  async list(tenantId: string): Promise<AssetDto[]> {
    const rows = await this.db.read(tenantId, (tx) =>
      tx<AssetRow[]>`SELECT ${tx.unsafe(ASSET_COLUMNS)} FROM fixed_assets ORDER BY asset_no`,
    );
    return rows.map(toAssetDto);
  }

  async create(
    tenantId: string,
    input: {
      assetNo: string;
      name: string;
      nameAr?: string | undefined;
      category?: string | undefined;
      costMinor: string;
      residualMinor?: string | undefined;
      method: DepreciationMethod;
      usefulLifeMonths: number;
      annualRatePercent?: string | undefined;
      totalExpectedUnits?: string | undefined;
      acquiredOn: string;
      inServiceOn: string;
      assetAccountId: string;
      accumulatedAccountId: string;
      depreciationExpenseAccountId: string;
      disposalGainAccountId?: string | undefined;
      disposalLossAccountId?: string | undefined;
    },
    actorId?: string,
  ): Promise<AssetDto> {
    try {
      const [row] = await this.db.transaction(
        tenantId,
        async (tx) => {
          const currency = await this.baseCurrency(tx, tenantId);
          return tx<AssetRow[]>`
            INSERT INTO fixed_assets (
              tenant_id, asset_no, name, name_ar, category, status, currency_code,
              cost_minor, residual_minor, method, useful_life_months, annual_rate_percent,
              total_expected_units, acquired_on, in_service_on, asset_account_id,
              accumulated_account_id, depreciation_expense_account_id,
              disposal_gain_account_id, disposal_loss_account_id, created_by
            ) VALUES (
              ${tenantId}, ${input.assetNo}, ${input.name}, ${input.nameAr ?? null},
              ${input.category ?? null}, 'in_service', ${currency},
              ${input.costMinor}, ${input.residualMinor ?? '0'}, ${input.method}::depreciation_method,
              ${input.usefulLifeMonths}, ${input.annualRatePercent ?? null},
              ${input.totalExpectedUnits ?? null}, ${input.acquiredOn}, ${input.inServiceOn},
              ${input.assetAccountId}, ${input.accumulatedAccountId},
              ${input.depreciationExpenseAccountId}, ${input.disposalGainAccountId ?? null},
              ${input.disposalLossAccountId ?? null}, ${actorId ?? null}
            ) RETURNING ${tx.unsafe(ASSET_COLUMNS)}`;
        },
        { userId: actorId },
      );
      return toAssetDto(row!);
    } catch (error) {
      throw translate(error);
    }
  }

  /** The whole life of one asset, month by month, from its current terms. */
  async schedule(tenantId: string, assetId: string): Promise<{ asset: AssetDto; rows: ScheduleRow[] }> {
    const asset = await this.db.read(tenantId, (tx) => this.requireAsset(tx, assetId));
    try {
      return { asset: toAssetDto(asset), rows: buildDepreciationSchedule(termsOf(asset)) };
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Depreciate every in-service asset for one period end, and post the total in
   * a single journal entry. The run is one transaction: either every asset is
   * charged and the entry posted, or nothing moves.
   */
  async runDepreciation(
    tenantId: string,
    input: { periodEnd: string; units?: Record<string, string> | undefined },
    actorId?: string,
  ): Promise<{
    runId: string;
    entryId: string | null;
    periodEnd: string;
    totalCharge: MoneyDto;
    charges: { assetId: string; assetNo: string; charge: MoneyDto; accumulatedAfter: MoneyDto }[];
  }> {
    try {
      return await this.db.transaction(
        tenantId,
        async (tx) => {
          const currency = await this.baseCurrency(tx, tenantId);

          const assets = await tx<AssetRow[]>`
            SELECT ${tx.unsafe(ASSET_COLUMNS)} FROM fixed_assets
             WHERE status = 'in_service' AND in_service_on <= ${input.periodEnd}
             ORDER BY asset_no
               FOR UPDATE`;

          const charges: {
            assetId: string;
            assetNo: string;
            charge: MoneyDto;
            accumulatedAfter: MoneyDto;
          }[] = [];
          const lines: { accountId: string; side: 'debit' | 'credit'; amountMinor: string }[] = [];
          let total = 0n;

          const [run] = await tx<{ id: string }[]>`
            INSERT INTO depreciation_runs (tenant_id, period_end, created_by)
            VALUES (${tenantId}, ${input.periodEnd}, ${actorId ?? null})
            RETURNING id`;

          for (const asset of assets) {
            const units = input.units?.[asset.id];
            const result = depreciationForPeriod(termsOf(asset), {
              accumulatedMinor: asset.accumulated_minor,
              ...(units !== undefined ? { unitsThisPeriod: units } : {}),
            });
            const charge = BigInt(result.chargeMinor);
            if (charge === 0n) continue;

            const accumulatedAfter = BigInt(asset.accumulated_minor) + charge;
            await tx`
              INSERT INTO depreciation_charges (
                tenant_id, run_id, asset_id, period_end, charge_minor,
                accumulated_after_minor, units_this_period
              ) VALUES (
                ${tenantId}, ${run!.id}, ${asset.id}, ${input.periodEnd}, ${charge.toString()},
                ${accumulatedAfter.toString()}, ${units ?? null}
              )`;
            await tx`
              UPDATE fixed_assets SET accumulated_minor = ${accumulatedAfter.toString()}
               WHERE id = ${asset.id}`;

            lines.push({
              accountId: asset.depreciation_expense_account_id,
              side: 'debit',
              amountMinor: charge.toString(),
            });
            lines.push({
              accountId: asset.accumulated_account_id,
              side: 'credit',
              amountMinor: charge.toString(),
            });

            total += charge;
            charges.push({
              assetId: asset.id,
              assetNo: asset.asset_no,
              charge: Money.fromMinor(charge, currency).toJSON(),
              accumulatedAfter: Money.fromMinor(accumulatedAfter, currency).toJSON(),
            });
          }

          let entryId: string | null = null;
          if (lines.length > 0) {
            entryId = await this.postEntry(tx, tenantId, {
              entryDate: input.periodEnd,
              memo: `Depreciation for the period ending ${input.periodEnd}`,
              currency,
              lines,
              actorId,
            });
          }

          await tx`
            UPDATE depreciation_runs
               SET entry_id = ${entryId}, total_charge_minor = ${total.toString()},
                   asset_count = ${charges.length}
             WHERE id = ${run!.id}`;

          return {
            runId: run!.id,
            entryId,
            periodEnd: input.periodEnd,
            totalCharge: Money.fromMinor(total, currency).toJSON(),
            charges,
          };
        },
        { userId: actorId },
      );
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Dispose of an asset: cost and accumulated depreciation come off in full,
   * the proceeds land where they were received, and the difference is a gain or
   * a loss. Nothing is left on the balance sheet.
   */
  async dispose(
    tenantId: string,
    assetId: string,
    input: { disposedOn: string; proceedsMinor: string; proceedsAccountId: string; memo?: string | undefined },
    actorId?: string,
  ): Promise<{
    disposalId: string;
    entryId: string;
    netBookValue: MoneyDto;
    proceeds: MoneyDto;
    gainOrLoss: MoneyDto;
    isGain: boolean;
  }> {
    try {
      return await this.db.transaction(
        tenantId,
        async (tx) => {
          const currency = await this.baseCurrency(tx, tenantId);
          const asset = await this.requireAsset(tx, assetId, true);
          if (asset.status === 'disposed') {
            throw new LedgerError(
              'ASSET_ALREADY_DISPOSED',
              `Asset ${asset.asset_no} was already disposed of on ${asset.disposed_on}`,
              HttpStatus.CONFLICT,
            );
          }

          const result = disposalResult({
            currency,
            costMinor: asset.cost_minor,
            accumulatedMinor: asset.accumulated_minor,
            proceedsMinor: input.proceedsMinor,
          });

          const gainLoss = BigInt(result.gainOrLoss.minor);
          const resultAccount = gainLoss >= 0n
            ? asset.disposal_gain_account_id
            : asset.disposal_loss_account_id;
          if (gainLoss !== 0n && !resultAccount) {
            throw new LedgerError(
              'NO_DISPOSAL_RESULT_ACCOUNT',
              `Asset ${asset.asset_no} has no ${gainLoss > 0n ? 'gain' : 'loss'} on disposal account`,
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          }

          const lines: { accountId: string; side: 'debit' | 'credit'; amountMinor: string }[] = [];
          if (BigInt(input.proceedsMinor) > 0n) {
            lines.push({
              accountId: input.proceedsAccountId,
              side: 'debit',
              amountMinor: input.proceedsMinor,
            });
          }
          if (BigInt(asset.accumulated_minor) > 0n) {
            lines.push({
              accountId: asset.accumulated_account_id,
              side: 'debit',
              amountMinor: asset.accumulated_minor,
            });
          }
          lines.push({
            accountId: asset.asset_account_id,
            side: 'credit',
            amountMinor: asset.cost_minor,
          });
          if (gainLoss !== 0n) {
            lines.push({
              accountId: resultAccount!,
              side: gainLoss > 0n ? 'credit' : 'debit',
              amountMinor: (gainLoss > 0n ? gainLoss : -gainLoss).toString(),
            });
          }

          const entryId = await this.postEntry(tx, tenantId, {
            entryDate: input.disposedOn,
            memo: input.memo ?? `Disposal of ${asset.asset_no}`,
            currency,
            lines,
            actorId,
          });

          const [disposal] = await tx<{ id: string }[]>`
            INSERT INTO asset_disposals (
              tenant_id, asset_id, disposed_on, proceeds_minor, proceeds_account_id,
              net_book_value_minor, gain_loss_minor, entry_id, memo, created_by
            ) VALUES (
              ${tenantId}, ${assetId}, ${input.disposedOn}, ${input.proceedsMinor},
              ${input.proceedsAccountId}, ${result.netBookValue.minor}, ${result.gainOrLoss.minor},
              ${entryId}, ${input.memo ?? null}, ${actorId ?? null}
            ) RETURNING id`;

          await tx`
            UPDATE fixed_assets SET status = 'disposed', disposed_on = ${input.disposedOn}
             WHERE id = ${assetId}`;

          return {
            disposalId: disposal!.id,
            entryId,
            netBookValue: result.netBookValue,
            proceeds: result.proceeds,
            gainOrLoss: result.gainOrLoss,
            isGain: result.isGain,
          };
        },
        { userId: actorId },
      );
    } catch (error) {
      throw translate(error);
    }
  }

  /** The register at a date: cost, accumulated depreciation and what is left. */
  async register(tenantId: string) {
    return this.db.read(tenantId, async (tx) => {
      const currency = await this.baseCurrency(tx, tenantId);
      const rows = await tx<AssetRow[]>`
        SELECT ${tx.unsafe(ASSET_COLUMNS)} FROM fixed_assets ORDER BY asset_no`;

      let cost = Money.zero(currency);
      let accumulated = Money.zero(currency);
      const assets = rows.map((row) => {
        if (row.status !== 'disposed') {
          cost = cost.add(Money.fromMinor(row.cost_minor, currency));
          accumulated = accumulated.add(Money.fromMinor(row.accumulated_minor, currency));
        }
        return toAssetDto(row);
      });

      return {
        currency,
        assets,
        totalCost: cost.toJSON(),
        totalAccumulated: accumulated.toJSON(),
        totalNetBookValue: cost.subtract(accumulated).toJSON(),
      };
    });
  }

  // --- internals --------------------------------------------------------

  private async baseCurrency(tx: postgres.TransactionSql, tenantId: string): Promise<string> {
    const [row] = await tx<{ base_currency: string }[]>`
      SELECT tenant_base_currency(${tenantId}::uuid) AS base_currency`;
    return row!.base_currency;
  }

  private async requireAsset(
    tx: postgres.TransactionSql,
    assetId: string,
    lock = false,
  ): Promise<AssetRow> {
    const [asset] = lock
      ? await tx<AssetRow[]>`
          SELECT ${tx.unsafe(ASSET_COLUMNS)} FROM fixed_assets WHERE id = ${assetId} FOR UPDATE`
      : await tx<AssetRow[]>`
          SELECT ${tx.unsafe(ASSET_COLUMNS)} FROM fixed_assets WHERE id = ${assetId}`;
    if (!asset) throw new LedgerError('ASSET_NOT_FOUND', `No asset ${assetId}`, HttpStatus.NOT_FOUND);
    return asset;
  }

  private async postEntry(
    tx: postgres.TransactionSql,
    tenantId: string,
    p: {
      entryDate: string;
      memo: string;
      currency: string;
      lines: { accountId: string; side: 'debit' | 'credit'; amountMinor: string }[];
      actorId?: string | undefined;
    },
  ): Promise<string> {
    const period = await requirePeriodFor(tx, p.entryDate);
    const [entry] = await tx<{ id: string }[]>`
      INSERT INTO journal_entries (
        tenant_id, entry_date, period_id, fiscal_year_id, status, source_module,
        memo, base_currency, created_by, posted_by
      ) VALUES (
        ${tenantId}, ${p.entryDate}, ${period.id}, ${period.fiscal_year_id},
        'posted', 'depreciation'::source_module, ${p.memo}, ${p.currency},
        ${p.actorId ?? null}, ${p.actorId ?? null}
      ) RETURNING id`;
    await insertLines(tx, tenantId, entry!.id, p.lines, p.currency, p.actorId);
    return entry!.id;
  }
}

function termsOf(row: AssetRow): AssetTerms {
  return {
    currency: row.currency_code,
    costMinor: row.cost_minor,
    residualMinor: row.residual_minor,
    method: row.method,
    usefulLifeMonths: row.useful_life_months,
    inServiceDate: row.in_service_on,
    ...(row.annual_rate_percent ? { annualRatePercent: row.annual_rate_percent } : {}),
    ...(row.total_expected_units ? { totalExpectedUnits: row.total_expected_units } : {}),
  };
}

function toAssetDto(row: AssetRow): AssetDto {
  const currency = row.currency_code;
  const cost = Money.fromMinor(row.cost_minor, currency);
  const accumulated = Money.fromMinor(row.accumulated_minor, currency);
  return {
    id: row.id,
    assetNo: row.asset_no,
    name: row.name,
    category: row.category,
    status: row.status,
    method: row.method,
    cost: cost.toJSON(),
    residual: Money.fromMinor(row.residual_minor, currency).toJSON(),
    accumulated: accumulated.toJSON(),
    netBookValue: cost.subtract(accumulated).toJSON(),
    usefulLifeMonths: row.useful_life_months,
    inServiceOn: row.in_service_on,
    disposedOn: row.disposed_on,
  };
}

function translate(error: unknown): unknown {
  if (error instanceof AssetError) {
    return new LedgerError(error.code, error.message, HttpStatus.UNPROCESSABLE_ENTITY);
  }
  if (error instanceof LedgerError) return error;
  const message = String((error as { message?: string }).message ?? error);
  if (/depreciation_runs_tenant_id_period_end_key/.test(message)) {
    return new LedgerError(
      'PERIOD_ALREADY_DEPRECIATED',
      'Depreciation has already been run for this period; charging it twice would understate profit',
      HttpStatus.CONFLICT,
    );
  }
  if (/depreciation_charges_tenant_id_asset_id_period_end_key/.test(message)) {
    return new LedgerError(
      'ASSET_ALREADY_DEPRECIATED',
      'One of these assets has already been depreciated for this period',
      HttpStatus.CONFLICT,
    );
  }
  if (/asset_disposals_tenant_id_asset_id_key/.test(message)) {
    return new LedgerError('ASSET_ALREADY_DISPOSED', message, HttpStatus.CONFLICT);
  }
  if (/fixed_assets_tenant_id_asset_no_key/.test(message)) {
    return new LedgerError('ASSET_NO_TAKEN', message, HttpStatus.CONFLICT);
  }
  if (/fixed_assets_reducing_needs_rate/.test(message)) {
    return new LedgerError(
      'RATE_REQUIRED',
      'Reducing balance depreciation needs an annual rate',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  if (/fixed_assets_residual_within_cost/.test(message)) {
    return new LedgerError(
      'RESIDUAL_ABOVE_COST',
      'Residual value cannot exceed cost',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  return error;
}
