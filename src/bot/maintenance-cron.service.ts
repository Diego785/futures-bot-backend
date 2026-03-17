import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BotStateService } from './bot-state.service';
import { BinanceUserWsService } from '../binance/binance-user-ws.service';
import { ExecutionService } from '../trading/execution.service';

@Injectable()
export class MaintenanceCronService {
  private readonly logger = new Logger(MaintenanceCronService.name);

  constructor(
    private readonly botState: BotStateService,
    private readonly binanceUserWs: BinanceUserWsService,
    private readonly execution: ExecutionService,
  ) {}

  // ListenKey keepalive every 30 minutes
  @Cron('0 */30 * * * *')
  async keepaliveListenKey(): Promise<void> {
    if (!this.botState.enabled) return;
    await this.binanceUserWs.keepalive();
  }

  // Reconcile positions every 1 minute (syncs entry price, detects closed positions)
  @Cron('0 */1 * * * *')
  async reconcilePositions(): Promise<void> {
    if (!this.botState.enabled) return;
    await this.execution.reconcilePositions();
  }

  // Log daily reset at midnight UTC
  @Cron('0 0 0 * * *')
  dailyReset(): void {
    this.logger.log('New trading day started (UTC midnight)');
  }
}
