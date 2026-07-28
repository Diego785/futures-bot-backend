// Executor de órdenes: envoltura DELGADA sobre IExchangeRest que coloca/cancela el bracket y aplana
// posiciones. Sin lógica de estrategia (eso es el plan) ni de riesgo (eso es el risk-guard de P.5.3).
// Es el building-block que usan el smoke (P.5.2) y el cableado al motor (P.5.3).

import { Injectable, Logger } from '@nestjs/common';
import {
  IExchangeRest,
  IExchangeInfoService,
  OrderSide,
  OrderType,
  TimeInForce,
  type OrderResult,
  type ConditionalResult,
  type Position,
} from '../exchange/interfaces/exchange.interfaces';
import type { PlannedOrder, SymbolFilters } from './execution.types';

@Injectable()
export class OrderExecutorService {
  private readonly logger = new Logger(OrderExecutorService.name);

  constructor(
    private readonly rest: IExchangeRest,
    private readonly info: IExchangeInfoService,
  ) {}

  filtersFor(symbol: string): SymbolFilters | undefined {
    if (!this.info.getSymbolInfo(symbol)) return undefined;
    return {
      tickSize: this.info.getTickSize(symbol),
      stepSize: this.info.getStepSize(symbol),
      minNotional: this.info.getMinNotional(symbol),
    };
  }

  async ensureLeverage(symbol: string, leverage: number): Promise<void> {
    await this.rest.changeLeverage(symbol, leverage);
  }

  // Margen AISLADO (P.5.4): la pérdida máxima de una posición queda acotada a su margen. Binance
  // devuelve -4046 si ya está en ISOLATED → se trata como éxito.
  async ensureIsolatedMargin(symbol: string): Promise<void> {
    if (!this.rest.changeMarginType) return;
    try {
      await this.rest.changeMarginType(symbol, 'ISOLATED');
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (!m.includes('-4046')) throw e; // -4046 = "No need to change margin type" (ya estaba)
    }
  }

