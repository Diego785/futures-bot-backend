import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BinanceRestService } from '../binance/binance-rest.service';
import { ExchangeInfoService } from '../binance/exchange-info.service';
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
import type {
  OrderTradeUpdatePayload,
  AlgoUpdatePayload,
} from '../common/interfaces/binance.interfaces';
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
    private readonly binanceRest: BinanceRestService,
    private readonly exchangeInfo: ExchangeInfoService,
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
      const balances = await this.binanceRest.getAccountBalance();
      const usdtBalance = balances.find((b) => b.asset === 'USDT');
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
      // Without this, Math.floor can produce orders Binance will reject
      // (e.g. 0.001 BTC @ $73k = $73 notional vs $100 min).
      if (actualNotional < exchangeMinNotional) {
        const step = parseFloat(stepSize);
        const bumpedQty = parseFloat(quantity) + step;
        const bumpedNotional = bumpedQty * signal.entryPrice;
        const requiredMargin = bumpedNotional / maxLeverage;

        // Reserve $0.20 for entry+exit commissions (~0.05% × 2 × $150 notional ≈ $0.15).
        // No percentage buffer — SL/MAX_DAILY_LOSS/isolated margin already handle risk.
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
      await this.binanceRest.changeLeverage(symbol, maxLeverage);

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
        // Also expand TP to maintain R:R
        const tpMul = signal.action === 'LONG' ? 1 : -1;
        signal.takeProfit =
          signal.entryPrice + tpMul * minSlDistance * 1.5;
        this.logger.warn(
          `SL expanded: ${currentSlDistance.toFixed(0)} → ${minSlDistance.toFixed(0)} ` +
            `(old SL=${oldSl.toFixed(2)}, new SL=${signal.stopLoss.toFixed(2)}, TP=${signal.takeProfit.toFixed(2)})`,
        );
      }

      // 5. Determine sides
      const entrySide = signal.action === 'LONG' ? 'BUY' : 'SELL';
      const closeSide = signal.action === 'LONG' ? 'SELL' : 'BUY';

      // 5. Place LIMIT entry order (maker fee 0.02% vs taker 0.05%)
      const entryClientId = generateClientOrderId(
        'ENTRY',
        signalEntity.id,
        entrySide as 'BUY' | 'SELL',
      );

      // LIMIT at signal entry price (zone boundary) — wait for price to pullback to zone.
      // NO MARKET fallback: if price doesn't retrace, skip the trade entirely.
      // Rationale: backtest+real-data analysis shows MARKET fallbacks have 17% WR,
      // LIMIT fills have 80% WR. Chasing momentum destroys the strategy's edge.
      const limitPrice = roundToTickSize(signal.entryPrice, tickSize);
      const LIMIT_WAIT_MS = 60_000; // 60s — give price time to pull back to zone

      this.logger.log(
        `Placing ${entrySide} LIMIT order: ${quantity} ${symbol} @ ${limitPrice} (zone boundary, wait ${LIMIT_WAIT_MS / 1000}s)`,
      );

      let entryResponse;
      try {
        entryResponse = await this.binanceRest.placeOrder({
          symbol,
          side: entrySide,
          type: 'LIMIT',
          quantity,
          price: limitPrice,
          timeInForce: 'GTC',
          newClientOrderId: entryClientId,
        });

        if (entryResponse.status !== 'FILLED') {
          this.logger.log(
            `LIMIT order status: ${entryResponse.status}, waiting up to ${LIMIT_WAIT_MS / 1000}s for fill...`,
          );
          await new Promise((r) => setTimeout(r, LIMIT_WAIT_MS));

          // Try to cancel. If cancel succeeds → order wasn't filled → skip trade.
          // If cancel fails → order was already filled during wait → proceed.
          try {
            const cancelResp = await this.binanceRest.cancelOrder(
              symbol,
              entryClientId,
            );
            if (
              cancelResp.status === 'CANCELED' ||
              cancelResp.status === 'NEW'
            ) {
              this.logger.warn(
                `LIMIT order not filled in ${LIMIT_WAIT_MS / 1000}s at zone boundary ${limitPrice}. Skipping trade (no MARKET fallback).`,
              );
              return null;
            }
          } catch {
            // Cancel failed = order was filled during the wait. Continue.
            this.logger.log('LIMIT order filled during wait, proceeding');
          }
        }
      } catch (limitErr) {
        this.logger.error(
          `LIMIT order placement failed: ${limitErr}. Skipping trade.`,
        );
        return null;
      }

      // Save entry order
      const entryOrder = this.orderRepo.create({
        clientOrderId: entryClientId,
        binanceOrderId: entryResponse.orderId,
        symbol,
        side: entrySide,
        type: entryResponse.type || 'LIMIT',
        quantity: parseFloat(quantity),
        executedQty: parseFloat(entryResponse.executedQty || '0'),
        avgPrice: parseFloat(entryResponse.avgPrice || '0'),
        status: entryResponse.status,
        purpose: 'ENTRY',
        signalId: signalEntity.id,
      });
      await this.orderRepo.save(entryOrder);

      // 5b. Recalculate SL/TP if actual fill price differs significantly from signal entry.
      // For MARKET fills, entryResponse.avgPrice is often 0 — query userTrades to get real fill.
      let actualFillPrice = parseFloat(entryResponse.avgPrice || '0');
      if (actualFillPrice <= 0) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const userTrades = await this.binanceRest.getUserTrades(symbol, 10);
          const orderFills = userTrades.filter((t) => t.orderId === entryResponse.orderId);
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

      // 6. Place STOP_MARKET (stop loss) via Algo Order API
      const slPrice = roundToTickSize(signal.stopLoss, tickSize);
      const slClientId = generateClientOrderId(
        'SL',
        signalEntity.id,
        closeSide as 'BUY' | 'SELL',
      );

      this.logger.log(
        `Placing STOP_MARKET (algo): ${closeSide} ${quantity} ${symbol} @ ${slPrice}`,
      );

      const slResponse = await this.binanceRest.placeAlgoOrder({
        symbol,
        side: closeSide,
        type: 'STOP_MARKET',
        triggerPrice: slPrice,
        quantity,
        reduceOnly: 'true',
        clientAlgoId: slClientId,
      });

      const slOrder = this.orderRepo.create({
        clientOrderId: slClientId,
        binanceOrderId: slResponse.algoId,
        symbol,
        side: closeSide,
        type: 'STOP_MARKET',
        stopPrice: parseFloat(slPrice),
        quantity: parseFloat(quantity),
        status: slResponse.algoStatus,
        purpose: 'STOP_LOSS',
        signalId: signalEntity.id,
      });
      await this.orderRepo.save(slOrder);

      // 7. Place TAKE_PROFIT_MARKET via Algo Order API
      const tpPrice = roundToTickSize(signal.takeProfit, tickSize);
      const tpClientId = generateClientOrderId(
        'TP',
        signalEntity.id,
        closeSide as 'BUY' | 'SELL',
      );

      this.logger.log(
        `Placing TAKE_PROFIT_MARKET (algo): ${closeSide} ${quantity} ${symbol} @ ${tpPrice}`,
      );

      let tpOrder: any = null;
      try {
        const tpResponse = await this.binanceRest.placeAlgoOrder({
          symbol,
          side: closeSide,
          type: 'TAKE_PROFIT_MARKET',
          triggerPrice: tpPrice,
          quantity,
          reduceOnly: 'true',
          clientAlgoId: tpClientId,
        });

        tpOrder = this.orderRepo.create({
          clientOrderId: tpClientId,
          binanceOrderId: tpResponse.algoId,
          symbol,
          side: closeSide,
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: parseFloat(tpPrice),
          quantity: parseFloat(quantity),
          status: tpResponse.algoStatus,
          purpose: 'TAKE_PROFIT',
          signalId: signalEntity.id,
        });
        await this.orderRepo.save(tpOrder);
      } catch (tpErr: any) {
        this.logger.warn(
          `TP placement failed (${tpErr?.response?.data?.msg || tpErr?.message}). Trade will rely on trailing SL and software TP.`,
        );
      }

      // 8. Create Trade entity — ALWAYS, even if TP failed
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

      // 9. Record trade execution
      this.riskManager.recordTradeExecuted();

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
      // Attempt cleanup: cancel any open orders for this signal
      try {
        await this.binanceRest.cancelAllOpenOrders(symbol);
      } catch {
        // Best-effort cleanup
      }
      return null;
    }
  }

  async handleOrderUpdate(
    event: OrderTradeUpdatePayload,
  ): Promise<void> {
    const o = event.o;
    const clientOrderId = o.c;

    // Find order by clientOrderId
    const order = await this.orderRepo.findOne({
      where: { clientOrderId },
    });

    if (!order) {
      this.logger.debug(`Order not tracked: ${clientOrderId}`);
      return;
    }

    // Update order status
    order.status = o.X;
    order.executedQty = parseFloat(o.z);
    order.avgPrice = parseFloat(o.ap);
    await this.orderRepo.save(order);

    this.logger.log(
      `Order update: ${clientOrderId} status=${o.X} exec=${o.z} avg=${o.ap}`,
    );

    // Link tradeId for trailing SL orders that lost their tradeId reference
    if (!order.tradeId && clientOrderId.startsWith('FAB_TSL_')) {
      const parts = clientOrderId.split('_');
      if (parts.length >= 3) {
        const partialTradeId = parts[2]; // first 8 chars of trade UUID
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
      o.X === 'FILLED' &&
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
    if (o.X === 'FILLED' && (order.purpose === 'STOP_LOSS' || order.purpose === 'TAKE_PROFIT')) {
      await this.handleBracketFill(order, event);
    }
  }

  async handleAlgoUpdate(event: AlgoUpdatePayload): Promise<void> {
    const o = event.o;
    const clientAlgoId = o.caid;

    // Find order by clientAlgoId (stored as clientOrderId)
    let order = await this.orderRepo.findOne({
      where: { clientOrderId: clientAlgoId },
    });

    // Fallback: lookup by binanceOrderId (algoId) if clientAlgoId lookup fails
    if (!order && o.aid) {
      order = await this.orderRepo.findOne({
        where: { binanceOrderId: o.aid },
      });
      if (order) {
        this.logger.log(`Algo order found by algoId fallback: ${o.aid} (caid=${clientAlgoId})`);
      }
    }

    if (!order) {
      this.logger.debug(`Algo order not tracked: ${clientAlgoId} (aid=${o.aid})`);
      return;
    }

    this.logger.log(
      `Algo update: ${clientAlgoId} status=${o.X} type=${o.o} symbol=${o.s}`,
    );

    // Update order status based on algo status (only FINISHED — TRIGGERED is intermediate)
    if (o.X === 'FINISHED') {
      order.status = 'FILLED';
      order.executedQty = parseFloat(o.aq) || order.quantity;
      order.avgPrice = parseFloat(o.ap) || order.stopPrice || 0;
      await this.orderRepo.save(order);

      // This is a SL or TP fill — handle bracket closure
      if (order.purpose === 'STOP_LOSS' || order.purpose === 'TAKE_PROFIT') {
        await this.handleAlgoBracketFill(order, event);
      }
    } else if (o.X === 'CANCELED' || o.X === 'EXPIRED' || o.X === 'REJECTED') {
      order.status = o.X === 'REJECTED' ? 'REJECTED' : 'CANCELED';
      await this.orderRepo.save(order);
      if (o.rm) {
        this.logger.warn(`Algo order ${clientAlgoId} ${o.X}: ${o.rm}`);
      }
    }
  }

  private async handleAlgoBracketFill(
    filledOrder: Order,
    event: AlgoUpdatePayload,
  ): Promise<void> {
    if (!filledOrder.tradeId) return;

    // Prevent concurrent close of same trade (race condition guard)
    if (this.closingTrades.has(filledOrder.tradeId)) {
      this.logger.debug(`Trade ${filledOrder.tradeId} already being closed, skipping algo handler`);
      return;
    }
    this.closingTrades.add(filledOrder.tradeId);

    try {
    const trade = await this.tradeRepo.findOne({
      where: { id: filledOrder.tradeId },
    });

    if (!trade || trade.status !== 'OPEN') return;

    // Cancel the opposite bracket order
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
        await this.binanceRest.cancelAlgoOrder(oppositeOrder.binanceOrderId);
        oppositeOrder.status = 'CANCELED';
        await this.orderRepo.save(oppositeOrder);
        this.logger.log(
          `Canceled opposite algo order: ${oppositeOrder.clientOrderId}`,
        );
      } catch (err) {
        this.logger.warn('Failed to cancel opposite bracket algo order', err);
      }
    }

    // Update trade
    const exitPrice = parseFloat(event.o.ap) || filledOrder.stopPrice || 0;
    const entryPrice = Number(trade.entryPrice);
    const qty = Number(trade.quantity);
    const direction = trade.direction === 'LONG' ? 1 : -1;
    const pricePnl = (exitPrice - entryPrice) * qty * direction;

    // PnL must include round-trip commission. Entry was LIMIT (maker 0.02%), exit MARKET (taker 0.05%).
    let totalCommission = qty * entryPrice * 0.0002 + qty * exitPrice * 0.0005; // maker + taker
    let netPnl = pricePnl - totalCommission;

    // Wait 1s for Binance to finalize income records
    await new Promise((r) => setTimeout(r, 1000));

    // Fetch REAL PnL from Binance income history (authoritative)
    try {
      const tradeOpenTime = new Date(trade.openedAt).getTime() - 120_000;
      const incomeEntries = await this.binanceRest.getIncome(
        trade.symbol,
        tradeOpenTime,
        Date.now(),
        100,
      );
      let grossPnl = 0;
      let commissions = 0;
      let funding = 0;
      for (const entry of incomeEntries) {
        const amount = parseFloat(entry.income);
        if (entry.incomeType === 'REALIZED_PNL') grossPnl += amount;
        else if (entry.incomeType === 'COMMISSION') commissions += amount;
        else if (entry.incomeType === 'FUNDING_FEE') funding += amount;
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
      const binanceMsg = err?.response?.data?.msg || err?.response?.data || err?.message || err;
      this.logger.warn(
        `Income API failed: ${binanceMsg}; using estimated commission (PnL=${netPnl.toFixed(4)} comm=${totalCommission.toFixed(4)})`,
      );
    }

    trade.exitPrice = exitPrice;
    trade.realizedPnl = netPnl;
    trade.commission = totalCommission;
    trade.status =
      filledOrder.purpose === 'STOP_LOSS' ? 'CLOSED_SL' : 'CLOSED_TP';
    trade.closedAt = new Date();
    await this.tradeRepo.save(trade);

    // Update daily PnL
    await this.updateDailyPnl(netPnl);

    this.logger.log(
      `Trade closed (algo): ${trade.id} ${trade.status} PnL=${netPnl.toFixed(4)} (price=${pricePnl.toFixed(4)}, comm=${totalCommission.toFixed(4)})`,
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
    event: OrderTradeUpdatePayload,
  ): Promise<void> {
    if (!filledOrder.tradeId) {
      this.logger.warn(`handleBracketFill: order ${filledOrder.clientOrderId} has no tradeId`);
      return;
    }

    // Prevent concurrent close of same trade (race condition guard)
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

    // Cancel the opposite bracket order
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
        // Algo orders (SL/TP) use algoId stored in binanceOrderId
        await this.binanceRest.cancelAlgoOrder(oppositeOrder.binanceOrderId);
        oppositeOrder.status = 'CANCELED';
        await this.orderRepo.save(oppositeOrder);
        this.logger.log(
          `Canceled opposite algo order: ${oppositeOrder.clientOrderId} (algoId=${oppositeOrder.binanceOrderId})`,
        );
      } catch (err) {
        this.logger.warn('Failed to cancel opposite bracket order', err);
      }
    }

    // Update trade — PnL must include BOTH entry AND exit commissions.
    // event.o.n is the exit commission (MARKET taker).
    // Entry was LIMIT (maker 0.02%), so estimate entry commission from trade notional.
    const exitPrice = parseFloat(event.o.ap);
    const wsExitCommission = Math.abs(parseFloat(event.o.n || '0'));
    const entryNotional = Number(trade.entryPrice) * Number(trade.quantity);
    const estimatedEntryCommission = entryNotional * 0.0002; // maker 0.02%
    let totalCommission = wsExitCommission + estimatedEntryCommission;
    let netPnl = parseFloat(event.o.rp) - totalCommission;
    let incomeApiSucceeded = false;

    // Wait 1s for Binance to finalize income records before querying
    await new Promise((r) => setTimeout(r, 1000));

    // Fetch REAL PnL from Binance income history (authoritative: includes commissions + funding)
    try {
      const tradeOpenTime = new Date(trade.openedAt).getTime() - 120_000;
      const incomeEntries = await this.binanceRest.getIncome(
        trade.symbol,
        tradeOpenTime,
        Date.now(),
        100,
      );
      let grossPnl = 0;
      let commissions = 0;
      let funding = 0;
      for (const entry of incomeEntries) {
        const amount = parseFloat(entry.income);
        if (entry.incomeType === 'REALIZED_PNL') grossPnl += amount;
        else if (entry.incomeType === 'COMMISSION') commissions += amount;
        else if (entry.incomeType === 'FUNDING_FEE') funding += amount;
      }
      if (grossPnl !== 0 || commissions !== 0) {
        totalCommission = Math.abs(commissions);
        netPnl = grossPnl + commissions + funding;
        incomeApiSucceeded = true;
        this.logger.log(
          `Income breakdown: gross=${grossPnl.toFixed(4)} comm=${commissions.toFixed(4)} fund=${funding.toFixed(4)} net=${netPnl.toFixed(4)}`,
        );
      } else {
        this.logger.warn(
          `Income API returned no relevant entries; using WS fallback (PnL=${netPnl.toFixed(4)} comm=${totalCommission.toFixed(4)})`,
        );
      }
    } catch (err: any) {
      const binanceMsg = err?.response?.data?.msg || err?.response?.data || err?.message || err;
      this.logger.warn(
        `Income API failed: ${binanceMsg}; using WS fallback (PnL=${netPnl.toFixed(4)} comm=${totalCommission.toFixed(4)})`,
      );
    }

    trade.exitPrice = exitPrice;
    trade.realizedPnl = netPnl;
    trade.commission = totalCommission;
    trade.status =
      filledOrder.purpose === 'STOP_LOSS' ? 'CLOSED_SL' : 'CLOSED_TP';
    trade.closedAt = new Date();
    await this.tradeRepo.save(trade);

    // Update daily PnL
    await this.updateDailyPnl(netPnl);

    this.logger.log(
      `Trade closed: ${trade.id} ${trade.status} PnL=${netPnl.toFixed(4)} (comm=${totalCommission.toFixed(4)})`,
    );
    } finally {
      this.closingTrades.delete(filledOrder.tradeId);
    }
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
        const positions = await this.binanceRest.getPositionRisk(
          trade.symbol,
        );
        const activePos = positions.find(
          (p) => parseFloat(p.positionAmt) !== 0,
        );

        if (activePos) {
          // Position still open — sync entry price from Binance if DB has 0
          const binanceEntry = parseFloat(activePos.entryPrice);
          if (Number(trade.entryPrice) === 0 && binanceEntry > 0) {
            trade.entryPrice = binanceEntry;
            await this.tradeRepo.save(trade);
            this.logger.log(
              `Synced entry price for trade ${trade.id}: ${binanceEntry}`,
            );
          }

          // Sync entry order status if still NEW
          const entryOrder = trade.orders?.find(
            (o) => o.purpose === 'ENTRY' && o.status === 'NEW',
          );
          if (entryOrder && binanceEntry > 0) {
            entryOrder.status = 'FILLED';
            entryOrder.executedQty = parseFloat(activePos.positionAmt);
            entryOrder.avgPrice = binanceEntry;
            await this.orderRepo.save(entryOrder);
          }

          // Software SL/TP check (demo mode workaround — algo orders may be silently ignored)
          const markPrice = parseFloat(activePos.markPrice);
          const sl = Number(trade.stopLoss);
          const tp = Number(trade.takeProfit);
          const isLong = trade.direction === 'LONG';

          const slHit = sl > 0 && (isLong ? markPrice <= sl : markPrice >= sl);
          const tpHit = tp > 0 && (isLong ? markPrice >= tp : markPrice <= tp);

          if (slHit || tpHit) {
            // Re-check trade is still OPEN (WS handler may have closed it)
            const freshTrade = await this.tradeRepo.findOne({
              where: { id: trade.id },
            });
            if (!freshTrade || freshTrade.status !== 'OPEN') {
              this.logger.log(
                `Trade ${trade.id} already closed by WS handler, skipping software SL/TP`,
              );
            } else {
              const closeSide = isLong ? 'SELL' : 'BUY';
              const absQty = Math.abs(
                parseFloat(activePos.positionAmt),
              ).toString();

              this.logger.warn(
                `Software ${slHit ? 'SL' : 'TP'} triggered for trade ${trade.id} ` +
                  `at mark ${markPrice} (SL=${sl}, TP=${tp})`,
              );

              await this.binanceRest.placeOrder({
                symbol: trade.symbol,
                side: closeSide,
                type: 'MARKET',
                quantity: absQty,
                reduceOnly: 'true',
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
                    await this.binanceRest.cancelAlgoOrder(
                      order.binanceOrderId,
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

          // === TRAILING SL — Fixed-amount mode: SL follows price at $TRAIL_FIXED distance ===
          let entryPrice = Number(trade.entryPrice);
          // Correct entry price from actual fill if zone boundary differs from real fill
          if (entryPrice > 0) {
            const entryOrder = await this.orderRepo.findOne({
              where: { tradeId: trade.id, purpose: 'ENTRY' },
              order: { executedQty: 'DESC' },
            });
            if (entryOrder && entryOrder.avgPrice > 0 && Math.abs(entryOrder.avgPrice - entryPrice) > 1) {
              this.logger.log(
                `Entry price corrected: ${entryPrice.toFixed(1)} → ${entryOrder.avgPrice.toFixed(1)} (real fill)`,
              );
              entryPrice = entryOrder.avgPrice;
              trade.entryPrice = entryPrice;
              await this.tradeRepo.save(trade);
            }
          }
          // === POST-ENTRY MONITOR — log MFE/MAE for first 15 min after trade open ===
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
              // Cleanup after monitoring window
              this.tradeExcursions.delete(trade.id);
            }
          }

          // === TRAILING SL — Fixed-amount mode: SL follows price at $TRAIL_FIXED distance ===
          if (entryPrice > 0 && !slHit && !tpHit) {
            const priceDiff = isLong
              ? markPrice - entryPrice
              : entryPrice - markPrice;
            const trailFixed = Number(this.config.get('TRAIL_FIXED', 50));
            const trailActivation = Number(this.config.get('TRAIL_ACTIVATION', trailFixed));

            let newSl: number | null = null;

            if (priceDiff >= trailActivation) {
              // SL trails behind best price by trailFixed amount
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
              // Only move SL if improvement is meaningful (> $5) to avoid spam orders
              const isSignificant = slDiff > 5;

              if (isBetter && isSignificant) {
                // Cancel ALL existing SL algo orders from DB (not just in-memory)
                const existingSlOrders = await this.orderRepo.find({
                  where: {
                    tradeId: trade.id,
                    purpose: 'STOP_LOSS',
                    status: 'NEW',
                  },
                });
                for (const slOrder of existingSlOrders) {
                  try {
                    await this.binanceRest.cancelAlgoOrder(
                      slOrder.binanceOrderId,
                    );
                    slOrder.status = 'CANCELED';
                    await this.orderRepo.save(slOrder);
                  } catch {
                    // best-effort — order may already be canceled
                    slOrder.status = 'CANCELED';
                    await this.orderRepo.save(slOrder);
                  }
                }

                // Place new SL at better price
                const tickSize = this.exchangeInfo.getTickSize(
                  trade.symbol,
                );
                const closeSide = isLong ? 'SELL' : 'BUY';
                const roundedSl = roundToTickSize(newSl, tickSize);

                try {
                  const tslClientId = `FAB_TSL_${trade.id.substring(0, 8)}_${Date.now().toString(36)}`;
                  const newSlResponse =
                    await this.binanceRest.placeAlgoOrder({
                      symbol: trade.symbol,
                      side: closeSide,
                      type: 'STOP_MARKET',
                      triggerPrice: roundedSl,
                      quantity: Math.abs(
                        parseFloat(activePos.positionAmt),
                      ).toString(),
                      reduceOnly: 'true',
                      clientAlgoId: tslClientId,
                    });

                  const newSlOrder = this.orderRepo.create({
                    clientOrderId: tslClientId,
                    binanceOrderId: newSlResponse.algoId,
                    symbol: trade.symbol,
                    side: closeSide,
                    type: 'STOP_MARKET',
                    quantity: Math.abs(
                      parseFloat(activePos.positionAmt),
                    ),
                    status: 'NEW',
                    purpose: 'STOP_LOSS',
                    stopPrice: parseFloat(roundedSl),
                    tradeId: trade.id,
                  });
                  const savedSlOrder = await this.orderRepo.save(newSlOrder);
                  // Verify tradeId was persisted (guard against ORM quirks)
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
          // Re-check trade is still OPEN (WS handler may have closed it)
          const freshTrade = await this.tradeRepo.findOne({
            where: { id: trade.id },
          });
          if (!freshTrade || freshTrade.status !== 'OPEN') {
            this.logger.log(
              `Trade ${trade.id} already closed by WS handler, skipping reconcile`,
            );
            continue;
          }

          // Position closed on Binance — fetch fills to get exit data
          this.logger.warn(
            `Trade ${trade.id} marked OPEN but no position found on Binance. Closing.`,
          );

          let exitPrice: number | null = null;
          let realizedPnl = 0;
          let commission = 0;

          try {
            const fills = await this.binanceRest.getUserTrades(
              trade.symbol,
            );
            const closeSide =
              trade.direction === 'LONG' ? 'SELL' : 'BUY';
            const tradeOpenTime = new Date(trade.openedAt).getTime();

            // Filter: fills after trade opened, on the closing side
            const exitFills = fills.filter(
              (f) => f.side === closeSide && f.time > tradeOpenTime,
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
              }
              exitPrice = totalQty > 0 ? totalNotional / totalQty : null;
              this.logger.log(
                `Found ${exitFills.length} exit fills for trade ${trade.id}: ` +
                  `exitPrice=${exitPrice?.toFixed(2)}, pnl=${realizedPnl.toFixed(4)}`,
              );
            }
          } catch (err) {
            this.logger.warn(
              `Could not fetch user trades for ${trade.id}`,
              err,
            );
            // Fallback: estimate PnL from entry price if we have mark price data
          }

          // If no fills found via userTrades, fallback to income API
          if (exitPrice === null && realizedPnl === 0) {
            // Wait 2s for Binance to process the trade before querying income
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const tradeOpenTime = new Date(trade.openedAt).getTime() - 120_000;
              const incomeEntries = await this.binanceRest.getIncome(
                trade.symbol,
                tradeOpenTime,
                Date.now(),
                100,
              );
              let grossPnl = 0;
              let commissions = 0;
              let funding = 0;
              for (const entry of incomeEntries) {
                const amount = parseFloat(entry.income);
                if (entry.incomeType === 'REALIZED_PNL') grossPnl += amount;
                else if (entry.incomeType === 'COMMISSION') commissions += amount;
                else if (entry.incomeType === 'FUNDING_FEE') funding += amount;
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

            // If still no data, log the gap
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

          // Determine close status based on exit price proximity to SL/TP
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

          // Cancel remaining algo orders (SL/TP) since position is gone
          for (const order of trade.orders || []) {
            if (
              order.status === 'NEW' &&
              (order.purpose === 'STOP_LOSS' || order.purpose === 'TAKE_PROFIT')
            ) {
              try {
                await this.binanceRest.cancelAlgoOrder(order.binanceOrderId);
                order.status = 'CANCELED';
                await this.orderRepo.save(order);
              } catch {
                // May already be canceled/triggered
                order.status = 'CANCELED';
                await this.orderRepo.save(order);
              }
            }
          }

          await this.tradeRepo.save(trade);

          // Update daily PnL if we have data
          if (realizedPnl !== 0) {
            await this.updateDailyPnl(realizedPnl);
          }

          this.logger.log(
            `Trade reconciled: ${trade.id} ${closedStatus} ` +
              `exit=${exitPrice?.toFixed(2) ?? 'unknown'} PnL=${realizedPnl.toFixed(4)}`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Reconciliation failed for trade ${trade.id}`,
          err,
        );
      }
    }
    } finally {
      this.isReconciling = false;
    }
  }

  async closeAllPositions(symbol: string): Promise<void> {
    this.logger.warn(`CLOSING ALL POSITIONS for ${symbol}`);

    // 1. Cancel all open orders (regular + algo/conditional)
    try {
      await this.binanceRest.cancelAllOpenOrders(symbol);
    } catch (err) {
      this.logger.error('Failed to cancel open orders', err);
    }
    try {
      await this.binanceRest.cancelAllAlgoOrders(symbol);
    } catch (err) {
      this.logger.error('Failed to cancel algo orders', err);
    }

    // 2. Get current position
    try {
      const positions = await this.binanceRest.getPositionRisk(symbol);
      for (const pos of positions) {
        const amt = parseFloat(pos.positionAmt);
        if (amt === 0) continue;

        const side = amt > 0 ? 'SELL' : 'BUY';
        const absQty = Math.abs(amt).toString();

        await this.binanceRest.placeOrder({
          symbol,
          side,
          type: 'MARKET',
          quantity: absQty,
          reduceOnly: 'true',
        });

        this.logger.log(
          `Closed position: ${side} ${absQty} ${symbol}`,
        );
      }
    } catch (err) {
      this.logger.error('Failed to close positions', err);
    }

    // 3. Update DB — fetch fills to get exit data
    const openTrades = await this.tradeRepo.find({
      where: { symbol, status: 'OPEN' },
    });

    // Brief delay to allow fills to settle on Binance
    await new Promise((r) => setTimeout(r, 1000));

    let fills: import('../common/interfaces/binance.interfaces').BinanceUserTrade[] =
      [];
    try {
      fills = await this.binanceRest.getUserTrades(symbol);
    } catch {
      this.logger.warn('Could not fetch user trades for kill switch PnL');
    }

    for (const trade of openTrades) {
      // Try to find exit fills for this trade
      const closeSide = trade.direction === 'LONG' ? 'SELL' : 'BUY';
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
}
