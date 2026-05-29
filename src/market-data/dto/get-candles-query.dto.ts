import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

// Timeframes oficiales de la estrategia. 1m es solo dev/smoke y NO se expone aquí.
export const CANDLES_API_TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;
export type CandlesApiTimeframe = (typeof CANDLES_API_TIMEFRAMES)[number];

export const MAX_CANDLES_LIMIT = 1500;
export const DEFAULT_CANDLES_LIMIT = 500;

export class GetCandlesQueryDto {
  @Matches(/^[A-Z0-9]{5,20}$/, {
    message: 'symbol debe ser 5-20 caracteres A-Z/0-9 (p.ej. BTCUSDT)',
  })
  symbol: string;

  @IsIn(CANDLES_API_TIMEFRAMES, {
    message: `tf debe ser uno de: ${CANDLES_API_TIMEFRAMES.join(', ')}`,
  })
  tf: CandlesApiTimeframe;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CANDLES_LIMIT)
  limit: number = DEFAULT_CANDLES_LIMIT;

  // Rango temporal (epoch ms UTC) — opcional.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  from?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  to?: number;

  // Cursor de paginación: openTime de la última vela de la página previa (exclusivo).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cursor?: number;
}
