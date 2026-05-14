import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ExchangeModule } from '../exchange/exchange.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { IndicatorsService } from './indicators.service';
import { SmcService } from './smc.service';
import { DeepSeekService } from './deepseek.service';
import { SignalGeneratorService } from './signal-generator.service';
import { PreFilterGateService } from './pre-filter-gate.service';
import { SignalCacheService } from './signal-cache.service';
import { HybridSignalService } from './hybrid-signal.service';
import { PullbackObSignalService } from './pullback-ob-signal.service';

@Module({
  imports: [HttpModule.register({ timeout: 30_000 }), ExchangeModule, TelemetryModule],
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
