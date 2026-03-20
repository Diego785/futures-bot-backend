import {
  Module,
  forwardRef,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { InjectQueue, BullModule } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Subscription } from 'rxjs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QUEUE_NAMES } from '../common/constants/binance.constants';
import { BinanceModule } from '../binance/binance.module';
import { BinanceMarketWsService } from '../binance/binance-market-ws.service';
import { BinanceUserWsService } from '../binance/binance-user-ws.service';
import { StrategyModule } from '../strategy/strategy.module';
import { TradingModule } from '../trading/trading.module';
import { Signal } from '../trading/entities/signal.entity';
import { BotStateService } from './bot-state.service';
import { StrategyCycleProcessor } from './strategy-cycle.processor';
import { MaintenanceCronService } from './maintenance-cron.service';
import { KillSwitchService } from './kill-switch.service';
import { ExecutionService } from '../trading/execution.service';
import { DashboardGateway } from '../dashboard/dashboard.gateway';
import { DashboardModule } from '../dashboard/dashboard.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.STRATEGY_CYCLE }),
    TypeOrmModule.forFeature([Signal]),
    BinanceModule,
    StrategyModule,
    TradingModule,
    forwardRef(() => DashboardModule),
    NotificationsModule,
  ],
  providers: [
    BotStateService,
    StrategyCycleProcessor,
    MaintenanceCronService,
    KillSwitchService,
  ],
  exports: [BotStateService, KillSwitchService],
})
export class BotModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotModule.name);
  private candleSub: Subscription | null = null;
  private priceSub: Subscription | null = null;
  private stateSub: Subscription | null = null;
  private orderUpdateSub: Subscription | null = null;
  private algoUpdateSub: Subscription | null = null;

  constructor(
    private readonly botState: BotStateService,
    private readonly binanceMarketWs: BinanceMarketWsService,
    private readonly binanceUserWs: BinanceUserWsService,
    private readonly execution: ExecutionService,
    private readonly dashboardGateway: DashboardGateway,
    @InjectQueue(QUEUE_NAMES.STRATEGY_CYCLE)
    private readonly strategyCycleQueue: Queue,
  ) {}

  onModuleInit(): void {
    // Subscribe to candle close events -> enqueue BullMQ jobs
    this.candleSub = this.binanceMarketWs.onCandleClose$.subscribe(
      ({ symbol, candle }) => {
        if (!this.botState.enabled || symbol !== this.botState.symbol) {
          return;
        }

        this.strategyCycleQueue
          .add(
            'process-candle',
            {
              symbol,
              interval: this.botState.timeframe,
              candleCloseTime: candle.closeTime,
            },
            {
              jobId: `candle-${symbol}-${candle.closeTime}`,
              removeOnComplete: 100,
              removeOnFail: 50,
              attempts: 1,
            },
          )
          .catch((err) => {
            this.logger.error('Failed to enqueue strategy cycle', err);
          });
      },
    );

    // Subscribe to price ticks -> emit to dashboard
    this.priceSub = this.binanceMarketWs.onPrice$.subscribe(
      ({ symbol, price }) => {
        this.dashboardGateway.emitPriceUpdate(symbol, price);
      },
    );

    // Subscribe to bot state changes -> connect/disconnect WS
    this.stateSub = this.botState.onStateChange$.subscribe((state) => {
      if (state.enabled) {
        this.binanceMarketWs.subscribe(state.symbol, state.timeframe);
        this.binanceUserWs.start().catch((err) => {
          this.logger.error('Failed to start user data stream', err);
        });
      } else {
        this.binanceMarketWs.unsubscribe();
        this.binanceUserWs.stop().catch((err) => {
          this.logger.error('Failed to stop user data stream', err);
        });
      }
    });

    // Subscribe to order updates from user data stream -> execution service
    this.orderUpdateSub = this.binanceUserWs.onOrderUpdate$.subscribe(
      (event) => {
        this.execution
          .handleOrderUpdate(event)
          .then(() => {
            // Emit to dashboard
            this.dashboardGateway.emitOrderUpdate({
              clientOrderId: event.o.c,
              status: event.o.X,
              symbol: event.o.s,
              side: event.o.S,
              executedQty: event.o.z,
              avgPrice: event.o.ap,
              realizedProfit: event.o.rp,
            });
          })
          .catch((err) => {
            this.logger.error('Failed to handle order update', err);
          });
      },
    );

    // Subscribe to algo updates (SL/TP conditional orders) from user data stream
    this.algoUpdateSub = this.binanceUserWs.onAlgoUpdate$.subscribe(
      (event) => {
        this.execution
          .handleAlgoUpdate(event)
          .then(() => {
            const o = event.o;
            if (o.X === 'TRIGGERED' || o.X === 'FINISHED') {
              this.dashboardGateway.emitOrderUpdate({
                clientOrderId: o.caid,
                status: 'FILLED',
                symbol: o.s,
                side: o.S,
                executedQty: o.aq,
                avgPrice: o.ap,
                realizedProfit: '0',
              });
            }
          })
          .catch((err) => {
            this.logger.error('Failed to handle algo update', err);
          });
      },
    );

    this.logger.log('Bot module initialized — waiting for start command');
  }

  onModuleDestroy(): void {
    this.candleSub?.unsubscribe();
    this.priceSub?.unsubscribe();
    this.stateSub?.unsubscribe();
    this.orderUpdateSub?.unsubscribe();
    this.algoUpdateSub?.unsubscribe();
  }
}
