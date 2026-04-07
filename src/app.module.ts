import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { validate } from './common/config/env.validation';
import { HealthModule } from './health/health.module';
import { BinanceModule } from './binance/binance.module';
import { StrategyModule } from './strategy/strategy.module';
import { TradingModule } from './trading/trading.module';
import { BotModule } from './bot/bot.module';
import { DashboardModule } from './dashboard/dashboard.module';

@Module({
  imports: [
    // ─── Infrastructure ───
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),

    LoggerModule.forRoot({
      pinoHttp: {
        // Disable automatic HTTP request logging — too verbose, spams logs on dashboard polling
        autoLogging: false,
        // Keep only warnings and errors at HTTP level
        level: 'warn',
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
      },
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('DB_HOST'),
        port: config.get('DB_PORT'),
        username: config.get('DB_USER'),
        password: config.get('DB_PASS'),
        database: config.get('DB_NAME'),
        autoLoadEntities: true,
        synchronize: config.get('NODE_ENV') === 'development',
        // Only log errors from TypeORM — disable SQL query logging that spams logs
        logging: ['error', 'warn'],
      }),
    }),

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('REDIS_HOST'),
          port: config.get('REDIS_PORT'),
        },
      }),
    }),

    ScheduleModule.forRoot(),

    // ─── Feature Modules ───
    HealthModule,
    BinanceModule,
    StrategyModule,
    TradingModule,
    BotModule,
    DashboardModule,
  ],
})
export class AppModule {}
