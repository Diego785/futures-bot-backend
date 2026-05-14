import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BotStateService } from './bot-state.service';
import { IUserDataPort } from '../exchange/interfaces/exchange.interfaces';
import { ExecutionService } from '../trading/execution.service';
import { TelemetryService } from '../trading/telemetry.service';
import { FcmService } from '../notifications/fcm.service';

@Injectable()
export class MaintenanceCronService {
  private readonly logger = new Logger(MaintenanceCronService.name);
  // 18 min ~= 1 full 15m candle missed. Above this, WS is likely stalled.
  private readonly HEARTBEAT_STALE_MS = 18 * 60 * 1000;
  private lastHeartbeatAlertAt = 0;

  constructor(
    private readonly botState: BotStateService,
    @Inject(IUserDataPort)
    private readonly userData: IUserDataPort,
    private readonly execution: ExecutionService,
    private readonly telemetry: TelemetryService,
    private readonly fcm: FcmService,
  ) {}

  // ListenKey keepalive every 30 minutes (Binance only — Bybit no-op)
  @Cron('0 */30 * * * *')
  async keepaliveListenKey(): Promise<void> {
    if (!this.botState.enabled) return;
    await this.userData.keepalive();
  }

  // Reconcile positions every 1 minute (syncs entry price, detects closed positions)
  @Cron('0 */1 * * * *')
  async reconcilePositions(): Promise<void> {
    if (!this.botState.enabled) return;
    await this.execution.reconcilePositions();
  }

  // Heartbeat check every 5 min. Alerts when bot processed 0 cycles in last 18 min.
  // Detects WS staleness / bot offline scenarios that produced the abr-may 2026 gap.
  @Cron('0 */5 * * * *')
  async heartbeatCheck(): Promise<void> {
    if (!this.botState.enabled) return;
    try {
      const latest = await this.telemetry.getLatestCycleAt();
      if (!latest) return;
      const ageMs = Date.now() - latest.getTime();
      if (ageMs > this.HEARTBEAT_STALE_MS) {
        const ageMin = Math.floor(ageMs / 60000);
        const sinceLastAlertMin =
          (Date.now() - this.lastHeartbeatAlertAt) / 60000;
        // De-dupe: don't spam more than once every 30 min
        if (sinceLastAlertMin < 30) return;
        this.lastHeartbeatAlertAt = Date.now();
        this.logger.error(
          `🚨 Heartbeat STALE: ${ageMin}min since last cycle. WS likely stalled or bot offline.`,
        );
        this.fcm
          .notifyBotError(
            `Heartbeat stale: ${ageMin}min sin cycles`,
            'Probable WS staleness o bot offline. Revisar docker logs.',
          )
          .catch(() => {});
      }
    } catch (err) {
      this.logger.warn(`Heartbeat check failed: ${err}`);
    }
  }

  // Log daily reset at midnight UTC
  @Cron('0 0 0 * * *')
  dailyReset(): void {
    this.logger.log('New trading day started (UTC midnight)');
  }
}
