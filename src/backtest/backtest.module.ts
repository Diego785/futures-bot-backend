import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { IndicatorsService } from '../strategy/indicators.service';
import { SmcService } from '../strategy/smc.service';
import { PreFilterGateService } from '../strategy/pre-filter-gate.service';
import { BacktestService } from './backtest.service';

@Module({
  imports: [
    ConfigModule.forRoot(),
    HttpModule.register({ timeout: 30_000 }),
  ],
  providers: [
    IndicatorsService,
    SmcService,
    PreFilterGateService,
    BacktestService,
  ],
  exports: [BacktestService],
})
export class BacktestModule {}
