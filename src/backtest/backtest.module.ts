import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CandleEntity } from '../market-data/entities/candle.entity';
import { CandleRepository } from '../market-data/candle.repository';
import { BacktestRunEntity } from './entities/backtest-run.entity';
import { BacktestSignalEntity } from './entities/backtest-signal.entity';
import { BacktestRunRepository } from './backtest-run.repository';

/**
 * Módulo MÍNIMO para el CLI de backtest (run.ts). Lee velas (CandleRepository) y, con `--register`,
 * persiste la corrida en backtest_runs/backtest_signals (BacktestRunRepository — escribe en NUESTRA
 * DB, jamás en el exchange). NO carga Exchange, gateway ni ingest (Regla Cero: read-only y offline).
 * Las credenciales de DB se leen del .env (DB_HOST/PORT/USER/PASS/NAME).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('DB_HOST'),
        port: Number(config.get('DB_PORT') ?? 5432),
        username: config.get<string>('DB_USER'),
        password: config.get<string>('DB_PASS'),
        database: config.get<string>('DB_NAME'),
        entities: [CandleEntity, BacktestRunEntity, BacktestSignalEntity],
        synchronize: false,
        logging: ['error'] as const,
      }),
    }),
    TypeOrmModule.forFeature([CandleEntity, BacktestRunEntity, BacktestSignalEntity]),
  ],
  providers: [CandleRepository, BacktestRunRepository],
})
export class BacktestModule {}
