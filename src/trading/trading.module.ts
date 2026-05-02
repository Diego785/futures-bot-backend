import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExchangeModule } from '../exchange/exchange.module';
import { Signal } from './entities/signal.entity';
import { Order } from './entities/order.entity';
import { Trade } from './entities/trade.entity';
import { DailyPnl } from './entities/daily-pnl.entity';
import { RiskManagerService } from './risk-manager.service';
import { ExecutionService } from './execution.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Signal, Order, Trade, DailyPnl]),
    ExchangeModule,
    NotificationsModule,
  ],
  providers: [RiskManagerService, ExecutionService],
  exports: [
    RiskManagerService,
    ExecutionService,
    TypeOrmModule.forFeature([Signal, Order, Trade, DailyPnl]),
  ],
})
export class TradingModule {}
