import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { BotStateService } from './bot-state.service';
import { IUserDataPort } from '../exchange/interfaces/exchange.interfaces';
import { ExecutionService } from '../trading/execution.service';
import { TelemetryService } from '../trading/telemetry.service';
import { FcmService } from '../notifications/fcm.service';

@Injectable()
export class MaintenanceCronService {
  private readonly logger = new Logger(MaintenanceCronService.name);
  private lastHeartbeatAlertAt = 0;

  constructor(
    private readonly botState: BotStateService,
    @Inject(IUserDataPort)
    private readonly userData: IUserDataPort,
    private readonly execution: ExecutionService,
    private readonly telemetry: TelemetryService,
    private readonly fcm: FcmService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Heartbeat threshold proportional to active timeframe.
   * Stale = 1.5x normal cycle interval. Fixed bug where 18min threshold
   * (sized for 15m timeframe) generated false positives in 1h timeframe
   * every hour normally. Reconciled 2026-05-16 after live deploy of 1h.
   */
  private getHeartbeatStaleMs(): number {
    const timeframe = this.config.get<string>('DEFAULT_TIMEFRAME', '15m');
    const minutesMap: Record<string, number> = {
      '1m': 1,
      '5m': 5,
      '15m': 15,
      '30m': 30,
      '1h': 60,
      '4h': 240,
    };
    const tfMinutes = minutesMap[timeframe] ?? 15;
    // 1.5x candle interval — alerts when ~1.5 candles missed
    return Math.floor(tfMinutes * 1.5 * 60 * 1000);
  }

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

  // Heartbeat check every 5 min. Alerts when bot processed 0 cycles in
  // 1.5x normal candle interval (proportional to DEFAULT_TIMEFRAME).
  // Detects WS staleness / bot offline scenarios that produced the abr-may 2026 gap.
  @Cron('0 */5 * * * *')
  async heartbeatCheck(): Promise<void> {
    if (!this.botState.enabled) return;
    try {
      const latest = await this.telemetry.getLatestCycleAt();
      if (!latest) return;
      const staleMs = this.getHeartbeatStaleMs();
      const ageMs = Date.now() - latest.getTime();
      if (ageMs > staleMs) {
        const ageMin = Math.floor(ageMs / 60000);
        const staleMin = Math.floor(staleMs / 60000);
        const sinceLastAlertMin =
          (Date.now() - this.lastHeartbeatAlertAt) / 60000;
        // De-dupe: don't spam more than once every 30 min
        if (sinceLastAlertMin < 30) return;
        this.lastHeartbeatAlertAt = Date.now();
        const timeframe = this.config.get<string>('DEFAULT_TIMEFRAME', '15m');
        this.logger.error(
          `🚨 Heartbeat STALE: ${ageMin}min since last cycle (threshold ${staleMin}min for ${timeframe}). WS likely stalled or bot offline.`,
        );
        this.fcm
          .notifyBotError(
            `Heartbeat stale: ${ageMin}min sin cycles`,
            `Threshold ${staleMin}min para ${timeframe}. Probable WS staleness o bot offline.`,
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
