import {
  Module,
  forwardRef,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
  Inject,
} from '@nestjs/common';
import { InjectQueue, BullModule } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Subscription } from 'rxjs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QUEUE_NAMES } from '../common/constants/binance.constants';
import { ExchangeModule } from '../exchange/exchange.module';
import {
  IMarketDataPort,
  IUserDataPort,
  ConditionalStatus,
  OrderStatus,
} from '../exchange/interfaces/exchange.interfaces';
import { StrategyModule } from '../strategy/strategy.module';
import { TradingModule } from '../trading/trading.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
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
    ExchangeModule,
    StrategyModule,
    TradingModule,
    TelemetryModule,
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
  private conditionalUpdateSub: Subscription | null = null;

  constructor(
    private readonly botState: BotStateService,
    @Inject(IMarketDataPort)
    private readonly marketData: IMarketDataPort,
    @Inject(IUserDataPort)
    private readonly userData: IUserDataPort,
    private readonly execution: ExecutionService,
    private readonly dashboardGateway: DashboardGateway,
    @InjectQueue(QUEUE_NAMES.STRATEGY_CYCLE)
    private readonly strategyCycleQueue: Queue,
  ) {}

  onModuleInit(): void {
    // Subscribe to candle close events -> enqueue BullMQ jobs (per symbol).
    // Multi-symbol (2026-05-24): filter against the bot state's symbol list, not single symbol.
    this.candleSub = this.marketData.onCandleClose$.subscribe(
      ({ symbol, candle }) => {
        if (!this.botState.enabled || !this.botState.symbols.includes(symbol)) {
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
    this.priceSub = this.marketData.onPrice$.subscribe(
      ({ symbol, price }) => {
        this.dashboardGateway.emitPriceUpdate(symbol, price);
      },
    );

    // Subscribe to bot state changes -> connect/disconnect WS.
    // Multi-symbol (2026-05-24): subscribe to each symbol over the same WS.
    this.stateSub = this.botState.onStateChange$.subscribe((state) => {
      if (state.enabled) {
        for (const sym of state.symbols) {
          this.marketData.subscribe(sym, state.timeframe);
        }
        this.userData.start().catch((err) => {
          this.logger.error('Failed to start user data stream', err);
        });
      } else {
        this.marketData.unsubscribe();
        this.userData.stop().catch((err) => {
          this.logger.error('Failed to stop user data stream', err);
        });
      }
    });

    // Order updates from user data stream -> execution service
    this.orderUpdateSub = this.userData.onOrderUpdate$.subscribe((update) => {
      this.execution
        .handleOrderUpdate(update)
        .then(() => {
          this.dashboardGateway.emitOrderUpdate({
            clientOrderId: update.clientOrderId,
            status: update.status,
            symbol: update.symbol,
            side: update.side,
            executedQty: update.cumFilledQty,
            avgPrice: update.avgPrice,
            realizedProfit: update.realizedPnl,
          });
        })
        .catch((err) => {
          this.logger.error('Failed to handle order update', err);
        });
    });

    // Conditional updates (SL/TP) from user data stream -> execution service
    this.conditionalUpdateSub = this.userData.onConditionalUpdate$.subscribe(
      (update) => {
        this.execution
          .handleConditionalUpdate(update)
          .then(() => {
            if (
              update.status === ConditionalStatus.TRIGGERED ||
              update.status === ConditionalStatus.FINISHED
            ) {
              this.dashboardGateway.emitOrderUpdate({
                clientOrderId: update.clientOrderId,
                status: OrderStatus.FILLED,
                symbol: update.symbol,
                side: update.side,
                executedQty: update.executedQty ?? '0',
                avgPrice: update.avgPrice ?? '0',
                realizedProfit: '0',
              });
            }
          })
          .catch((err) => {
            this.logger.error('Failed to handle conditional update', err);
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
    this.conditionalUpdateSub?.unsubscribe();
  }
}
