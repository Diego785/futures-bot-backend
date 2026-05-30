import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { MANUAL_MARK_SIDES } from './create-manual-mark.dto';

/**
 * PATCH /api/manual-marks/:id. Solo geometría/contenido editable (mover/redimensionar,
 * cambiar LONG/SHORT, nota). kind/symbol/tf de una marca NO cambian. El servidor recalcula
 * rr y updatedAt. Campos ausentes = sin cambio.
 */
export class UpdateManualMarkDto {
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
}
