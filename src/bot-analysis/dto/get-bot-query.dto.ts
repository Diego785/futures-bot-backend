import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

const BOT_TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;
const PLAN_MODES = ['confirmation', 'risk', 'both'] as const;

// Query común de las capas de lectura del bot (/api/bot/fvg, /api/bot/ob).
export class GetBotQueryDto {
  @Matches(/^[A-Z0-9]{5,20}$/, { message: 'symbol debe ser 5-20 caracteres A-Z/0-9' })
  symbol: string;

  @IsIn(BOT_TIMEFRAMES, { message: `tf debe ser uno de: ${BOT_TIMEFRAMES.join(', ')}` })
  tf: (typeof BOT_TIMEFRAMES)[number];

  // Ventana de velas (más recientes) sobre la que se analiza. Cubre lo que ve la gráfica.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(5000)
  limit: number = 1000;

  // Solo /api/bot/plans: modo de generación. confirmation (default) | risk | both.
  @IsOptional()
  @IsIn(PLAN_MODES)
  mode?: (typeof PLAN_MODES)[number];
}
