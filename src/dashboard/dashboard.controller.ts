import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Logger,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Signal } from '../trading/entities/signal.entity';
import { Trade } from '../trading/entities/trade.entity';
import { DailyPnl } from '../trading/entities/daily-pnl.entity';
import { DailyTelemetry } from '../trading/entities/daily-telemetry.entity';
import {
  IExchangeRest,
  IExchangeInfoService,
  OrderSide,
  OrderType,
  TimeInForce,
  type Balance,
  type Position,
} from '../exchange/interfaces/exchange.interfaces';
import { StartBotDto } from './dto/bot-control.dto';
import { PaginatedQueryDto } from './dto/paginated-query.dto';
import { BotStateService } from '../bot/bot-state.service';
import { KillSwitchService } from '../bot/kill-switch.service';
import { PreFilterGateService } from '../strategy/pre-filter-gate.service';
import { DashboardGateway } from './dashboard.gateway';
import { FcmService } from '../notifications/fcm.service';
import { roundToTickSize, roundToStepSize } from '../common/utils/precision.util';

@Controller('api')
export class DashboardController {
  private readonly logger = new Logger(DashboardController.name);

  constructor(
    private readonly botState: BotStateService,
    private readonly killSwitch: KillSwitchService,
    @Inject(IExchangeRest)
    private readonly exchange: IExchangeRest,
    @Inject(IExchangeInfoService)
    private readonly exchangeInfo: IExchangeInfoService,
    private readonly preFilterGate: PreFilterGateService,
    private readonly dashboardGateway: DashboardGateway,
    private readonly fcmService: FcmService,
    private readonly config: ConfigService,
    @InjectRepository(Signal)
    private readonly signalRepo: Repository<Signal>,
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    @InjectRepository(DailyPnl)
    private readonly dailyPnlRepo: Repository<DailyPnl>,
    @InjectRepository(DailyTelemetry)
    private readonly telemetryRepo: Repository<DailyTelemetry>,
  ) {}

  @Get('status')
  async getStatus() {
    const state = this.botState.getState();
    let balance: Balance | null = null;
    let position: Position | null = null;

    try {
      balance = await this.exchange.getBalance('USDT');
    } catch (err: any) {
      console.error('Balance fetch failed:', err?.response?.data || err?.message || err);
    }

    try {
      const positions = await this.exchange.getPositions(state.symbol);
      position =
        positions.find((p) => parseFloat(p.positionAmt) !== 0) ?? null;
    } catch (err: any) {
      console.error('Position fetch failed:', err?.response?.data || err?.message || err);
    }

    const today = new Date().toISOString().split('T')[0];
    const dailyPnl = await this.dailyPnlRepo.findOne({
      where: { date: today },
    });

    return {
      exchange: this.exchange.provider,
      bot: state,
      balance: balance
        ? {
            total: balance.balance,
            available: balance.availableBalance,
            unrealizedPnl: balance.crossUnrealizedPnl,
          }
        : null,
      position,
      dailyPnl: dailyPnl
        ? {
            pnl: dailyPnl.realizedPnl,
            trades: dailyPnl.tradesCount,
            wins: dailyPnl.winsCount,
            losses: dailyPnl.lossesCount,
          }
        : null,
      rateLimit: this.exchange.getUsedWeight(),
      gate: this.preFilterGate.getStats(),
    };
  }

  @Post('bot/start')
  async startBot(@Body() dto: StartBotDto) {
    this.botState.start(dto.symbol, dto.timeframe);
    this.logger.log(
      `Bot started: ${this.botState.symbol} ${this.botState.timeframe}`,
    );
    return { success: true, state: this.botState.getState() };
  }

  @Post('bot/stop')
  stopBot() {
    this.botState.stop();
    this.logger.log('Bot stopped');
    return { success: true, state: this.botState.getState() };
  }

  @Post('bot/kill')
  async killBot() {
    await this.killSwitch.activate('Manual kill switch via API');
    return { success: true, message: 'Kill switch activated' };
  }

