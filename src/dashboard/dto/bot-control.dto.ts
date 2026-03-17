import { IsOptional, IsString } from 'class-validator';

export class StartBotDto {
  @IsOptional()
  @IsString()
  symbol?: string;

  @IsOptional()
  @IsString()
  timeframe?: string;
}
