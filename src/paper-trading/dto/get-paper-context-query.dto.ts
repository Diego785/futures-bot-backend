import { Type } from 'class-transformer';
import { IsInt, Matches, Min } from 'class-validator';

/** Rango temporal + símbolo del contexto SMC de la pestaña Paper. */
export class GetPaperContextQueryDto {
  @Matches(/^[A-Z0-9]{5,20}$/, { message: 'symbol debe ser 5-20 caracteres A-Z/0-9 (p.ej. BTCUSDT)' })
  symbol: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  from: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  to: number;
}
