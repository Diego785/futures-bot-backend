import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RiskManagerService } from './risk-manager.service';
import { Signal } from './entities/signal.entity';
import { Order } from './entities/order.entity';
import { Trade } from './entities/trade.entity';
import { DailyPnl } from './entities/daily-pnl.entity';
import {
  roundToStepSize,
  roundToTickSize,
} from '../common/utils/precision.util';
import { generateClientOrderId } from '../common/utils/client-order-id.util';
import type { ValidatedSignal } from '../strategy/schemas/signal.schema';
import {
  IExchangeRest,
  IExchangeInfoService,
  OrderSide,
  PositionSide,
  OrderType,
  OrderStatus,
  ConditionalStatus,
  TimeInForce,
  IncomeType,
  type OrderUpdate,
  type ConditionalUpdate,
  type UserTrade,
} from '../exchange/interfaces/exchange.interfaces';
import { FcmService } from '../notifications/fcm.service';

@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);
  private readonly closingTrades = new Set<string>();
  private isReconciling = false;
  // Per-trade MFE/MAE tracking for post-entry monitoring
  private readonly tradeExcursions = new Map<string, { mfe: number; mae: number }>();

  constructor(
    private readonly config: ConfigService,
    @Inject(IExchangeRest)
    private readonly exchange: IExchangeRest,
    @Inject(IExchangeInfoService)
    private readonly exchangeInfo: IExchangeInfoService,
    private readonly riskManager: RiskManagerService,
    @InjectRepository(Signal)
    private readonly signalRepo: Repository<Signal>,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    @InjectRepository(DailyPnl)
    private readonly dailyPnlRepo: Repository<DailyPnl>,
    private readonly fcmService: FcmService,
  ) {}

  async executeSignal(
    signal: ValidatedSignal,
    signalEntity: Signal,
  ): Promise<Trade | null> {
    const { symbol } = signal;
    const maxLeverage = this.config.get<number>('MAX_LEVERAGE')!;
    const maxNotional = this.config.get<number>(
      'MAX_POSITION_NOTIONAL_USDT',
    )!;

    try {
      // 1. Get available balance
      const usdtBalance = await this.exchange.getBalance('USDT');
      const available = usdtBalance
        ? parseFloat(usdtBalance.availableBalance)
        : 0;

      if (available <= 0) {
        this.logger.error('No USDT balance available');
        return null;
      }

      // 2. Calculate position size (leverage-adjusted)
      const notional = Math.min(maxNotional, available * 0.9);
      const leveragedNotional = notional * maxLeverage;
      const stepSize = this.exchangeInfo.getStepSize(symbol);
      const tickSize = this.exchangeInfo.getTickSize(symbol);
      const exchangeMinNotional = this.exchangeInfo.getMinNotional(symbol);
      const rawQty = leveragedNotional / signal.entryPrice;
      let quantity = roundToStepSize(rawQty, stepSize);
      let actualNotional = parseFloat(quantity) * signal.entryPrice;

      // If the floored qty drops actual notional below the exchange minimum,
      // bump it up one step — but only if the resulting margin still fits in balance.
      if (actualNotional < exchangeMinNotional) {
        const step = parseFloat(stepSize);
        const bumpedQty = parseFloat(quantity) + step;
        const bumpedNotional = bumpedQty * signal.entryPrice;
        const requiredMargin = bumpedNotional / maxLeverage;

        const commissionReserve = 0.20;
        if (requiredMargin + commissionReserve <= available) {
          quantity = roundToStepSize(bumpedQty, stepSize);
          actualNotional = parseFloat(quantity) * signal.entryPrice;
          this.logger.warn(
            `Qty bumped to meet min notional ${exchangeMinNotional}: ` +
              `qty=${quantity} notional=${actualNotional.toFixed(2)} margin=${requiredMargin.toFixed(2)}`,
          );
        } else {
          this.logger.error(
            `Cannot meet min notional ${exchangeMinNotional} with balance ${available.toFixed(2)}: ` +
              `would need margin ${requiredMargin.toFixed(2)} + $${commissionReserve} commission reserve. Trade skipped.`,
          );
          return null;
        }
      }

      this.logger.log(
        `Position sizing: balance=${available.toFixed(2)} notional=${notional} ` +
          `leverage=${maxLeverage}x leveraged=${leveragedNotional.toFixed(2)} ` +
          `qty=${quantity} actualNotional=${actualNotional.toFixed(2)}`,
      );

      if (parseFloat(quantity) <= 0 || actualNotional < exchangeMinNotional) {
        this.logger.error(
          `Position below exchange minimum: qty=${quantity} ` +
            `notional=${actualNotional.toFixed(2)} (min ${exchangeMinNotional})`,
        );
        return null;
      }

      // 3. Set leverage
      await this.exchange.changeLeverage(symbol, maxLeverage);

      // 4. Enforce minimum SL distance (safety net)
      const slSafetyAtrMult = this.config.get<number>('SL_SAFETY_ATR_MULT', 2);
      const slSafetyMinPct = this.config.get<number>('SL_SAFETY_MIN_PCT', 0.005);
      const minSlDistanceAtr = signal.atr * slSafetyAtrMult;
      const minSlDistancePct = signal.entryPrice * slSafetyMinPct;
      const minSlDistance = Math.max(minSlDistanceAtr, minSlDistancePct);
      const currentSlDistance = Math.abs(signal.entryPrice - signal.stopLoss);

      if (currentSlDistance < minSlDistance) {
        const dirMul = signal.action === 'LONG' ? -1 : 1;
        const oldSl = signal.stopLoss;
        signal.stopLoss = signal.entryPrice + dirMul * minSlDistance;
        const tpMul = signal.action === 'LONG' ? 1 : -1;
        signal.takeProfit =
          signal.entryPrice + tpMul * minSlDistance * 1.5;
        this.logger.warn(
          `SL expanded: ${currentSlDistance.toFixed(0)} → ${minSlDistance.toFixed(0)} ` +
            `(old SL=${oldSl.toFixed(2)}, new SL=${signal.stopLoss.toFixed(2)}, TP=${signal.takeProfit.toFixed(2)})`,
        );
      }

      // 5. Determine sides
      const entrySide: OrderSide =
        signal.action === 'LONG' ? OrderSide.BUY : OrderSide.SELL;
      const closeSide: OrderSide =
        signal.action === 'LONG' ? OrderSide.SELL : OrderSide.BUY;

      // 6. Place LIMIT entry order (maker fee 0.02% vs taker 0.05%)
      let entryClientId = generateClientOrderId(
        'ENTRY',
        signalEntity.id,
        entrySide as 'BUY' | 'SELL',
      );

      const limitPrice = roundToTickSize(signal.entryPrice, tickSize);
      const LIMIT_WAIT_MS = 180_000;
      // ENTRY_MODE (2026-05-24): 'market' fills 100% of signals at current price (taker).
      // Backtest validated PF 1.16 (vs LIMIT 0.60). LIMIT-at-boundary suffered adverse
      // selection — only filled when price BROKE the zone (= bad trades), missing the
      // good rebounds. MARKET captures both. Robust across H1 (PF 1.31) and H2 (PF 1.06).
      // 'limit' = legacy behavior (LIMIT GTC 180s + IOC fallback).
      const entryMode = this.config
        .get<string>('ENTRY_MODE', 'limit')
        .toLowerCase()
        .trim();

      let entryResponse;
      const orderPlacedTime = Date.now();

      if (entryMode === 'market') {
        this.logger.log(
          `Placing ${entrySide} MARKET order: ${quantity} ${symbol} (ENTRY_MODE=market)`,
        );
        try {
          entryResponse = await this.exchange.placeOrder({
            symbol,
            side: entrySide,
            type: OrderType.MARKET,
            quantity,
            clientOrderId: entryClientId,
          });
        } catch (marketErr) {
          this.logger.error(
            `MARKET order placement failed: ${marketErr}. Skipping trade.`,
          );
          return null;
        }
      } else {
      this.logger.log(
        `Placing ${entrySide} LIMIT order: ${quantity} ${symbol} @ ${limitPrice} (zone boundary, wait ${LIMIT_WAIT_MS / 1000}s)`,
      );
      try {
        entryResponse = await this.exchange.placeOrder({
          symbol,
          side: entrySide,
          type: OrderType.LIMIT,
          quantity,
          price: limitPrice,
          timeInForce: TimeInForce.GTC,
          clientOrderId: entryClientId,
        });

        if (entryResponse.status !== OrderStatus.FILLED) {
          this.logger.log(
            `LIMIT order status: ${entryResponse.status}, waiting up to ${LIMIT_WAIT_MS / 1000}s for fill...`,
          );
          await new Promise((r) => setTimeout(r, LIMIT_WAIT_MS));

          // Try to cancel. If cancel succeeds → order wasn't filled → skip trade.
          // If cancel fails → order was already filled during wait → proceed.
          let canceled = false;
          try {
            await this.exchange.cancelOrder(symbol, entryClientId);
            canceled = true;
          } catch {
            // Cancel failed = order was filled during the wait. Continue.
            this.logger.log('LIMIT order filled during wait, proceeding');
          }
          if (canceled) {
            // IOC fallback: place LIMIT with max-slip cap as Immediate-Or-Cancel.
            // If liquidity exists within MAX_SLIP, fill happens immediately (taker).
            // If price moved beyond MAX_SLIP, IOC cancels itself → no uncontrolled slippage.
            // Disabled trades = bot only captures ~10% of signals; this is the main fix
            // for the live-vs-backtest gap identified 2026-05-13.
            const fallbackEnabled =
              this.config.get<string>('IOC_FALLBACK_ENABLED', 'true') === 'true';
            const maxSlipUsd = Number(
              this.config.get<number>('IOC_FALLBACK_MAX_SLIP_USD', 50),
            );

            if (fallbackEnabled && maxSlipUsd > 0) {
              const isLong = signal.action === 'LONG';
              const slipCapPrice = isLong
                ? signal.entryPrice + maxSlipUsd
                : signal.entryPrice - maxSlipUsd;
              const iocPrice = roundToTickSize(slipCapPrice, tickSize);
              // Use 'ENTRY' prefix (the timestamp in the id makes it unique
              // even after the original ENTRY clientId was cancelled).
              const iocClientId = generateClientOrderId(
                'ENTRY',
                signalEntity.id,
                entrySide as 'BUY' | 'SELL',
              );

              this.logger.log(
                `LIMIT not filled. Trying IOC fallback @ ${iocPrice} ` +
                  `(signal entry=${limitPrice}, max slip $${maxSlipUsd})`,
              );

              try {
                const iocResponse = await this.exchange.placeOrder({
                  symbol,
                  side: entrySide,
                  type: OrderType.LIMIT,
                  quantity,
                  price: iocPrice,
                  timeInForce: TimeInForce.IOC,
                  clientOrderId: iocClientId,
                });

                const iocFilled = parseFloat(iocResponse.executedQty || '0');
                const expectedQty = parseFloat(quantity);

                if (
                  iocResponse.status === OrderStatus.FILLED ||
                  iocFilled >= expectedQty * 0.99
                ) {
                  this.logger.log(
                    `IOC fallback FILLED: ${iocFilled} ${symbol} ` +
                      `@ avgPrice ${iocResponse.avgPrice} (cap was ${iocPrice})`,
                  );
                  entryResponse = iocResponse;
                  entryClientId = iocClientId;
                } else {
                  this.logger.warn(
                    `IOC fallback NOT filled (status=${iocResponse.status}, ` +
                      `executed=${iocFilled}/${expectedQty}). ` +
                      `Price drifted beyond $${maxSlipUsd} from zone. Skipping trade.`,
                  );
                  await this.shadowEvaluateFallback(
                    signal,
                    symbol,
                    parseFloat(limitPrice),
                    orderPlacedTime,
                    LIMIT_WAIT_MS,
                  );
                  return null;
                }
              } catch (iocErr) {
                this.logger.error(
                  `IOC fallback placement failed: ${iocErr}. Skipping trade.`,
                );
                await this.shadowEvaluateFallback(
                  signal,
                  symbol,
                  parseFloat(limitPrice),
                  orderPlacedTime,
                  LIMIT_WAIT_MS,
                );
                return null;
              }
            } else {
              // IOC fallback disabled via env — preserve original abort behavior
              this.logger.warn(
                `LIMIT order not filled in ${LIMIT_WAIT_MS / 1000}s at zone boundary ${limitPrice}. ` +
                  `Skipping trade (IOC fallback disabled).`,
              );
              await this.shadowEvaluateFallback(
                signal,
                symbol,
                parseFloat(limitPrice),
                orderPlacedTime,
                LIMIT_WAIT_MS,
              );
              return null;
            }
          }
        }
      } catch (limitErr) {
        this.logger.error(
          `LIMIT order placement failed: ${limitErr}. Skipping trade.`,
        );
        return null;
      }
      } // end else (ENTRY_MODE=limit)

      // Save entry order
      const entryOrder = this.orderRepo.create({
        clientOrderId: entryClientId,
        exchangeOrderId: entryResponse.orderId,
        symbol,
        side: entrySide,
        type: entryResponse.type || OrderType.LIMIT,
        quantity: parseFloat(quantity),
        executedQty: parseFloat(entryResponse.executedQty || '0'),
        avgPrice: parseFloat(entryResponse.avgPrice || '0'),
        status: entryResponse.status,
        purpose: 'ENTRY',
        signalId: signalEntity.id,
      });
      await this.orderRepo.save(entryOrder);

      // 7. Recalculate SL/TP if actual fill price differs significantly
      let actualFillPrice = parseFloat(entryResponse.avgPrice || '0');
      if (actualFillPrice <= 0) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const userTrades = await this.exchange.getUserTrades(symbol, 10);
          const orderFills = userTrades.filter(
            (t) => t.orderId === entryResponse.orderId,
          );
          if (orderFills.length > 0) {
            let totalQty = 0;
            let totalNotional = 0;
            for (const f of orderFills) {
              const fQty = parseFloat(f.qty);
              totalQty += fQty;
              totalNotional += fQty * parseFloat(f.price);
            }
            if (totalQty > 0) {
              actualFillPrice = totalNotional / totalQty;
              this.logger.log(
                `Fetched real fill price from userTrades: ${actualFillPrice.toFixed(2)} (${orderFills.length} fills)`,
              );
            }
          }
        } catch (err) {
          this.logger.warn(`Could not fetch userTrades for fill price: ${err}`);
        }
      }
      if (actualFillPrice <= 0) actualFillPrice = signal.entryPrice;

      const fillDiff = Math.abs(actualFillPrice - signal.entryPrice);
      if (fillDiff > 30) {
        const slDistance = Math.abs(signal.entryPrice - signal.stopLoss);
        const isLong = signal.action === 'LONG';
        const originalEntry = signal.entryPrice;
        signal.stopLoss = isLong
          ? actualFillPrice - slDistance
          : actualFillPrice + slDistance;
        signal.takeProfit = isLong
          ? actualFillPrice + slDistance * 1.5
          : actualFillPrice - slDistance * 1.5;
        signal.entryPrice = actualFillPrice;
        this.logger.warn(
          `Recalculated SL/TP for fill at ${actualFillPrice.toFixed(2)} (signal was ${originalEntry.toFixed(2)}, diff=$${fillDiff.toFixed(2)}) → SL=${signal.stopLoss.toFixed(2)} TP=${signal.takeProfit.toFixed(2)} (R:R 1.5 preserved)`,
        );
      }

      // 8. Place STOP_MARKET (stop loss) — exchange-agnostic conditional
      const slPrice = roundToTickSize(signal.stopLoss, tickSize);
      const slClientId = generateClientOrderId(
        'SL',
        signalEntity.id,
        closeSide as 'BUY' | 'SELL',
      );

      this.logger.log(
        `Placing STOP_MARKET (conditional): ${closeSide} ${quantity} ${symbol} @ ${slPrice}`,
      );

      const slResponse = await this.exchange.placeStopLoss({
        symbol,
        side: closeSide,
        triggerPrice: slPrice,
        quantity,
        reduceOnly: true,
        clientOrderId: slClientId,
      });

      const slOrder = this.orderRepo.create({
        clientOrderId: slClientId,
        exchangeOrderId: slResponse.conditionalId,
        symbol,
        side: closeSide,
        type: OrderType.STOP_MARKET,
        stopPrice: parseFloat(slPrice),
        quantity: parseFloat(quantity),
        status: slResponse.status,
        purpose: 'STOP_LOSS',
        signalId: signalEntity.id,
      });
      await this.orderRepo.save(slOrder);

      // 9. Place TAKE_PROFIT_MARKET — exchange-agnostic conditional
      const tpPrice = roundToTickSize(signal.takeProfit, tickSize);
      const tpClientId = generateClientOrderId(
        'TP',
        signalEntity.id,
        closeSide as 'BUY' | 'SELL',
      );

      this.logger.log(
        `Placing TAKE_PROFIT_MARKET (conditional): ${closeSide} ${quantity} ${symbol} @ ${tpPrice}`,
      );

      let tpOrder: any = null;
      try {
        const tpResponse = await this.exchange.placeTakeProfit({
          symbol,
          side: closeSide,
          triggerPrice: tpPrice,
          quantity,
          reduceOnly: true,
          clientOrderId: tpClientId,
        });

        tpOrder = this.orderRepo.create({
          clientOrderId: tpClientId,
          exchangeOrderId: tpResponse.conditionalId,
          symbol,
          side: closeSide,
          type: OrderType.TAKE_PROFIT_MARKET,
          stopPrice: parseFloat(tpPrice),
          quantity: parseFloat(quantity),
          status: tpResponse.status,
          purpose: 'TAKE_PROFIT',
          signalId: signalEntity.id,
        });
        await this.orderRepo.save(tpOrder);
      } catch (tpErr: any) {
        this.logger.warn(
          `TP placement failed (${tpErr?.response?.data?.msg || tpErr?.message}). Trade will rely on trailing SL and software TP.`,
        );
      }

      // 10. Create Trade entity — ALWAYS, even if TP failed
      const parsedAvg = parseFloat(entryResponse.avgPrice || '0');
      const entryPrice = parsedAvg > 0 ? parsedAvg : signal.entryPrice;

      const trade = this.tradeRepo.create({
        symbol,
        direction: signal.action,
        entryPrice,
        quantity: parseFloat(quantity),
        stopLoss: parseFloat(slPrice),
        takeProfit: parseFloat(tpPrice),
        status: 'OPEN',
        signalId: signalEntity.id,
      });
      const savedTrade = await this.tradeRepo.save(trade);

      // Link orders to trade
      entryOrder.tradeId = savedTrade.id;
      slOrder.tradeId = savedTrade.id;
      const ordersToLink = [entryOrder, slOrder];
      if (tpOrder) {
        tpOrder.tradeId = savedTrade.id;
        ordersToLink.push(tpOrder);
      }
      await this.orderRepo.save(ordersToLink);

      // 11. Record trade execution (per-symbol cooldown — 2026-05-24 multi-symbol)
      this.riskManager.recordTradeExecuted(symbol);

      this.logger.log(
        `Trade opened: ${savedTrade.id} ${signal.action} ${quantity} ${symbol} ` +
          `entry=${savedTrade.entryPrice} SL=${slPrice} TP=${tpPrice}`,
      );

      return savedTrade;
    } catch (error: any) {
      const msg =
        error?.response?.data?.msg ??
        error?.response?.data ??
        error?.message ??
        error;
      this.logger.error(
        `Execution failed for ${symbol}: ${JSON.stringify(msg)}`,
      );
      try {
        await this.exchange.cancelAllOpenOrders(symbol);
      } catch {
        // Best-effort cleanup
      }
      return null;
    }
  }

  async handleOrderUpdate(update: OrderUpdate): Promise<void> {
    const clientOrderId = update.clientOrderId;

    const order = await this.orderRepo.findOne({
      where: { clientOrderId },
    });

    if (!order) {
      this.logger.debug(`Order not tracked: ${clientOrderId}`);
      return;
    }

    order.status = update.status;
    order.executedQty = parseFloat(update.cumFilledQty);
    order.avgPrice = parseFloat(update.avgPrice);
    await this.orderRepo.save(order);

    this.logger.log(
      `Order update: ${clientOrderId} status=${update.status} exec=${update.cumFilledQty} avg=${update.avgPrice}`,
    );

    // Link tradeId for trailing SL orders that lost their tradeId reference
    if (!order.tradeId && clientOrderId.startsWith('FAB_TSL_')) {
      const parts = clientOrderId.split('_');
      if (parts.length >= 3) {
        const partialTradeId = parts[2];
        const openTrade = await this.tradeRepo.findOne({
          where: { status: 'OPEN' },
          order: { openedAt: 'DESC' },
        });
        if (openTrade && openTrade.id.startsWith(partialTradeId)) {
          order.tradeId = openTrade.id;
          await this.orderRepo.save(order);
          this.logger.log(`Linked trailing SL order ${clientOrderId} to trade ${openTrade.id}`);
        }
      }
    }

    // Sync trade entry price when ENTRY order fills with real avg price
    if (
      update.status === OrderStatus.FILLED &&
      order.purpose === 'ENTRY' &&
      order.avgPrice > 0 &&
      order.tradeId
    ) {
      const trade = await this.tradeRepo.findOne({
        where: { id: order.tradeId },
      });
      if (trade && Math.abs(Number(trade.entryPrice) - order.avgPrice) > 0.01) {
        this.logger.log(
          `Entry price synced: ${order.avgPrice} (was ${trade.entryPrice})`,
        );
        trade.entryPrice = order.avgPrice;
        await this.tradeRepo.save(trade);
      }
    }

    // Check if this is a SL or TP fill
    if (
      update.status === OrderStatus.FILLED &&
      (order.purpose === 'STOP_LOSS' || order.purpose === 'TAKE_PROFIT')
    ) {
      await this.handleBracketFill(order, update);
    }
  }

  async handleConditionalUpdate(update: ConditionalUpdate): Promise<void> {
    const clientOrderId = update.clientOrderId;

    let order = await this.orderRepo.findOne({
      where: { clientOrderId },
    });

    // Fallback: lookup by exchangeOrderId if clientOrderId lookup fails
    if (!order && update.conditionalId) {
      order = await this.orderRepo.findOne({
        where: { exchangeOrderId: update.conditionalId },
      });
      if (order) {
        this.logger.log(`Conditional order found by id fallback: ${update.conditionalId} (cid=${clientOrderId})`);
      }
    }

    if (!order) {
      this.logger.debug(`Conditional order not tracked: ${clientOrderId} (id=${update.conditionalId})`);
      return;
    }

    this.logger.log(
      `Conditional update: ${clientOrderId} status=${update.status} type=${update.orderType} symbol=${update.symbol}`,
    );

    if (update.status === ConditionalStatus.FINISHED) {
      order.status = OrderStatus.FILLED;
      order.executedQty = parseFloat(update.executedQty ?? '0') || order.quantity;
      order.avgPrice = parseFloat(update.avgPrice ?? '0') || order.stopPrice || 0;
      await this.orderRepo.save(order);

      if (order.purpose === 'STOP_LOSS' || order.purpose === 'TAKE_PROFIT') {
        await this.handleConditionalBracketFill(order, update);
      }
    } else if (
      update.status === ConditionalStatus.CANCELED ||
      update.status === ConditionalStatus.EXPIRED ||
      update.status === ConditionalStatus.REJECTED
    ) {
      order.status =
        update.status === ConditionalStatus.REJECTED
          ? OrderStatus.REJECTED
          : OrderStatus.CANCELED;
      await this.orderRepo.save(order);
      if (update.failureReason) {
        this.logger.warn(`Conditional ${clientOrderId} ${update.status}: ${update.failureReason}`);
      }
    }
  }

  private async handleConditionalBracketFill(
    filledOrder: Order,
    update: ConditionalUpdate,
  ): Promise<void> {
    if (!filledOrder.tradeId) return;

    if (this.closingTrades.has(filledOrder.tradeId)) {
      this.logger.debug(`Trade ${filledOrder.tradeId} already being closed, skipping conditional handler`);
      return;
    }
    this.closingTrades.add(filledOrder.tradeId);

    try {
      const trade = await this.tradeRepo.findOne({
        where: { id: filledOrder.tradeId },
      });

      if (!trade || trade.status !== 'OPEN') return;

      const oppositeType =
        filledOrder.purpose === 'STOP_LOSS' ? 'TAKE_PROFIT' : 'STOP_LOSS';

      const oppositeOrder = await this.orderRepo.findOne({
        where: {
          tradeId: trade.id,
          purpose: oppositeType,
        },
      });

      if (oppositeOrder && oppositeOrder.status === 'NEW') {
        try {
          await this.exchange.cancelConditional(
            trade.symbol,
            oppositeOrder.exchangeOrderId,
          );
          oppositeOrder.status = 'CANCELED';
          await this.orderRepo.save(oppositeOrder);
          this.logger.log(
            `Canceled opposite conditional: ${oppositeOrder.clientOrderId}`,
          );
        } catch (err) {
          this.logger.warn('Failed to cancel opposite bracket conditional', err);
        }
      }

      const exitPrice = parseFloat(update.avgPrice ?? '0') || filledOrder.stopPrice || 0;
      const entryPrice = Number(trade.entryPrice);
      const qty = Number(trade.quantity);
      const direction = trade.direction === 'LONG' ? 1 : -1;
      const pricePnl = (exitPrice - entryPrice) * qty * direction;

      let totalCommission = qty * entryPrice * 0.0002 + qty * exitPrice * 0.0005;
      let netPnl = pricePnl - totalCommission;

      await new Promise((r) => setTimeout(r, 1000));

      try {
        const { startTime, endTime } = this.safeIncomeWindow(trade.openedAt);
        const incomeEntries = await this.exchange.getIncome({
          symbol: trade.symbol,
          startTime,
          endTime,
          limit: 100,
        });
        let grossPnl = 0;
        let commissions = 0;
        let funding = 0;
        for (const entry of incomeEntries) {
          const amount = parseFloat(entry.income);
          if (entry.incomeType === IncomeType.REALIZED_PNL) grossPnl += amount;
          else if (entry.incomeType === IncomeType.COMMISSION) commissions += amount;
          else if (entry.incomeType === IncomeType.FUNDING_FEE) funding += amount;
        }
        if (grossPnl !== 0 || commissions !== 0) {
          totalCommission = Math.abs(commissions);
          netPnl = grossPnl + commissions + funding;
          this.logger.log(
            `Income breakdown: gross=${grossPnl.toFixed(4)} comm=${commissions.toFixed(4)} fund=${funding.toFixed(4)} net=${netPnl.toFixed(4)}`,
          );
        } else {
          this.logger.warn(
            `Income API returned no relevant entries; using estimated commission (PnL=${netPnl.toFixed(4)} comm=${totalCommission.toFixed(4)})`,
          );
        }
      } catch (err: any) {
        const msg = err?.response?.data?.msg || err?.response?.data || err?.message || err;
        this.logger.warn(
          `Income API failed: ${msg}; using estimated commission (PnL=${netPnl.toFixed(4)} comm=${totalCommission.toFixed(4)})`,
        );
      }

      trade.exitPrice = exitPrice;
      trade.realizedPnl = netPnl;
      trade.commission = totalCommission;
      trade.status =
        filledOrder.purpose === 'STOP_LOSS' ? 'CLOSED_SL' : 'CLOSED_TP';
      trade.closedAt = new Date();
      await this.tradeRepo.save(trade);

      await this.updateDailyPnl(netPnl);

      this.logger.log(
        `Trade closed (conditional): ${trade.id} ${trade.status} PnL=${netPnl.toFixed(4)} (price=${pricePnl.toFixed(4)}, comm=${totalCommission.toFixed(4)})`,
      );
      this.fcmService.notifyTradeClosed(
        trade.direction,
        trade.symbol,
        trade.status,
        netPnl,
      ).catch(() => {});
    } finally {
      this.closingTrades.delete(filledOrder.tradeId);
    }
  }

  private async handleBracketFill(
    filledOrder: Order,
    update: OrderUpdate,
  ): Promise<void> {
    if (!filledOrder.tradeId) {
      this.logger.warn(`handleBracketFill: order ${filledOrder.clientOrderId} has no tradeId`);
      return;
    }

    if (this.closingTrades.has(filledOrder.tradeId)) {
      this.logger.debug(`Trade ${filledOrder.tradeId} already being closed, skipping order handler`);
      return;
    }
    this.closingTrades.add(filledOrder.tradeId);

    try {
      const trade = await this.tradeRepo.findOne({
        where: { id: filledOrder.tradeId },
      });

      if (!trade || trade.status !== 'OPEN') {
        this.logger.warn(
          `handleBracketFill: trade ${filledOrder.tradeId} not found or not OPEN (status=${trade?.status})`,
        );
        return;
      }

      const oppositeType =
        filledOrder.purpose === 'STOP_LOSS' ? 'TAKE_PROFIT' : 'STOP_LOSS';

      const oppositeOrder = await this.orderRepo.findOne({
        where: {
          tradeId: trade.id,
          purpose: oppositeType,
          status: 'NEW',
        },
      });

      if (oppositeOrder) {
        try {
          await this.exchange.cancelConditional(
            trade.symbol,
            oppositeOrder.exchangeOrderId,
          );
          oppositeOrder.status = 'CANCELED';
          await this.orderRepo.save(oppositeOrder);
          this.logger.log(
            `Canceled opposite conditional: ${oppositeOrder.clientOrderId} (id=${oppositeOrder.exchangeOrderId})`,
          );
        } catch (err) {
          this.logger.warn('Failed to cancel opposite bracket order', err);
        }
      }

      const exitPrice = parseFloat(update.avgPrice);
      const wsExitCommission = Math.abs(parseFloat(update.commission || '0'));
      const entryNotional = Number(trade.entryPrice) * Number(trade.quantity);
      const estimatedEntryCommission = entryNotional * 0.0002;
      let totalCommission = wsExitCommission + estimatedEntryCommission;
      let netPnl = parseFloat(update.realizedPnl) - totalCommission;

      await new Promise((r) => setTimeout(r, 1000));

      try {
        const { startTime, endTime } = this.safeIncomeWindow(trade.openedAt);
        const incomeEntries = await this.exchange.getIncome({
          symbol: trade.symbol,
          startTime,
          endTime,
          limit: 100,
        });
        let grossPnl = 0;
        let commissions = 0;
        let funding = 0;
        for (const entry of incomeEntries) {
          const amount = parseFloat(entry.income);
          if (entry.incomeType === IncomeType.REALIZED_PNL) grossPnl += amount;
          else if (entry.incomeType === IncomeType.COMMISSION) commissions += amount;
          else if (entry.incomeType === IncomeType.FUNDING_FEE) funding += amount;
        }
        if (grossPnl !== 0 || commissions !== 0) {
          totalCommission = Math.abs(commissions);
          netPnl = grossPnl + commissions + funding;
          this.logger.log(
            `Income breakdown: gross=${grossPnl.toFixed(4)} comm=${commissions.toFixed(4)} fund=${funding.toFixed(4)} net=${netPnl.toFixed(4)}`,
          );
        } else {
          this.logger.warn(
            `Income API returned no relevant entries; using WS fallback (PnL=${netPnl.toFixed(4)} comm=${totalCommission.toFixed(4)})`,
          );
        }
      } catch (err: any) {
        const msg = err?.response?.data?.msg || err?.response?.data || err?.message || err;
        this.logger.warn(
          `Income API failed: ${msg}; using WS fallback (PnL=${netPnl.toFixed(4)} comm=${totalCommission.toFixed(4)})`,
        );
      }

      trade.exitPrice = exitPrice;
      trade.realizedPnl = netPnl;
      trade.commission = totalCommission;
      trade.status =
        filledOrder.purpose === 'STOP_LOSS' ? 'CLOSED_SL' : 'CLOSED_TP';
      trade.closedAt = new Date();
      await this.tradeRepo.save(trade);

      await this.updateDailyPnl(netPnl);

      this.logger.log(
        `Trade closed: ${trade.id} ${trade.status} PnL=${netPnl.toFixed(4)} (comm=${totalCommission.toFixed(4)})`,
      );
    } finally {
      this.closingTrades.delete(filledOrder.tradeId);
    }
  }

  private safeIncomeWindow(openedAt: Date | string | null | undefined): {
    startTime: number;
    endTime: number;
  } {
    const now = Date.now();
    const endTime = now + 60_000;

    let startTime = now - 24 * 60 * 60 * 1000;
    if (openedAt) {
      const parsed = new Date(openedAt).getTime();
      if (Number.isFinite(parsed) && parsed > 0 && parsed < now) {
        startTime = parsed - 120_000;
      }
    }
    if (startTime >= endTime - 1000) startTime = endTime - 60_000;
    return { startTime, endTime };
  }

  private async updateDailyPnl(pnl: number): Promise<void> {
    const today = new Date().toISOString().split('T')[0];

    let daily = await this.dailyPnlRepo.findOne({
      where: { date: today },
    });

    if (!daily) {
      daily = this.dailyPnlRepo.create({
        date: today,
        realizedPnl: 0,
        tradesCount: 0,
        winsCount: 0,
        lossesCount: 0,
      });
    }

    daily.realizedPnl = Number(daily.realizedPnl) + pnl;
    daily.tradesCount++;
    if (pnl > 0) daily.winsCount++;
    else if (pnl < 0) daily.lossesCount++;

    await this.dailyPnlRepo.save(daily);
  }

  async reconcilePositions(): Promise<void> {
    if (this.isReconciling) {
      this.logger.debug('reconcilePositions already running, skipping');
      return;
    }
    this.isReconciling = true;

    try {
      const openTrades = await this.tradeRepo.find({
        where: { status: 'OPEN' },
        relations: ['orders'],
      });

      if (openTrades.length === 0) return;

      for (const trade of openTrades) {
        try {
          const positions = await this.exchange.getPositions(trade.symbol);
          const activePos = positions.find(
            (p) => parseFloat(p.positionAmt) !== 0,
          );

          if (activePos) {
            const exchangeEntry = parseFloat(activePos.entryPrice);
            if (Number(trade.entryPrice) === 0 && exchangeEntry > 0) {
              trade.entryPrice = exchangeEntry;
              await this.tradeRepo.save(trade);
              this.logger.log(
                `Synced entry price for trade ${trade.id}: ${exchangeEntry}`,
              );
            }

            const entryOrder = trade.orders?.find(
              (o) => o.purpose === 'ENTRY' && o.status === 'NEW',
            );
            if (entryOrder && exchangeEntry > 0) {
              entryOrder.status = OrderStatus.FILLED;
              entryOrder.executedQty = parseFloat(activePos.positionAmt);
              entryOrder.avgPrice = exchangeEntry;
              await this.orderRepo.save(entryOrder);
            }

            const markPrice = parseFloat(activePos.markPrice);
            const sl = Number(trade.stopLoss);
            const tp = Number(trade.takeProfit);
            const isLong = trade.direction === 'LONG';

            const slHit = sl > 0 && (isLong ? markPrice <= sl : markPrice >= sl);
            const tpHit = tp > 0 && (isLong ? markPrice >= tp : markPrice <= tp);

            if (slHit || tpHit) {
              const freshTrade = await this.tradeRepo.findOne({
                where: { id: trade.id },
              });
              if (!freshTrade || freshTrade.status !== 'OPEN') {
                this.logger.log(
                  `Trade ${trade.id} already closed by WS handler, skipping software SL/TP`,
                );
              } else {
                const closeSide: OrderSide = isLong
                  ? OrderSide.SELL
                  : OrderSide.BUY;
                const absQty = Math.abs(
                  parseFloat(activePos.positionAmt),
                ).toString();

                this.logger.warn(
                  `Software ${slHit ? 'SL' : 'TP'} triggered for trade ${trade.id} ` +
                    `at mark ${markPrice} (SL=${sl}, TP=${tp})`,
                );

                await this.exchange.placeOrder({
                  symbol: trade.symbol,
                  side: closeSide,
                  type: OrderType.MARKET,
                  quantity: absQty,
                  reduceOnly: true,
                });

                const entryPrice = Number(trade.entryPrice);
                const qty = Number(trade.quantity);
                const direction = isLong ? 1 : -1;
                const estimatedPnl =
                  (markPrice - entryPrice) * qty * direction;

                trade.exitPrice = markPrice;
                trade.realizedPnl = estimatedPnl;
                trade.status = slHit ? 'CLOSED_SL' : 'CLOSED_TP';
                trade.closedAt = new Date();

                for (const order of trade.orders || []) {
                  if (
                    order.status === 'NEW' &&
                    (order.purpose === 'STOP_LOSS' ||
                      order.purpose === 'TAKE_PROFIT')
                  ) {
                    try {
                      await this.exchange.cancelConditional(
                        trade.symbol,
                        order.exchangeOrderId,
                      );
                    } catch {
                      // best-effort
                    }
                    order.status = 'CANCELED';
                    await this.orderRepo.save(order);
                  }
                }

                await this.tradeRepo.save(trade);
                await this.updateDailyPnl(estimatedPnl);

                this.logger.log(
                  `Trade closed via software ${slHit ? 'SL' : 'TP'}: ${trade.id} ` +
                    `PnL=${estimatedPnl.toFixed(4)}`,
                );
              }
            }

            // === TRAILING SL ===
            let entryPrice = Number(trade.entryPrice);
            if (entryPrice > 0) {
              const entryOrder = await this.orderRepo.findOne({
                where: { tradeId: trade.id, purpose: 'ENTRY' },
                order: { executedQty: 'DESC' },
              });
              const orderAvgPrice = Number(entryOrder?.avgPrice ?? 0);
              if (entryOrder && orderAvgPrice > 0 && Math.abs(orderAvgPrice - entryPrice) > 1) {
                this.logger.log(
                  `Entry price corrected: ${entryPrice.toFixed(1)} → ${orderAvgPrice.toFixed(1)} (real fill)`,
                );
                entryPrice = orderAvgPrice;
                trade.entryPrice = entryPrice;
                await this.tradeRepo.save(trade);
              }
            }

            // POST-ENTRY MONITOR
            if (entryPrice > 0 && !slHit && !tpHit) {
              const minutesSinceOpen = (Date.now() - new Date(trade.openedAt).getTime()) / 60_000;
              if (minutesSinceOpen <= 15) {
                const instantPnl = isLong
                  ? (markPrice - entryPrice) * Number(trade.quantity)
                  : (entryPrice - markPrice) * Number(trade.quantity);
                const excursion = this.tradeExcursions.get(trade.id) ?? { mfe: 0, mae: 0 };
                if (instantPnl > excursion.mfe) excursion.mfe = instantPnl;
                if (instantPnl < excursion.mae) excursion.mae = instantPnl;
                this.tradeExcursions.set(trade.id, excursion);

                const slDist = Math.abs(markPrice - Number(trade.stopLoss));
                const tpDist = Math.abs(markPrice - Number(trade.takeProfit));
                this.logger.log(
                  `POST-ENTRY MONITOR ${trade.id.substring(0, 8)} t=${minutesSinceOpen.toFixed(1)}min ` +
                    `price=${markPrice.toFixed(1)} entry=${entryPrice.toFixed(1)} ` +
                    `PnL=${instantPnl >= 0 ? '+' : ''}$${instantPnl.toFixed(4)} ` +
                    `MFE=+$${excursion.mfe.toFixed(4)} MAE=-$${Math.abs(excursion.mae).toFixed(4)} ` +
                    `SL_dist=$${slDist.toFixed(1)} TP_dist=$${tpDist.toFixed(1)}`,
                );
              } else if (this.tradeExcursions.has(trade.id)) {
                this.tradeExcursions.delete(trade.id);
              }
            }

            // TRAILING SL
            // TRAILING_ENABLED (2026-05-24): set 'false' to disable trailing entirely.
            // Backtest proved the $50 trailing destroys the edge (PF 0.03 vs 1.16 without).
            // With ENTRY_MODE=market, trailing must be OFF to match the validated config.
            const trailingEnabled =
              this.config.get<string>('TRAILING_ENABLED', 'true').toLowerCase().trim() !==
              'false';
            if (trailingEnabled && entryPrice > 0 && !slHit && !tpHit) {
              const priceDiff = isLong
                ? markPrice - entryPrice
                : entryPrice - markPrice;
              const trailFixed = Number(this.config.get('TRAIL_FIXED', 50));
              const trailActivation = Number(this.config.get('TRAIL_ACTIVATION', trailFixed));

              let newSl: number | null = null;

              if (priceDiff >= trailActivation) {
                newSl = isLong
                  ? markPrice - trailFixed
                  : markPrice + trailFixed;
              }

              if (newSl !== null) {
                const currentSl = Number(trade.stopLoss);
                const slDiff = Math.abs(newSl - currentSl);
                const isBetter = isLong
                  ? newSl > currentSl
                  : newSl < currentSl;
                const isSignificant = slDiff > 5;

                if (isBetter && isSignificant) {
                  const existingSlOrders = await this.orderRepo.find({
                    where: {
                      tradeId: trade.id,
                      purpose: 'STOP_LOSS',
                      status: 'NEW',
                    },
                  });
                  for (const slOrder of existingSlOrders) {
                    try {
                      await this.exchange.cancelConditional(
                        trade.symbol,
                        slOrder.exchangeOrderId,
                      );
                      slOrder.status = 'CANCELED';
                      await this.orderRepo.save(slOrder);
                    } catch {
                      slOrder.status = 'CANCELED';
                      await this.orderRepo.save(slOrder);
                    }
                  }

                  const tickSize = this.exchangeInfo.getTickSize(trade.symbol);
                  const closeSide: OrderSide = isLong
                    ? OrderSide.SELL
                    : OrderSide.BUY;
                  const roundedSl = roundToTickSize(newSl, tickSize);

                  try {
                    const tslClientId = `FAB_TSL_${trade.id.substring(0, 8)}_${Date.now().toString(36)}`;
                    const newSlResponse = await this.exchange.placeStopLoss({
                      symbol: trade.symbol,
                      side: closeSide,
                      triggerPrice: roundedSl,
                      quantity: Math.abs(
                        parseFloat(activePos.positionAmt),
                      ).toString(),
                      reduceOnly: true,
                      clientOrderId: tslClientId,
                    });

                    const newSlOrder = this.orderRepo.create({
                      clientOrderId: tslClientId,
                      exchangeOrderId: newSlResponse.conditionalId,
                      symbol: trade.symbol,
                      side: closeSide,
                      type: OrderType.STOP_MARKET,
                      quantity: Math.abs(
                        parseFloat(activePos.positionAmt),
                      ),
                      status: 'NEW',
                      purpose: 'STOP_LOSS',
                      stopPrice: parseFloat(roundedSl),
                      tradeId: trade.id,
                    });
                    const savedSlOrder = await this.orderRepo.save(newSlOrder);
                    if (!savedSlOrder.tradeId) {
                      savedSlOrder.tradeId = trade.id;
                      await this.orderRepo.save(savedSlOrder);
                      this.logger.warn(`TSL order tradeId re-saved for ${tslClientId}`);
                    }

                    trade.stopLoss = parseFloat(roundedSl);
                    await this.tradeRepo.save(trade);

                    this.logger.log(
                      `Trailing SL moved for ${trade.id}: ${currentSl.toFixed(2)} → ${roundedSl} ` +
                        `(priceDiff=$${priceDiff.toFixed(2)}, activation=$${trailActivation}, trailFixed=$${trailFixed})`,
                    );
                  } catch (err) {
                    this.logger.error(
                      `Failed to place trailing SL for ${trade.id}`,
                      err,
                    );
                  }
                }
              }
            }
          } else {
            const freshTrade = await this.tradeRepo.findOne({
              where: { id: trade.id },
            });
            if (!freshTrade || freshTrade.status !== 'OPEN') {
              this.logger.log(
                `Trade ${trade.id} already closed by WS handler, skipping reconcile`,
              );
              continue;
            }

            this.logger.warn(
              `Trade ${trade.id} marked OPEN but no position found on exchange. Closing.`,
            );

            let exitPrice: number | null = null;
            let realizedPnl = 0;
            let commission = 0;
            // Bybit source-of-truth tracking (2026-05-20) — NO modificar trade.realizedPnl
            // por compat, solo poblar columnas nuevas con valores Bybit reales.
            let bybitGrossEntry = 0; // gross PnL from entry fills (typically 0 for entries)
            let bybitGrossExit = 0;  // gross PnL from exit fills (the real one)
            let bybitFeesAcc = 0;    // sum of all fees (entry + exit), as positive

            try {
              const fills = await this.exchange.getUserTrades(trade.symbol);
              const closeSide: OrderSide =
                trade.direction === 'LONG' ? OrderSide.SELL : OrderSide.BUY;
              const entrySide: OrderSide =
                trade.direction === 'LONG' ? OrderSide.BUY : OrderSide.SELL;
              const tradeOpenTime = new Date(trade.openedAt).getTime();

              const exitFills = fills.filter(
                (f) => f.side === closeSide && f.time > tradeOpenTime,
              );

              // Also capture ENTRY fills for Bybit-sourced fees tracking
              const entryFills = fills.filter(
                (f) => f.side === entrySide &&
                  f.time >= tradeOpenTime - 60_000 && // entry fills happen within 1min of openedAt
                  f.time <= tradeOpenTime + 60_000,
              );

              if (exitFills.length > 0) {
                let totalQty = 0;
                let totalNotional = 0;
                for (const f of exitFills) {
                  const fQty = parseFloat(f.qty);
                  const fPrice = parseFloat(f.price);
                  totalQty += fQty;
                  totalNotional += fQty * fPrice;
                  realizedPnl += parseFloat(f.realizedPnl);
                  commission += parseFloat(f.commission);
                  // Bybit truth: accumulate gross and fees separately
                  bybitGrossExit += parseFloat(f.realizedPnl);
                  bybitFeesAcc += Math.abs(parseFloat(f.commission));
                }
                exitPrice = totalQty > 0 ? totalNotional / totalQty : null;
                this.logger.log(
                  `Found ${exitFills.length} exit fills for trade ${trade.id}: ` +
                    `exitPrice=${exitPrice?.toFixed(2)}, pnl=${realizedPnl.toFixed(4)}`,
                );
              }

              // Add entry fees to Bybit source-of-truth fees (entry has no realizedPnl)
              for (const f of entryFills) {
                bybitGrossEntry += parseFloat(f.realizedPnl || '0');
                bybitFeesAcc += Math.abs(parseFloat(f.commission));
              }
            } catch (err) {
              this.logger.warn(
                `Could not fetch user trades for ${trade.id}`,
                err,
              );
            }

            if (exitPrice === null && realizedPnl === 0) {
              await new Promise((r) => setTimeout(r, 2000));
              try {
                const { startTime, endTime } = this.safeIncomeWindow(trade.openedAt);
                const incomeEntries = await this.exchange.getIncome({
                  symbol: trade.symbol,
                  startTime,
                  endTime,
                  limit: 100,
                });
                let grossPnl = 0;
                let commissions = 0;
                let funding = 0;
                for (const entry of incomeEntries) {
                  const amount = parseFloat(entry.income);
                  if (entry.incomeType === IncomeType.REALIZED_PNL) grossPnl += amount;
                  else if (entry.incomeType === IncomeType.COMMISSION) commissions += amount;
                  else if (entry.incomeType === IncomeType.FUNDING_FEE) funding += amount;
                }
                if (grossPnl !== 0 || commissions !== 0) {
                  realizedPnl = grossPnl + commissions + funding;
                  commission = Math.abs(commissions);
                  this.logger.log(
                    `Reconcile income fallback for ${trade.id}: gross=${grossPnl.toFixed(4)} ` +
                      `comm=${commissions.toFixed(4)} fund=${funding.toFixed(4)} net=${realizedPnl.toFixed(4)}`,
                  );
                }
              } catch (incErr) {
                this.logger.warn(`Failed to fetch income for reconcile of ${trade.id}`, incErr);
              }

              if (exitPrice === null && realizedPnl === 0) {
                const entryPrice = Number(trade.entryPrice);
                const qty = Number(trade.quantity);
                if (entryPrice > 0 && qty > 0) {
                  this.logger.warn(
                    `No exit fills found for trade ${trade.id}. Entry=${entryPrice}, Qty=${qty}. ` +
                      `Cannot determine exit price.`,
                  );
                }
              }
            }

            let closedStatus = 'CLOSED_MANUAL';
            if (exitPrice && trade.stopLoss && trade.takeProfit) {
              const slDist = Math.abs(
                exitPrice - Number(trade.stopLoss),
              );
              const tpDist = Math.abs(
                exitPrice - Number(trade.takeProfit),
              );
              if (slDist < tpDist && slDist / exitPrice < 0.003) {
                closedStatus = 'CLOSED_SL';
              } else if (tpDist < slDist && tpDist / exitPrice < 0.003) {
                closedStatus = 'CLOSED_TP';
              }
            }

            if (exitPrice) trade.exitPrice = exitPrice;
            if (realizedPnl !== 0) trade.realizedPnl = realizedPnl;
            if (commission !== 0) trade.commission = commission;
            trade.status = closedStatus;
            trade.closedAt = new Date();

            // Bybit source-of-truth PnL (2026-05-20) — populate new columns.
            // bybitNetPnl = gross - fees + funding. Funding usually 0 for short trades.
            // pnlDiffFromDb signals when bot's realizedPnl differs from Bybit truth.
            const bybitGross = bybitGrossEntry + bybitGrossExit;
            if (bybitFeesAcc > 0 || bybitGross !== 0) {
              const bybitFunding = 0; // TODO: extract from income API if needed
              const bybitNet = bybitGross - bybitFeesAcc + bybitFunding;
              trade.bybitRealizedPnl = bybitGross;
              trade.bybitFees = bybitFeesAcc;
              trade.bybitFunding = bybitFunding;
              trade.bybitNetPnl = bybitNet;
              trade.pnlSource = 'BYBIT_FILLS';
              trade.pnlDiffFromDb = bybitNet - (realizedPnl !== 0 ? realizedPnl : 0);
              trade.pnlReconciledAt = new Date();
              if (Math.abs(trade.pnlDiffFromDb) > 0.05) {
                this.logger.warn(
                  `🚨 PnL mismatch for trade ${trade.id}: ` +
                    `DB says ${realizedPnl.toFixed(4)}, ` +
                    `Bybit-truth net says ${bybitNet.toFixed(4)} ` +
                    `(diff ${trade.pnlDiffFromDb.toFixed(4)}). ` +
                    `Use bybitNetPnl as source of truth.`,
                );
              } else {
                this.logger.log(
                  `Bybit PnL reconciled for trade ${trade.id}: ` +
                    `gross=${bybitGross.toFixed(4)} fees=${bybitFeesAcc.toFixed(4)} ` +
                    `net=${bybitNet.toFixed(4)} (DB says ${realizedPnl.toFixed(4)})`,
                );
              }
            }

            for (const order of trade.orders || []) {
              if (
                order.status === 'NEW' &&
                (order.purpose === 'STOP_LOSS' || order.purpose === 'TAKE_PROFIT')
              ) {
                try {
                  await this.exchange.cancelConditional(
                    trade.symbol,
                    order.exchangeOrderId,
                  );
                  order.status = 'CANCELED';
                  await this.orderRepo.save(order);
                } catch {
                  order.status = 'CANCELED';
                  await this.orderRepo.save(order);
                }
              }
            }

            await this.tradeRepo.save(trade);

            if (realizedPnl !== 0) {
              await this.updateDailyPnl(realizedPnl);
            }

            this.logger.log(
              `Trade reconciled: ${trade.id} ${closedStatus} ` +
                `exit=${exitPrice?.toFixed(2) ?? 'unknown'} PnL=${realizedPnl.toFixed(4)}`,
            );
          }
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          const errStack = err?.stack || 'no stack';
          const errData = err?.response?.data ? JSON.stringify(err.response.data) : '';
          this.logger.error(
            `Reconciliation failed for trade ${trade.id}: ${errMsg}${errData ? ' | exchange=' + errData : ''}\nSTACK: ${errStack}`,
          );
        }
      }
    } finally {
      this.isReconciling = false;
    }
  }

  async closeAllPositions(symbol: string): Promise<void> {
    this.logger.warn(`CLOSING ALL POSITIONS for ${symbol}`);

    try {
      await this.exchange.cancelAllOpenOrders(symbol);
    } catch (err) {
      this.logger.error('Failed to cancel open orders', err);
    }
    try {
      await this.exchange.cancelAllConditionals(symbol);
    } catch (err) {
      this.logger.error('Failed to cancel conditional orders', err);
    }

    try {
      const positions = await this.exchange.getPositions(symbol);
      for (const pos of positions) {
        const amt = parseFloat(pos.positionAmt);
        if (amt === 0) continue;

        const side: OrderSide = amt > 0 ? OrderSide.SELL : OrderSide.BUY;
        const absQty = Math.abs(amt).toString();

        await this.exchange.placeOrder({
          symbol,
          side,
          type: OrderType.MARKET,
          quantity: absQty,
          reduceOnly: true,
        });

        this.logger.log(
          `Closed position: ${side} ${absQty} ${symbol}`,
        );
      }
    } catch (err) {
      this.logger.error('Failed to close positions', err);
    }

    const openTrades = await this.tradeRepo.find({
      where: { symbol, status: 'OPEN' },
    });

    await new Promise((r) => setTimeout(r, 1000));

    let fills: UserTrade[] = [];
    try {
      fills = await this.exchange.getUserTrades(symbol);
    } catch {
      this.logger.warn('Could not fetch user trades for kill switch PnL');
    }

    for (const trade of openTrades) {
      const closeSide: OrderSide =
        trade.direction === 'LONG' ? OrderSide.SELL : OrderSide.BUY;
      const tradeOpenTime = new Date(trade.openedAt).getTime();
      const exitFills = fills.filter(
        (f) => f.side === closeSide && f.time > tradeOpenTime,
      );

      if (exitFills.length > 0) {
        let totalQty = 0;
        let totalNotional = 0;
        let realizedPnl = 0;
        let commission = 0;
        for (const f of exitFills) {
          const fQty = parseFloat(f.qty);
          const fPrice = parseFloat(f.price);
          totalQty += fQty;
          totalNotional += fQty * fPrice;
          realizedPnl += parseFloat(f.realizedPnl);
          commission += parseFloat(f.commission);
        }
        if (totalQty > 0) {
          trade.exitPrice = totalNotional / totalQty;
        }
        trade.realizedPnl = realizedPnl;
        trade.commission = commission;

        if (realizedPnl !== 0) {
          await this.updateDailyPnl(realizedPnl);
        }
      }

      trade.status = 'CLOSED_KILL_SWITCH';
      trade.closedAt = new Date();
      await this.tradeRepo.save(trade);
    }
  }

  /**
   * Phase 1A — Shadow mode evaluation for conditional MARKET fallback.
   * Uses neutral Candle objects from IExchangeRest.getKlines.
   */
  private async shadowEvaluateFallback(
    signal: ValidatedSignal,
    symbol: string,
    limitPrice: number,
    orderPlacedTime: number,
    limitWaitMs: number,
  ): Promise<void> {
    const mode = process.env.LIMIT_FALLBACK_MODE ?? 'off';
    if (mode !== 'shadow' && mode !== 'active') {
      return;
    }

    if (mode === 'active') {
      this.logger.warn(
        `[SHADOW] LIMIT_FALLBACK_MODE=active requested, but Phase 1A only logs. Treating as shadow.`,
      );
    }

    try {
      const waitEndTime = orderPlacedTime + limitWaitMs;

      const klines = await this.exchange.getKlines(
        symbol,
        '1m',
        10,
        orderPlacedTime,
        waitEndTime + 60_000,
      );

      if (!klines || klines.length === 0) {
        this.logger.log(`[SHADOW] Skip: no klines returned for wait window`);
        return;
      }

      const isLong = signal.action === 'LONG';
      const touchEvents = klines.filter((k) =>
        isLong ? k.low <= limitPrice : k.high >= limitPrice,
      );

      if (touchEvents.length === 0) {
        this.logger.log(
          `[SHADOW] Skip: zone never touched during ${limitWaitMs / 1000}s wait (limitPrice=${limitPrice}, ${klines.length} klines inspected)`,
        );
        return;
      }

      const lastTouchKline = touchEvents[touchEvents.length - 1];
      const lastTouchTime = lastTouchKline.closeTime;
      const timeSinceTouchAtWaitEnd = waitEndTime - lastTouchTime;
      const recentTouch =
        timeSinceTouchAtWaitEnd >= 0 && timeSinceTouchAtWaitEnd <= 60_000;

      const lastKline = klines[klines.length - 1];
      const currentPrice = lastKline.close;

      const structuralTolerance = signal.atr * 0.5;
      const priceStructurallyValid = isLong
        ? currentPrice >= limitPrice - structuralTolerance &&
          currentPrice <= limitPrice + structuralTolerance
        : currentPrice >= limitPrice - structuralTolerance &&
          currentPrice <= limitPrice + structuralTolerance;

      const lastClose = lastKline.close;
      const noInvalidation = isLong
        ? lastClose >= limitPrice - structuralTolerance
        : lastClose <= limitPrice + structuralTolerance;

      const slippage = Math.abs(currentPrice - limitPrice);
      const maxSlippage = Number(
        process.env.LIMIT_FALLBACK_MAX_SLIPPAGE_USDT ?? 20,
      );
      const slippageOk = slippage <= maxSlippage;

      const eligible =
        recentTouch && priceStructurallyValid && noInvalidation && slippageOk;

      if (eligible) {
        this.logger.warn(
          `[SHADOW] Would MARKET fallback at ${currentPrice.toFixed(2)} ` +
            `(slippage=$${slippage.toFixed(2)}, ` +
            `touch→waitEnd=${(timeSinceTouchAtWaitEnd / 1000).toFixed(0)}s, ` +
            `tolerance=$${structuralTolerance.toFixed(2)}, touches=${touchEvents.length})`,
        );
      } else {
        const reasons: string[] = [];
        if (!recentTouch) {
          reasons.push(
            `stale touch (touch→waitEnd=${(timeSinceTouchAtWaitEnd / 1000).toFixed(0)}s, threshold=60s)`,
          );
        }
        if (!priceStructurallyValid) {
          reasons.push(
            `price out of tolerance (current=${currentPrice.toFixed(2)}, ` +
              `limit=${limitPrice.toFixed(2)}, tolerance=±$${structuralTolerance.toFixed(2)})`,
          );
        }
        if (!noInvalidation) {
          reasons.push('post-touch invalidation');
        }
        if (!slippageOk) {
          reasons.push(
            `slippage too high ($${slippage.toFixed(2)} > $${maxSlippage.toFixed(2)})`,
          );
        }
        this.logger.log(`[SHADOW] Skip: ${reasons.join(', ')}`);
      }
    } catch (err) {
      this.logger.warn(
        `[SHADOW] evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
