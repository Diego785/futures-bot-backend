import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BacktestRunEntity } from '../backtest/entities/backtest-run.entity';
import { BacktestSignalEntity } from '../backtest/entities/backtest-signal.entity';
import { BacktestRunRepository } from '../backtest/backtest-run.repository';
import { MarketDataModule } from '../market-data/market-data.module';
import { BacktestViewerController } from './backtest-viewer.controller';

/**
 * Visor de backtests (V.1/V.3): lectura de corridas registradas + contexto SMC causal para el
 * replay. Solo se carga con DB_ENABLED=true (ver app.module). La escritura vive en el CLI
 * (`npm run backtest -- --register`). MarketDataModule aporta CandleRepository (re-derivación).
 */
@Module({
  imports: [TypeOrmModule.forFeature([BacktestRunEntity, BacktestSignalEntity]), MarketDataModule],
  controllers: [BacktestViewerController],
  providers: [BacktestRunRepository],
})
export class BacktestViewerModule {}