  /**
   * Pre-flight checks before going EXECUTION_MODE=live.
   *
   * Runs each check independently so a single failure doesn't mask others:
   *   1. Balance USDT >= minNotional
   *   2. No open position on the active symbol
   *   3. Leverage set to MAX_LEVERAGE
   *   4. Round-trip place+cancel of a far-OOM LIMIT order
   *      (validates HMAC sign, account permissions, symbol metadata)
   *
   * Pass `{ "skipPlaceOrder": true }` to skip step 4 (no orders placed at all).
   */
  @Post('bot/preflight')
  async preflight(@Body() body?: { skipPlaceOrder?: boolean; symbol?: string }) {
    const symbol = body?.symbol ?? this.botState.symbol ?? 'BTCUSDT';
    const skipPlaceOrder = body?.skipPlaceOrder ?? false;
    const maxLeverage = this.config.get<number>('MAX_LEVERAGE', 5);
    const minNotional = this.exchangeInfo.getMinNotional(symbol);

    type Check = {
      name: string;
      status: 'ok' | 'warn' | 'error';
      value?: string;
      message: string;
    };
    const checks: Check[] = [];

    // 1. Balance check
    let balance: Balance | null = null;
    try {
      balance = await this.exchange.getBalance('USDT');
      const availRaw = balance ? parseFloat(balance.availableBalance) : 0;
      const totalRaw = balance ? parseFloat(balance.balance) : 0;
      // Coerce non-finite (NaN from empty strings) to 0 so the comparison is meaningful.
      const avail = Number.isFinite(availRaw) ? availRaw : 0;
      const total = Number.isFinite(totalRaw) ? totalRaw : 0;
      const minRequired = minNotional / maxLeverage + 1; // margin + commission cushion

      if (!balance) {
        checks.push({
          name: 'balance',
          status: 'error',
          message: 'No USDT wallet found in account. Open Bybit Unified Trading Account and deposit USDT.',
        });
      } else if (avail <= 0) {
        checks.push({
          name: 'balance',
          status: 'error',
          value: `total=$${total.toFixed(2)} avail=$${avail.toFixed(2)}`,
          message:
            'USDT balance is zero. Transfer USDT into Bybit Unified Trading Account ' +
            '(Bybit web → Assets → Transfer → destination "Unified Trading Account").',
        });
      } else if (avail < minRequired) {
        checks.push({
          name: 'balance',
          status: 'warn',
          value: `total=$${total.toFixed(2)} avail=$${avail.toFixed(2)}`,
          message: `Available below minimum margin needed ($${minRequired.toFixed(2)} for ${minNotional} USDT notional @ ${maxLeverage}x).`,
        });
      } else {
        checks.push({
          name: 'balance',
          status: 'ok',
          value: `total=$${total.toFixed(2)} avail=$${avail.toFixed(2)}`,
          message: `Sufficient margin for one trade.`,
        });
      }
    } catch (err: any) {
      checks.push({
        name: 'balance',
        status: 'error',
        message: extractErrMsg(err),
      });
    }

    // 2. Position check
    let activePosition: Position | undefined;
    try {
      const positions = await this.exchange.getPositions(symbol);
      activePosition = positions.find((p) => parseFloat(p.positionAmt) !== 0);
      if (activePosition) {
        checks.push({
          name: 'position',
          status: 'warn',
          value: `${activePosition.positionSide} ${activePosition.positionAmt} @ ${activePosition.entryPrice}`,
          message: `Existing open position on ${symbol}. Bot will not open a new one until this closes.`,
        });
      } else {
        checks.push({
          name: 'position',
          status: 'ok',
          value: 'no open position',
          message: 'Ready to open new position.',
        });
      }
    } catch (err: any) {
      checks.push({
        name: 'position',
        status: 'error',
        message: extractErrMsg(err),
      });
    }

    // 3. Leverage check
    try {
      await this.exchange.changeLeverage(symbol, maxLeverage);
      checks.push({
        name: 'leverage',
        status: 'ok',
        value: `${maxLeverage}x`,
        message: 'Leverage set / already at target.',
      });
    } catch (err: any) {
      checks.push({
        name: 'leverage',
        status: 'error',
        message: extractErrMsg(err),
      });
    }

    // 4. Round-trip place+cancel (most important — validates HMAC signing
    //    and account trading permissions). Skipped if requested.
    if (skipPlaceOrder) {
      checks.push({
        name: 'place_order',
        status: 'warn',
        message: 'Skipped (skipPlaceOrder=true). HMAC sign + trading permission unverified.',
      });
    } else {
      const stepSize = this.exchangeInfo.getStepSize(symbol);
      const tickSize = this.exchangeInfo.getTickSize(symbol);
      const minQty = parseFloat(this.exchangeInfo.getSymbolInfo(symbol)?.minQty ?? '0.001');
      const qty = roundToStepSize(minQty, stepSize);

      // Place a LIMIT BUY at 50% below mark price — guaranteed not to fill.
      // Need a reference price: prefer position markPrice if available, else
      // fall back to a ticker fetch via getKlines(1m).
      let refPrice: number | null = null;
      if (activePosition) {
        refPrice = parseFloat(activePosition.markPrice);
      }
      if (!refPrice || !Number.isFinite(refPrice) || refPrice <= 0) {
        try {
          const klines = await this.exchange.getKlines(symbol, '1m', 1);
          refPrice = klines[0]?.close ?? null;
        } catch {
          // ignore — handled below
        }
      }

      if (!refPrice || refPrice <= 0) {
        checks.push({
          name: 'place_order',
          status: 'error',
          message: 'Could not fetch reference price to place dummy order.',
        });
      } else {
        const dummyPrice = roundToTickSize(refPrice * 0.5, tickSize);
        const dummyClientId = `PREFLIGHT_${Date.now().toString(36)}`;
        let placed = false;
        try {
          const placeResp = await this.exchange.placeOrder({
            symbol,
            side: OrderSide.BUY,
            type: OrderType.LIMIT,
            quantity: qty,
            price: dummyPrice,
            timeInForce: TimeInForce.GTC,
            clientOrderId: dummyClientId,
          });
          placed = true;
          // Immediately cancel — guaranteed not to have filled at 50% below mark.
          try {
            await this.exchange.cancelOrder(symbol, dummyClientId);
            checks.push({
              name: 'place_order',
              status: 'ok',
              value: `placed+canceled orderId=${placeResp.orderId}`,
              message: `Round-trip OK at $${dummyPrice} (50% below mark $${refPrice.toFixed(2)}).`,
            });
          } catch (cancelErr: any) {
            checks.push({
              name: 'place_order',
              status: 'error',
              value: `placed=${placeResp.orderId} but cancel failed`,
              message: `CRITICAL: dummy order placed but cancel failed: ${extractErrMsg(cancelErr)}. Cancel it manually on the exchange.`,
            });
          }
        } catch (placeErr: any) {
          checks.push({
            name: 'place_order',
            status: 'error',
            value: placed ? 'placed but errored after' : 'placement rejected',
            message: extractErrMsg(placeErr),
          });
        }
      }
    }

    const ready = checks.every((c) => c.status === 'ok');
    return {
      exchange: this.exchange.provider,
      symbol,
      ready,
      checks,
    };
  }

