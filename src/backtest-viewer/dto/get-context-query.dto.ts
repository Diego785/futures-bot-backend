import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

/** Rango temporal (epoch ms UTC) del contexto SMC a re-derivar para el replay. */
export class GetContextQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  from: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  to: number;
}
