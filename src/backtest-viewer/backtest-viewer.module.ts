import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BacktestRunEntity } from '../backtest/entities/backtest-run.entity';
import { BacktestSignalEntity } from '../backtest/entities/backtest-signal.entity';
import { BacktestRunRepository } from '../backtest/backtest-run.repository';
import { BacktestViewerController } from './backtest-viewer.controller';

/**
 * Visor de backtests (V.1): lectura de corridas registradas para el dashboard. Solo se carga con
 * DB_ENABLED=true (ver app.module). La escritura vive en el CLI (`npm run backtest -- --register`).
 */
@Module({
  imports: [TypeOrmModule.forFeature([BacktestRunEntity, BacktestSignalEntity])],
  controllers: [BacktestViewerController],
  providers: [BacktestRunRepository],
})
export class BacktestViewerModule {}
