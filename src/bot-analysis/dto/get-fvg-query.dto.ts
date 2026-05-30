import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

const FVG_TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;

export class GetFvgQueryDto {
  @Matches(/^[A-Z0-9]{5,20}$/, { message: 'symbol debe ser 5-20 caracteres A-Z/0-9' })
  symbol: string;

  @IsIn(FVG_TIMEFRAMES, { message: `tf debe ser uno de: ${FVG_TIMEFRAMES.join(', ')}` })
  tf: (typeof FVG_TIMEFRAMES)[number];

  // Ventana de velas (más recientes) sobre la que se detectan FVGs. Cubre lo que ve la gráfica.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(5000)
  limit: number = 1000;
}