  @Get('trades')
  async getTrades(@Query() query: PaginatedQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [trades, total] = await this.tradeRepo.findAndCount({
      order: { openedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
      relations: ['orders'],
    });

    return { data: trades, total, page, limit };
  }

  @Get('trades/:id')
  async getTradeById(@Param('id') id: string) {
    return this.tradeRepo.findOne({
      where: { id },
      relations: ['orders', 'signal'],
    });
  }

  @Get('signals')
  async getSignals(@Query() query: PaginatedQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [signals, total] = await this.signalRepo.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data: signals, total, page, limit };
  }

  @Get('positions')
  async getPositions() {
    try {
      const positions = await this.exchange.getPositions();
      return positions.filter((p) => parseFloat(p.positionAmt) !== 0);
    } catch {
      return [];
    }
  }

  @Get('balance')
  async getBalance() {
    try {
      return await this.exchange.getBalance('USDT');
    } catch {
      return null;
    }
  }

  @Post('fcm-token')
  registerFcmToken(@Body() body: { token: string }) {
    if (body.token) {
      this.fcmService.registerToken(body.token);
      return { success: true };
    }
    return { success: false, error: 'No token provided' };
  }

  @Get('last-analysis')
  getLastAnalysis() {
    return this.dashboardGateway.getLastAnalysis();
  }

  @Get('analysis-history')
  getAnalysisHistory() {
    return this.dashboardGateway.getAnalysisHistory();
  }

  @Get('last-gate')
  getLastGate() {
    return this.dashboardGateway.getLastGateResult();
  }

  @Get('daily-pnl')
  async getDailyPnl(@Query('days') days = 30) {
    const records = await this.dailyPnlRepo.find({
      order: { date: 'DESC' },
      take: days,
    });
    return records;
  }

  // Telemetry endpoint — returns per-day cycle/signal lifecycle stats
  // Used by dashboard to monitor bot health and identify dominant block reasons
  // without SSH to VPS. Added 2026-05-14.
  @Get('telemetry')
  async getTelemetry(@Query('days') days = 14) {
    try {
      const records = await this.telemetryRepo.find({
        order: { date: 'DESC' },
        take: Number(days),
      });
      return records;
    } catch (err) {
      this.logger.warn(`Telemetry query failed (table may not exist): ${err}`);
      return [];
    }
  }

  // PnL reconciliation endpoint (2026-05-20) — returns trades with Bybit-sourced
  // PnL vs bot's calculated PnL. Use bybitNetPnl as source of truth.
  // Trades with |pnlDiffFromDb| > 0.05 indicate the known DB PnL bug.
  @Get('pnl-reconciliation')
  async getPnlReconciliation(@Query('days') days = 7) {
    try {
      const since = new Date();
      since.setDate(since.getDate() - Number(days));
      const trades = await this.tradeRepo
        .createQueryBuilder('t')
        .where('t."closedAt" >= :since', { since })
        .orderBy('t."closedAt"', 'DESC')
        .limit(100)
        .getMany();
      return trades.map((t) => ({
        id: t.id,
        direction: t.direction,
        status: t.status,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        // DB's old calculation (suspect)
        db_realizedPnl: t.realizedPnl,
        db_commission: t.commission,
        // Bybit truth
        bybit_realizedPnl: t.bybitRealizedPnl,
        bybit_fees: t.bybitFees,
        bybit_funding: t.bybitFunding,
        bybit_netPnl: t.bybitNetPnl,
        // Diagnostic
        pnlDiff: t.pnlDiffFromDb,
        pnlSource: t.pnlSource,
        reconciledAt: t.pnlReconciledAt,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
      }));
    } catch (err) {
      this.logger.warn(`PnL reconciliation query failed: ${err}`);
      return [];
    }
  }
}

function extractErrMsg(err: any): string {
  return (
    err?.response?.data?.retMsg ||
    err?.response?.data?.msg ||
    err?.response?.data ||
    err?.message ||
    String(err)
  );
}
