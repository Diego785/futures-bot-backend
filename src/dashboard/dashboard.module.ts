import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BinanceModule } from '../binance/binance.module';
import { StrategyModule } from '../strategy/strategy.module';
import { Signal } from '../trading/entities/signal.entity';
import { Trade } from '../trading/entities/trade.entity';
import { DailyPnl } from '../trading/entities/daily-pnl.entity';
import { DashboardController } from './dashboard.controller';
import { DashboardGateway } from './dashboard.gateway';
import { BotModule } from '../bot/bot.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Signal, Trade, DailyPnl]),
    BinanceModule,
    StrategyModule,
    forwardRef(() => BotModule),
    NotificationsModule,
  ],
  controllers: [DashboardController],
  providers: [DashboardGateway],
  exports: [DashboardGateway],
})
export class DashboardModule {}