  // Precio de referencia (último cierre 1m). Reintenta: el REST de testnet falla transitoriamente.
  async getLastPrice(symbol: string): Promise<number> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const k = await this.rest.getKlines(symbol, '1m', 1);
        if (k.length) return k[k.length - 1].close;
      } catch (e) {
        this.logger.warn(`getLastPrice ${symbol} intento ${attempt}/3: ${e instanceof Error ? e.message : e}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
    return 0;
  }

  async getOpenPosition(symbol: string): Promise<Position | null> {
    const positions = await this.rest.getPositions(symbol);
    return positions.find((p) => Math.abs(parseFloat(p.positionAmt)) > 0) ?? null;
  }

  // Saldo REAL de la billetera USDT-M — SOLO para mostrar en el dashboard. El sizing tiene PROHIBIDO
  // usarlo (EXECUTION-SPEC §3: el riesgo sale del capital configurado, jamás del balance).
  async getWalletUsd(): Promise<number | null> {
    const b = await this.rest.getBalance('USDT');
    return b ? parseFloat(b.balance) || 0 : null;
  }

  getOpenConditionals(symbol: string): Promise<ConditionalResult[]> {
    return this.rest.getOpenConditionals(symbol);
  }

  placeEntryLimit(o: PlannedOrder): Promise<OrderResult> {
    return this.rest.placeOrder({
      symbol: o.symbol,
      side: toSide(o.side),
      type: OrderType.LIMIT,
      quantity: o.quantity,
      price: o.price,
      timeInForce: TimeInForce.GTC,
      reduceOnly: false,
      clientOrderId: o.clientOrderId,
    });
  }

  // v2: la pierna TP1 del partial-runner — LIMIT reduceOnly por cantidad (maker, como el sim).
  placeLimitReduceOnly(o: PlannedOrder): Promise<OrderResult> {
    return this.rest.placeOrder({
      symbol: o.symbol,
      side: toSide(o.side),
      type: OrderType.LIMIT,
      quantity: o.quantity,
      price: o.price,
      timeInForce: TimeInForce.GTC,
      reduceOnly: true,
      clientOrderId: o.clientOrderId,
    });
  }

  // MARKET — usado para forzar fill en el smoke y para CERRAR (reduceOnly) al aplanar.
  placeMarket(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: string,
    reduceOnly: boolean,
    clientOrderId?: string,
  ): Promise<OrderResult> {
    return this.rest.placeOrder({
      symbol,
      side: toSide(side),
      type: OrderType.MARKET,
      quantity,
      reduceOnly,
      clientOrderId,
    });
  }

  placeStop(o: PlannedOrder): Promise<ConditionalResult> {
    return this.rest.placeStopLoss({
      symbol: o.symbol,
      side: toSide(o.side),
      triggerPrice: o.stopPrice as string,
      quantity: o.quantity, // ignorado: closePosition cierra toda la posición
      closePosition: true,
      clientOrderId: o.clientOrderId,
    });
  }

  placeTakeProfit(o: PlannedOrder): Promise<ConditionalResult> {
    return this.rest.placeTakeProfit({
      symbol: o.symbol,
      side: toSide(o.side),
      triggerPrice: o.stopPrice as string,
      quantity: o.quantity, // ignorado: closePosition cierra toda la posición
      closePosition: true,
      clientOrderId: o.clientOrderId,
    });
  }

  cancelOrder(symbol: string, clientOrderId: string): Promise<void> {
    return this.rest.cancelOrder(symbol, clientOrderId);
  }

  cancelConditional(symbol: string, conditionalId: string): Promise<void> {
    return this.rest.cancelConditional(symbol, conditionalId);
  }

  // P&L REAL neto (USD) de un símbolo desde `startTime`: REALIZED_PNL + COMMISSION + FUNDING_FEE.
  // Fuente de verdad para liquidar una posición cuyo cierre NO vimos por WS (sweep).
  async getNetIncomeSince(symbol: string, startTime: number): Promise<number> {
    const entries = await this.rest.getIncome({ symbol, startTime, limit: 100 });
    return entries
      .filter((e) => ['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE'].includes(e.incomeType))
      .reduce((s, e) => s + (parseFloat(e.income) || 0), 0);
  }

  // Precio del ÚLTIMO fill del símbolo desde `sinceMs` (userTrades) = precio REAL de salida de una
  // posición liquidada por sweep. Sin esto los cierres por sweep quedan sin exitPrice y el slippage
  // del stop es invisible (hallazgo UNI 2026-07-27: −0.31R de slip que hubo que reconstruir a mano).
  async getLastFillPriceSince(symbol: string, sinceMs: number): Promise<number | null> {
    const trades = await this.rest.getUserTrades(symbol, 30);
    const inWindow = trades.filter((t) => t.time >= sinceMs);
    if (!inWindow.length) return null;
    const last = inWindow.reduce((a, b) => (b.time >= a.time ? b : a));
    const px = parseFloat(last.price);
    return Number.isFinite(px) && px > 0 ? px : null;
  }

  // Aplana TODO el símbolo: cancela condicionales + órdenes abiertas y cierra la posición a mercado
  // (reduceOnly). Best-effort en cada paso para que un fallo parcial no deje la posición a medio cerrar.
  async flatten(symbol: string): Promise<void> {
    await safe(() => this.rest.cancelAllConditionals(symbol), this.logger, 'cancelAllConditionals');
    await safe(() => this.rest.cancelAllOpenOrders(symbol), this.logger, 'cancelAllOpenOrders');
    const pos = await this.getOpenPosition(symbol);
    if (pos) {
      const amt = parseFloat(pos.positionAmt);
      const closeSide = amt > 0 ? 'SELL' : 'BUY';
      const qty = pos.positionAmt.startsWith('-') ? pos.positionAmt.slice(1) : pos.positionAmt;
      await this.placeMarket(symbol, closeSide, qty, true);
    }
  }
}

function toSide(s: 'BUY' | 'SELL'): OrderSide {
  return s === 'BUY' ? OrderSide.BUY : OrderSide.SELL;
}

async function safe(fn: () => Promise<unknown>, logger: Logger, label: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    logger.warn(`${label} falló (best-effort): ${e instanceof Error ? e.message : e}`);
  }
}
