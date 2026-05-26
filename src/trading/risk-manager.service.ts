import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  IExchangeRest,
  IExchangeInfoService,
} from '../exchange/interfaces/exchange.interfaces';
import { DailyPnl } from './entities/daily-pnl.entity';
import { Trade } from './entities/trade.entity';
import { TelemetryService } from './telemetry.service';
import type { ValidatedSignal } from '../strategy/schemas/signal.schema';

export interface RiskDecision {
  approved: boolean;
  reason?: string;
}

@Injectable()
export class RiskManagerService {
  private readonly logger = new Logger(RiskManagerService.name);
  // Per-symbol cooldown (2026-05-24 multi-symbol). Each symbol has its own
  // 30min lockout — a BTC trade should NOT block ETH entries.
  private lastTradeTimeBySymbol: Map<string, number> = new Map();
  private readonly COOLDOWN_MS = 30 * 60_000; // 30 minutes between trades (prevents whipsaw)
  // #8 SAFETY BRAKE (2026-05-21) — pause entries after N consecutive losses (Bybit truth)
  private pausedUntil = 0; // ms timestamp; 0 = not paused

  constructor(
    private readonly config: ConfigService,
    @Inject(IExchangeRest)
    private readonly exchange: IExchangeRest,
    @Inject(IExchangeInfoService)
    private readonly exchangeInfo: IExchangeInfoService,
    @InjectRepository(DailyPnl)
    private readonly dailyPnlRepo: Repository<DailyPnl>,
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    private readonly telemetry: TelemetryService,
  ) {}

  async evaluateSignal(signal: ValidatedSignal): Promise<RiskDecision> {
    const checks = await Promise.all([
      this.checkTradingEnabled(),
      this.checkDailyLossLimit(),
      this.checkPositionSize(signal),
      this.checkCooldown(signal.symbol),
      this.checkExistingPosition(signal.symbol),
      this.checkMinNotional(signal),
      this.checkConsecutiveLossesBybit(), // #8 safety brake (2026-05-21)
    ]);

    const rejection = checks.find((c) => !c.approved);
    if (rejection) {
      this.logger.warn(`Risk check failed: ${rejection.reason}`);
      this.telemetry
        .recordSignalLifecycle('rejected', rejection.reason)
        .catch(() => {});
      return rejection;
    }

    return { approved: true };
  }

  recordTradeExecuted(symbol?: string): void {
    if (symbol) {
      this.lastTradeTimeBySymbol.set(symbol, Date.now());
    } else {
      // Backward compat: if no symbol passed, set for all known symbols
      // (treat as global cooldown — legacy behavior).
      const now = Date.now();
      for (const sym of this.lastTradeTimeBySymbol.keys()) {
        this.lastTradeTimeBySymbol.set(sym, now);
      }
    }
  }

  private checkTradingEnabled(): RiskDecision {
    const enabled = this.config.get<boolean>('TRADING_ENABLED');
    if (!enabled) {
      return { approved: false, reason: 'Trading is disabled (TRADING_ENABLED=false)' };
    }
    return { approved: true };
  }

  private async checkDailyLossLimit(): Promise<RiskDecision> {
    const maxLoss = this.config.get<number>('MAX_DAILY_LOSS_USDT')!;
    const today = new Date().toISOString().split('T')[0];

    const dailyPnl = await this.dailyPnlRepo.findOne({
      where: { date: today },
    });

    if (dailyPnl && Number(dailyPnl.realizedPnl) <= -maxLoss) {
      return {
        approved: false,
        reason: `Daily loss limit reached: ${dailyPnl.realizedPnl} USDT (max: -${maxLoss})`,
      };
    }

    return { approved: true };
  }

  private checkPositionSize(signal: ValidatedSignal): RiskDecision {
    const maxNotional = this.config.get<number>(
      'MAX_POSITION_NOTIONAL_USDT',
    )!;
    // We'll calculate actual notional at execution time,
    // but we can sanity check the entry price here
    if (signal.entryPrice <= 0) {
      return { approved: false, reason: 'Invalid entry price' };
    }

    return { approved: true };
  }

  private checkCooldown(symbol: string): RiskDecision {
    const lastTime = this.lastTradeTimeBySymbol.get(symbol) ?? 0;
    const elapsed = Date.now() - lastTime;
    if (elapsed < this.COOLDOWN_MS) {
      const remaining = Math.ceil(
        (this.COOLDOWN_MS - elapsed) / 1000,
      );
      return {
        approved: false,
        reason: `Cooldown active for ${symbol}: ${remaining}s remaining`,
      };
    }
    return { approved: true };
  }

