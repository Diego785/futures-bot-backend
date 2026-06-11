import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { validate } from './common/config/env.validation';
import { HealthModule } from './health/health.module';
import { ExchangeModule } from './exchange/exchange.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MarketDataModule } from './market-data/market-data.module';
import { ManualMarksModule } from './manual-marks/manual-marks.module';
import { BotAnalysisModule } from './bot-analysis/bot-analysis.module';
import { BacktestViewerModule } from './backtest-viewer/backtest-viewer.module';

// TypeORM se activa SOLO si DB_ENABLED=true. En el skeleton v2 todavía no hay
// entidades; conectar a Postgres no aporta nada y bloquearía el arranque local
// sin DB. Cuando llegue MarketDataModule con persistencia, los entornos reales
// pondrán DB_ENABLED=true.
const DB_ENABLED = process.env.DB_ENABLED?.trim() === 'true';

@Module({
  imports: [
    // ─── Infrastructure ───
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),

    LoggerModule.forRoot({
      pinoHttp: {
        autoLogging: false,
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
      },
    }),

    ...(DB_ENABLED
      ? [
          TypeOrmModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService): TypeOrmModuleOptions => ({
              type: 'postgres',
              host: config.get('DB_HOST'),
              port: config.get('DB_PORT'),
              username: config.get('DB_USER'),
              password: config.get('DB_PASS'),
              database: config.get('DB_NAME'),
              autoLoadEntities: true,
              // v2: synchronize OFF siempre. Migraciones explícitas cuando lleguen entities.
              synchronize: false,
              logging: ['error', 'warn'],
            }),
          }),
          // Estos módulos dependen de TypeORM — solo cuando DB_ENABLED.
          MarketDataModule,
          ManualMarksModule,
          BotAnalysisModule,
          BacktestViewerModule,
        ]
      : []),

    ScheduleModule.forRoot(),

    // ─── v2 Feature Modules (skeleton) ───
    HealthModule,
    ExchangeModule,
    DashboardModule,
  ],
})
export class AppModule {}
