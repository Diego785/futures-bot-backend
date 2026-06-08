import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CandleEntity } from '../market-data/entities/candle.entity';
import { CandleRepository } from '../market-data/candle.repository';

/**
 * Módulo MÍNIMO para el CLI de backtest (run.ts). Solo necesita leer velas: Config (.env) + TypeORM
 * + CandleRepository. NO carga Exchange, gateway ni ingest (Regla Cero: el backtest es read-only y
 * offline). Las credenciales de DB se leen del .env (DB_HOST/PORT/USER/PASS/NAME).
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
        entities: [CandleEntity],
        synchronize: false,
        logging: ['error'] as const,
      }),
    }),
    TypeOrmModule.forFeature([CandleEntity]),
  ],
  providers: [CandleRepository],
})
export class BacktestModule {}
