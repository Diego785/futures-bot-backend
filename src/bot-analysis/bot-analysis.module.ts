import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data/market-data.module';
import { BotAnalysisController } from './bot-analysis.controller';

/**
 * Análisis automático del bot (Fase 5A en adelante). Capas de lectura SMC propias del bot
 * (empezando por StrictFVG), siempre read-only y comparativas — el bot NO copia las marcas
 * del usuario, produce su propia lectura. Reutiliza CandleRepository de MarketDataModule.
 */
@Module({
  imports: [MarketDataModule],
  controllers: [BotAnalysisController],
})
export class BotAnalysisModule {}
