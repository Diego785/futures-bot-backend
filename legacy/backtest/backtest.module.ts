import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { IndicatorsService } from '../strategy/indicators.service';
import { SmcService } from '../strategy/smc.service';
import { PreFilterGateService } from '../strategy/pre-filter-gate.service';
import { PullbackObSignalService } from '../strategy/pullback-ob-signal.service';
import { BacktestService } from './backtest.service';

/**
 * Refactor radical 2026-05-19: backtest usa PullbackObSignalService del live
 * directamente (no más state machine duplicada inline). Garantiza misma signal
 * generation que producción. Solo simulación de fill+exit es backtest-specific.
 */
@Module({
  imports: [
    ConfigModule.forRoot(),
    HttpModule.register({ timeout: 30_000 }),
  ],
  providers: [
    IndicatorsService,
    SmcService,
    PreFilterGateService,
    PullbackObSignalService,
    BacktestService,
  ],
  exports: [BacktestService],
})
export class BacktestModule {}
