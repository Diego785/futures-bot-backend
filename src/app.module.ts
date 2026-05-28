import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { validate } from './common/config/env.validation';
import { HealthModule } from './health/health.module';
import { ExchangeModule } from './exchange/exchange.module';
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
        autoLogging: false,
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
        // v2: synchronize OFF — entidades v2 (SignalCandidate, JournalEntry…) llegan
        // en fases posteriores con migraciones explícitas. Nunca sincronizar contra
        // las tablas v1 vivas en producción.
        synchronize: false,
        logging: ['error', 'warn'],
      }),
    }),

    ScheduleModule.forRoot(),

    // ─── v2 Feature Modules (skeleton) ───
    HealthModule,
    ExchangeModule,
    DashboardModule,
  ],
})
export class AppModule {}