  private async checkExistingPosition(
    symbol: string,
  ): Promise<RiskDecision> {
    // Exchange is authoritative — check it FIRST. If exchange has no position
    // but DB has trade OPEN, that's a zombie (reconcile failed). Force-close
    // the zombie to unblock new signals (resolves abr-may 2026 gap class).
    let exchangeHasPosition = false;
    let exchangeQueryFailed = false;
    try {
      const positions = await this.exchange.getPositions(symbol);
      const activePos = positions.find(
        (p) => parseFloat(p.positionAmt) !== 0,
      );
      if (activePos) {
        exchangeHasPosition = true;
        return {
          approved: false,
          reason: `Existing position on ${this.exchange.provider}: ${activePos.positionAmt} ${symbol}`,
        };
      }
    } catch (err) {
      this.logger.warn(
        'Failed to check exchange positions, falling back to DB check only',
        err,
      );
      exchangeQueryFailed = true;
    }

    // No active position on exchange. Now look at DB.
    const openTrade = await this.tradeRepo.findOne({
      where: { symbol, status: 'OPEN' },
    });

    if (!openTrade) return { approved: true };

    // DB has OPEN but exchange has no position.
    if (exchangeQueryFailed) {
      // Be conservative: if we couldn't verify with exchange, trust DB.
      return {
        approved: false,
        reason: `Existing open trade for ${symbol} (id: ${openTrade.id}) — exchange unreachable, conservative reject`,
      };
    }

    // Confirmed zombie. Mark CLOSED_ORPHAN to prevent blocking future signals.
    this.logger.warn(
      `Zombie trade detected: ${openTrade.id} marked OPEN but no position on ${this.exchange.provider}. ` +
        `Closing as CLOSED_ORPHAN to unblock new signals.`,
    );
    try {
      openTrade.status = 'CLOSED_ORPHAN';
      openTrade.closedAt = new Date();
      await this.tradeRepo.save(openTrade);
    } catch (saveErr) {
      this.logger.error(
        `Failed to close zombie trade ${openTrade.id}: ${saveErr}. Rejecting signal to be safe.`,
      );
      return {
        approved: false,
        reason: `Zombie trade detected but cleanup failed (id: ${openTrade.id})`,
      };
    }

    return { approved: true };
  }

  /**
   * #8 SAFETY BRAKE (2026-05-21) — pause entries after N consecutive losses
   * according to Bybit-truth PnL (bybitNetPnl), NOT bot's broken realizedPnl.
   *
   * Env vars:
   *   MAX_CONSECUTIVE_LOSSES (default 3): how many losses in a row to trigger pause
   *   CONSECUTIVE_LOSS_PAUSE_HOURS (default 24): how long to stay paused
   *
   * Only counts trades that have been reconciled with Bybit (pnlSource set).
   * Trades without Bybit reconciliation are ignored — better to allow trading
   * than freeze on stale legacy data.
   */
  private async checkConsecutiveLossesBybit(): Promise<RiskDecision> {
    // Currently paused?
    if (this.pausedUntil > Date.now()) {
      const remainMin = Math.ceil((this.pausedUntil - Date.now()) / 60000);
      return {
        approved: false,
        reason: `Safety brake active: paused for ${remainMin}min more (consecutive Bybit losses)`,
      };
    }

    const maxConsecutive = Number(
      this.config.get<number>('MAX_CONSECUTIVE_LOSSES', 3),
    );
    const pauseHours = Number(
      this.config.get<number>('CONSECUTIVE_LOSS_PAUSE_HOURS', 24),
    );

    if (maxConsecutive <= 0) return { approved: true }; // disabled

    // Fetch last N closed trades with Bybit reconciliation
    const recentTrades = await this.tradeRepo
      .createQueryBuilder('t')
      .where("t.status LIKE 'CLOSED%'")
      .andWhere('t."bybitNetPnl" IS NOT NULL')
      .orderBy('t."closedAt"', 'DESC')
      .limit(maxConsecutive)
      .getMany();

    if (recentTrades.length < maxConsecutive) {
      // Not enough Bybit-reconciled trades yet — don't trigger
      return { approved: true };
    }

    const allLosses = recentTrades.every(
      (t) => Number(t.bybitNetPnl) < 0,
    );

    if (allLosses) {
      this.pausedUntil = Date.now() + pauseHours * 3600_000;
      const tradeIds = recentTrades.map((t) => t.id.slice(0, 8)).join(', ');
      this.logger.error(
        `🚨 SAFETY BRAKE TRIGGERED: ${maxConsecutive} consecutive Bybit-truth losses ` +
          `(trades ${tradeIds}). Pausing entries for ${pauseHours}h until ` +
          new Date(this.pausedUntil).toISOString(),
      );
      return {
        approved: false,
        reason: `Safety brake: ${maxConsecutive} consecutive losses according to Bybit. Pause ${pauseHours}h.`,
      };
    }

    return { approved: true };
  }

  /**
   * Manual override to clear the safety brake (for emergency unpause).
   * Currently no API endpoint — set via DB or restart container.
   */
  resetSafetyBrake(): void {
    this.pausedUntil = 0;
    this.logger.warn('Safety brake reset manually');
  }

  private checkMinNotional(signal: ValidatedSignal): RiskDecision {
    const minNotional = this.exchangeInfo.getMinNotional(signal.symbol);
    const maxNotional = this.config.get<number>(
      'MAX_POSITION_NOTIONAL_USDT',
    )!;

    if (maxNotional < minNotional) {
      return {
        approved: false,
        reason: `MAX_POSITION_NOTIONAL (${maxNotional}) is below exchange minimum (${minNotional})`,
      };
    }

    return { approved: true };
  }
}
