import { IsIn, Matches } from 'class-validator';

// Mismos timeframes que la API de velas (la gráfica solo muestra esos).
export const MANUAL_MARK_TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;
export type ManualMarkTimeframe = (typeof MANUAL_MARK_TIMEFRAMES)[number];

export class GetManualMarksQueryDto {
  @Matches(/^[A-Z0-9]{5,20}$/, {
    message: 'symbol debe ser 5-20 caracteres A-Z/0-9 (p.ej. BTCUSDT)',
  })
  symbol: string;

  @IsIn(MANUAL_MARK_TIMEFRAMES, {
    message: `tf debe ser uno de: ${MANUAL_MARK_TIMEFRAMES.join(', ')}`,
  })
  tf: ManualMarkTimeframe;
}
