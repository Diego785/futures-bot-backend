// Tipos de la capa de ejecución real ACOTADA (P.5). Regla Cero acotada — ver docs/EXECUTION-SPEC.md.
// El sizing SALE de config (capital de test), NUNCA del balance real de la cuenta (EXECUTION-SPEC §3).

import type { TradeIntent, TradeDirection } from '../backtest/trade-simulator';

export type { TradeIntent, TradeDirection };

// Config de ejecución — topes duros del arnés (EXECUTION-SPEC §5). Todo viene de env con defaults.
export interface ExecutionConfig {
  enabled: boolean;
  testnet: boolean;
  testCapitalUsd: number; // base del sizing (NO el balance)
  riskPct: number; // 0.005 = 0.5 %
  leverage: number;
  maxConcurrentPositions: number;
  maxNotionalPerOrderUsd: number;
  maxMarginUsedUsd: number;
  maxDailyLossR: number;
  circuitBreakerLossR: number;
}

// Filtros del símbolo para redondear/validar (de IExchangeInfoService).
export interface SymbolFilters {
  tickSize: string;
  stepSize: string;
  minNotional: number;
}

export type OrderLeg = 'ENTRY' | 'SL' | 'TP';
export type OrderSideStr = 'BUY' | 'SELL';
export type PlannedOrderType = 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';

// Una orden ya redondeada y lista para colocar (precios string como exige Binance).
export interface PlannedOrder {
  leg: OrderLeg;
  clientOrderId: string;
  symbol: string;
  side: OrderSideStr;
  type: PlannedOrderType;
  quantity: string; // redondeada al stepSize (FLOOR — nunca redondea hacia arriba)
  price?: string; // LIMIT (entrada): redondeado al tick
  stopPrice?: string; // STOP_MARKET / TAKE_PROFIT_MARKET: gatillo redondeado al tick
  reduceOnly: boolean;
}

export interface BracketPlan {
  intentId: string;
  symbol: string;
  direction: TradeDirection;
  riskUsd: number;
  stopDistance: number;
  quantity: string;
  notionalUsd: number;
  entry: PlannedOrder;
  stopLoss: PlannedOrder;
  takeProfit: PlannedOrder;
}

export type PlanRejectReason =
  | 'symbolUnknown'
  | 'badPrices'
  | 'zeroQty'
  | 'minNotional'
  | 'maxNotional';

export type PlanResult =
  | { ok: true; plan: BracketPlan }
  | { ok: false; reason: PlanRejectReason; detail: string };

// ─── Risk-guard (arnés de seguridad, EXECUTION-SPEC §5) ───

// Topes duros. Se derivan de ExecutionConfig + la whitelist de símbolos + la franja de sanity de precio.
export interface RiskLimits {
  maxConcurrentPositions: number;
  maxNotionalPerOrderUsd: number;
  maxMarginUsedUsd: number;
  maxDailyLossR: number; // pérdida diaria (R, positiva) que bloquea nuevas aperturas hasta el día UTC siguiente
  circuitBreakerLossR: number; // pérdida acumulada (R) que activa el kill permanente
  leverage: number;
  symbols: string[]; // whitelist (solo el universo del candidato)
  priceSanityFrac: number; // la entrada no puede estar a más de ±frac del precio de mercado (anti-bug)
}

// Estado vivo del guardián.
export interface RiskState {
  activeSlots: number; // intents en vuelo (límite resting u posición abierta)
  marginUsedUsd: number; // margen comprometido (reservas + posiciones)
  dailyLossR: number; // R perdida en el día UTC actual (≥0)
  cumulativeLossR: number; // R perdida acumulada desde el arranque (≥0)
  realizedR: number; // R neta realizada (informativo)
  dayKey: string; // 'YYYY-MM-DD' UTC del día en curso
  killed: boolean;
  killReason: string | null;
}

export type RiskDecision = { allow: true } | { allow: false; reason: string };
