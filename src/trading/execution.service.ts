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
      const rawQty = leveragedNotional / signal.entryPrice;
      const quantity = roundToStepSize(rawQty, stepSize);

      const actualNotional = parseFloat(quantity) * signal.entryPrice;
      this.logger.log(
        `Position sizing: balance=${available.toFixed(2)} notional=${notional} ` +
          `leverage=${maxLeverage}x leveraged=${leveragedNotional.toFixed(2)} ` +
          `qty=${quantity} actualNotional=${actualNotional.toFixed(2)}`,
      );

      if (parseFloat(quantity) <= 0 || actualNotional < 5) {
        this.logger.error(
          `Position too small: qty=${quantity} notional=${actualNotional.toFixed(2)} (min 5 USDT)`,
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

      // Get current mark price for aggressive LIMIT pricing
      const positions = await this.binanceRest.getPositionRisk(symbol);
      const markPrice =
        positions.length > 0
          ? parseFloat(positions[0].markPrice)
          : signal.entryPrice;

      // Offset to ensure fill: +$15 for BUY, -$15 for SELL
      const limitOffset = 15;
      const limitPrice = roundToTickSize(
        entrySide === 'BUY'
          ? markPrice + limitOffset
          : markPrice - limitOffset,
        tickSize,
      );

      this.logger.log(
        `Placing ${entrySide} LIMIT order: ${quantity} ${symbol} @ ${limitPrice} (mark=${markPrice.toFixed(2)})`,
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

        // If LIMIT not filled immediately, wait up to 10s then fallback to MARKET
        if (entryResponse.status !== 'FILLED') {
          this.logger.log(
            `LIMIT order status: ${entryResponse.status}, waiting for fill...`,
          );
          await new Promise((r) => setTimeout(r, 10000));

          // Re-check order status — Binance doesn't have getOrder for algo, but regular order works
          // If still not filled, cancel and use MARKET
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
                'LIMIT order not filled in 10s, falling back to MARKET',
              );
              entryResponse = await this.binanceRest.placeOrder({
                symbol,
                side: entrySide,
                type: 'MARKET',
                quantity,
              });
            }
          } catch {
            // Cancel failed = order was already filled
            this.logger.log('LIMIT order already filled during wait');
          }
        }
      } catch (limitErr) {
        // LIMIT failed, fallback to MARKET
        this.logger.warn(
          `LIMIT order failed, falling back to MARKET: ${limitErr}`,
        );
        entryResponse = await this.binanceRest.placeOrder({
          symbol,
          side: entrySide,
          type: 'MARKET',
          quantity,
          newClientOrderId: entryClientId + '_MKT',
        });
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

      // 5b. Recalculate SL/TP if actual fill price differs significantly from signal entry
      const parsedFillAvg = parseFloat(entryResponse.avgPrice || '0');
      const actualFillPrice = parsedFillAvg > 0 ? parsedFillAvg : signal.entryPrice;
      const fillDiff = Math.abs(actualFillPrice - signal.entryPrice);
      if (fillDiff > 50) {
        const slDistance = Math.abs(signal.entryPrice - signal.stopLoss);
        const isLong = signal.action === 'LONG';
        signal.stopLoss = isLong
          ? actualFillPrice - slDistance
          : actualFillPrice + slDistance;
        signal.takeProfit = isLong
          ? actualFillPrice + slDistance * 1.5
          : actualFillPrice - slDistance * 1.5;
        signal.entryPrice = actualFillPrice;
        this.logger.warn(
          `Recalculated SL/TP for fill at ${actualFillPrice.toFixed(2)} (signal was ${(actualFillPrice - fillDiff * (isLong ? 1 : -1)).toFixed(2)}) → SL=${signal.stopLoss.toFixed(2)} TP=${signal.takeProfit.toFixed(2)}`,
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
          `entry=${entryResponse.avgPrice} SL=${slPrice} TP=${tpPrice}`,
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

    // Fetch REAL PnL from Binance income history (includes commissions + funding fees)
    let netPnl = pricePnl;
    let totalCommission = 0;
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
        else if (entry.incomeType === 'COMMISSION') commissions += amount; // negative
        else if (entry.incomeType === 'FUNDING_FEE') funding += amount; // can be +/-
      }
      // Binance returns commissions as negative numbers
      totalCommission = Math.abs(commissions);
      // Net PnL = gross + commissions (negative) + funding (can be +/-)
      netPnl = grossPnl + commissions + funding;
      this.logger.log(
        `Income breakdown: gross=${grossPnl.toFixed(4)} comm=${commissions.toFixed(4)} fund=${funding.toFixed(4)} net=${netPnl.toFixed(4)}`,
      );
    } catch (err) {
      this.logger.warn('Failed to fetch income history, using manual PnL', err);
      // Fallback: estimate commission
      totalCommission = qty * entryPrice * 0.001;
      netPnl = pricePnl - totalCommission;
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
    if (!filledOrder.tradeId) return;

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

    if (!trade || trade.status !== 'OPEN') return;

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

    // Update trade — fetch full commissions from user trades API
    const exitPrice = parseFloat(event.o.ap);
    let netPnl = parseFloat(event.o.rp) - Math.abs(parseFloat(event.o.n || '0'));
    let totalCommission = Math.abs(parseFloat(event.o.n || '0'));

    // Fetch REAL PnL from Binance income history (includes commissions + funding fees)
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
      totalCommission = Math.abs(commissions);
      netPnl = grossPnl + commissions + funding;
      this.logger.log(
        `Income breakdown: gross=${grossPnl.toFixed(4)} comm=${commissions.toFixed(4)} fund=${funding.toFixed(4)} net=${netPnl.toFixed(4)}`,
      );
    } catch {
      // Keep WS-based PnL as fallback
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
          const entryPrice = Number(trade.entryPrice);
          if (entryPrice > 0 && !slHit && !tpHit) {
            const priceDiff = isLong
              ? markPrice - entryPrice
              : entryPrice - markPrice;
            const trailFixed = this.config.get<number>('TRAIL_FIXED', 50);
            const trailActivation = this.config.get<number>('TRAIL_ACTIVATION', trailFixed);

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
                  await this.orderRepo.save(newSlOrder);

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

          // If no fills found, try to estimate from entry data
          if (exitPrice === null && realizedPnl === 0) {
            const entryPrice = Number(trade.entryPrice);
            const qty = Number(trade.quantity);
            if (entryPrice > 0 && qty > 0) {
              // We don't know the exit price, but log it
              this.logger.warn(
                `No exit fills found for trade ${trade.id}. Entry=${entryPrice}, Qty=${qty}. ` +
                  `Cannot determine exit price.`,
              );
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
