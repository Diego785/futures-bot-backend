import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumberString,
  IsBooleanString,
} from 'class-validator';

export class OrderParamsDto {
  @IsString()
  symbol: string;

  @IsEnum(['BUY', 'SELL'])
  side: 'BUY' | 'SELL';

  @IsEnum(['MARKET', 'LIMIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET'])
  type: string;

  @IsOptional()
  @IsEnum(['BOTH', 'LONG', 'SHORT'])
  positionSide?: 'BOTH' | 'LONG' | 'SHORT';

  @IsOptional()
  @IsNumberString()
  quantity?: string;

  @IsOptional()
  @IsNumberString()
  price?: string;

  @IsOptional()
  @IsNumberString()
  stopPrice?: string;

  @IsOptional()
  @IsString()
  newClientOrderId?: string;

  @IsOptional()
  @IsString()
  timeInForce?: string;

  @IsOptional()
  @IsBooleanString()
  reduceOnly?: string;
}
