import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { MANUAL_MARK_TIMEFRAMES, type ManualMarkTimeframe } from './get-manual-marks-query.dto';

export const MANUAL_MARK_KINDS = ['OB', 'FVG', 'Liquidity', 'TradePlan'] as const;
export type ManualMarkKindDto = (typeof MANUAL_MARK_KINDS)[number];
export const MANUAL_MARK_SIDES = ['LONG', 'SHORT'] as const;
export const MANUAL_MARK_STATUSES = ['DRAFT', 'REVIEWED', 'VALID', 'INVALID', 'DOUBTFUL'] as const;

/**
 * POST /api/manual-marks. forbidNonWhitelisted está activo: el cliente envía SOLO estos
 * campos. sourceLayer/rr/createdAt/updatedAt los fija el servidor. El id lo genera el
 * cliente (uuid) para que crear→arrastrar use el mismo id sin reconciliar; si falta, el
 * servidor genera uno.
 */
export class CreateManualMarkDto {
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: 'id inválido' })
  id?: string;

  @IsIn(MANUAL_MARK_KINDS)
  kind: ManualMarkKindDto;

  @Matches(/^[A-Z0-9]{5,20}$/)
  symbol: string;

  @IsIn(MANUAL_MARK_TIMEFRAMES)
  tf: ManualMarkTimeframe;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  timeStart?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  timeEnd?: number;

  @IsOptional() @Type(() => Number) @IsNumber()
  priceLow?: number;

  @IsOptional() @Type(() => Number) @IsNumber()
  priceHigh?: number;

  @IsOptional() @Type(() => Number) @IsNumber()
  price?: number;

  @IsOptional() @IsIn(MANUAL_MARK_SIDES)
  side?: 'LONG' | 'SHORT';

  @IsOptional() @Type(() => Number) @IsNumber()
  entry?: number;

  @IsOptional() @Type(() => Number) @IsNumber()
  stopLoss?: number;

  @IsOptional() @Type(() => Number) @IsNumber()
  takeProfit?: number;

  @IsOptional() @IsString() @MaxLength(2000)
  note?: string;

  // ─── Revisión / estudio (Slice 3C) ───
  @IsOptional() @IsIn(MANUAL_MARK_STATUSES)
  status?: (typeof MANUAL_MARK_STATUSES)[number];

  @IsOptional() @IsString() @MaxLength(2000)
  context?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  reason?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  doubt?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  outcome?: string;
}
