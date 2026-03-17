import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BinanceRestService } from '../binance/binance-rest.service';
import { ExchangeInfoService } from '../binance/exchange-info.service';
import { DailyPnl } from './entities/daily-pnl.entity';
import { Trade } from './entities/trade.entity';
import type { ValidatedSignal } from '../strategy/schemas/signal.schema';

export interface RiskDecision {
  approved: boolean;
  reason?: string;
}

@Injectable()
export class RiskManagerService {
  private readonly logger = new Logger(RiskManagerService.name);
  private lastTradeTime = 0;
  private readonly COOLDOWN_MS = 30 * 60_000; // 30 minutes between trades (prevents whipsaw)

  constructor(
    private readonly config: ConfigService,
    private readonly binanceRest: BinanceRestService,
    private readonly exchangeInfo: ExchangeInfoService,
    @InjectRepository(DailyPnl)
    private readonly dailyPnlRepo: Repository<DailyPnl>,
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
  ) {}

  async evaluateSignal(signal: ValidatedSignal): Promise<RiskDecision> {
    const checks = await Promise.all([
      this.checkTradingEnabled(),
      this.checkDailyLossLimit(),
      this.checkPositionSize(signal),
      this.checkCooldown(),
      this.checkExistingPosition(signal.symbol),
      this.checkMinNotional(signal),
    ]);

    const rejection = checks.find((c) => !c.approved);
    if (rejection) {
      this.logger.warn(`Risk check failed: ${rejection.reason}`);
      return rejection;
    }

    return { approved: true };
  }

  recordTradeExecuted(): void {
    this.lastTradeTime = Date.now();
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

  private checkCooldown(): RiskDecision {
    const elapsed = Date.now() - this.lastTradeTime;
    if (elapsed < this.COOLDOWN_MS) {
      const remaining = Math.ceil(
        (this.COOLDOWN_MS - elapsed) / 1000,
      );
      return {
        approved: false,
        reason: `Cooldown active: ${remaining}s remaining`,
      };
    }
    return { approved: true };
  }

  private async checkExistingPosition(
    symbol: string,
  ): Promise<RiskDecision> {
    // Check DB for open trades first (faster than API)
    const openTrade = await this.tradeRepo.findOne({
      where: { symbol, status: 'OPEN' },
    });

    if (openTrade) {
      return {
        approved: false,
        reason: `Existing open trade for ${symbol} (id: ${openTrade.id})`,
      };
    }

    // Also verify with Binance
    try {
      const positions = await this.binanceRest.getPositionRisk(symbol);
      const activePos = positions.find(
        (p) => parseFloat(p.positionAmt) !== 0,
      );
      if (activePos) {
        return {
          approved: false,
          reason: `Existing position on Binance: ${activePos.positionAmt} ${symbol}`,
        };
      }
    } catch (err) {
      this.logger.warn(
        'Failed to check Binance positions, proceeding with DB check only',
        err,
      );
    }

    return { approved: true };
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
