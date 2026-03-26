import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BinanceModule } from '../binance/binance.module';
import { IndicatorsService } from './indicators.service';
import { SmcService } from './smc.service';
import { DeepSeekService } from './deepseek.service';
import { SignalGeneratorService } from './signal-generator.service';
import { PreFilterGateService } from './pre-filter-gate.service';
import { SignalCacheService } from './signal-cache.service';
import { HybridSignalService } from './hybrid-signal.service';
import { PullbackObSignalService } from './pullback-ob-signal.service';

@Module({
  imports: [HttpModule.register({ timeout: 30_000 }), BinanceModule],
  providers: [
    IndicatorsService,
    SmcService,
    DeepSeekService,
    SignalGeneratorService,
    PreFilterGateService,
    SignalCacheService,
    HybridSignalService,
    PullbackObSignalService,
  ],
  exports: [
    SignalGeneratorService,
    IndicatorsService,
    SmcService,
    PreFilterGateService,
  ],
})
export class StrategyModule {}
