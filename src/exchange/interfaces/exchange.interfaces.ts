import type { Observable } from 'rxjs';

// ─────────────────────────────────────────────────────────────────────────────
// Identifiers
// ─────────────────────────────────────────────────────────────────────────────

export type ExchangeProvider = 'binance' | 'bybit';

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export enum OrderSide {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum PositionSide {
  LONG = 'LONG',
  SHORT = 'SHORT',
  BOTH = 'BOTH',
}

export enum OrderType {
  LIMIT = 'LIMIT',
  MARKET = 'MARKET',
  STOP_MARKET = 'STOP_MARKET',
  TAKE_PROFIT_MARKET = 'TAKE_PROFIT_MARKET',
}

export enum TimeInForce {
  GTC = 'GTC',
  IOC = 'IOC',
  FOK = 'FOK',
  GTX = 'GTX', // post-only
}

export enum OrderStatus {
  NEW = 'NEW',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  FILLED = 'FILLED',
  CANCELED = 'CANCELED',
  EXPIRED = 'EXPIRED',
  REJECTED = 'REJECTED',
}

export enum ConditionalStatus {
  NEW = 'NEW',
  TRIGGERING = 'TRIGGERING',
  TRIGGERED = 'TRIGGERED',
  FINISHED = 'FINISHED',
  CANCELED = 'CANCELED',
  EXPIRED = 'EXPIRED',
  REJECTED = 'REJECTED',
}

export enum IncomeType {
  REALIZED_PNL = 'REALIZED_PNL',
  COMMISSION = 'COMMISSION',
  FUNDING_FEE = 'FUNDING_FEE',
  TRANSFER = 'TRANSFER',
  OTHER = 'OTHER',
}

// ─────────────────────────────────────────────────────────────────────────────
// Market data — already neutral, lives here as the canonical home
// ─────────────────────────────────────────────────────────────────────────────

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// REST request DTOs
// ─────────────────────────────────────────────────────────────────────────────

export interface PlaceOrderRequest {
  symbol: string;
  side: OrderSide;
  positionSide?: PositionSide;
  type: OrderType.LIMIT | OrderType.MARKET;
  quantity: string;
  price?: string;
  timeInForce?: TimeInForce;
  reduceOnly?: boolean;
  clientOrderId?: string;
}

export interface ConditionalOrderRequest {
  symbol: string;
  side: OrderSide;
  positionSide?: PositionSide;
  triggerPrice: string;
  quantity: string;
  reduceOnly?: boolean;
  // Si true: cierra TODA la posición al disparar (sin quantity ni reduceOnly) — bracket OCO robusto
  // (evita el rechazo por suma de reduceOnly y auto-cancela la hermana al cerrar). Preferido para SL/TP.
  closePosition?: boolean;
  clientOrderId?: string;
}

export interface IncomeFilter {
  symbol: string;
  startTime: number;
  endTime?: number;
  incomeType?: IncomeType;
  limit?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// REST response DTOs
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderResult {
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  type: OrderType;
  status: OrderStatus;
  price: string;
  origQty: string;
  executedQty: string;
  avgPrice: string;
  timeInForce: string;
  updateTime: number;
}

export interface ConditionalResult {
  conditionalId: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  orderType: OrderType.STOP_MARKET | OrderType.TAKE_PROFIT_MARKET;
  triggerPrice: string;
  quantity: string;
  status: ConditionalStatus;
  reduceOnly: boolean;
  createTime: number;
}

export interface Position {
  symbol: string;
  positionSide: PositionSide;
  positionAmt: string; // signed quantity (negative for short)
  entryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  liquidationPrice: string;
  notional: string;
  initialMargin: string;
  maintMargin: string;
  leverage: string;
  updateTime: number;
}

export interface Balance {
  asset: string;
  balance: string;
  availableBalance: string;
  crossWalletBalance: string;
  crossUnrealizedPnl: string;
  updateTime: number;
}

export interface UserTrade {
  tradeId: string;
  orderId: string;
  symbol: string;
  side: OrderSide;
  price: string;
  qty: string;
  realizedPnl: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isMaker: boolean;
}

export interface IncomeEntry {
  incomeType: IncomeType;
  income: string;
  asset: string;
  time: number;
  symbol?: string;
  tradeId?: string;
}

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: string;
  stepSize: string;
  minNotional: number;
  minQty: string;
  maxQty: string;
}

export interface ExchangeInfo {
  symbols: SymbolInfo[];
  serverTime: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket update DTOs
// ─────────────────────────────────────────────────────────────────────────────

export interface CandleEvent {
  symbol: string;
  tf: string; // timeframe/interval que produjo esta vela (p.ej. '15m', '1h', '4h', '1d')
  candle: Candle;
}

export interface CandleSubscription {
  symbol: string;
  interval: string;
}

export interface PriceTickEvent {
  symbol: string;
  price: number;
}

export interface OrderUpdate {
  eventTime: number;
  symbol: string;
  clientOrderId: string;
  orderId: string;
  side: OrderSide;
  positionSide: PositionSide;
  orderType: OrderType;
  status: OrderStatus;
  origQty: string;
  cumFilledQty: string;
  lastFilledQty: string;
  lastFilledPrice: string;
  avgPrice: string;
  origPrice: string;
  commission: string;
  commissionAsset: string;
  realizedPnl: string;
  reduceOnly: boolean;
}

export interface ConditionalUpdate {
  eventTime: number;
  conditionalId: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  orderType: OrderType.STOP_MARKET | OrderType.TAKE_PROFIT_MARKET;
  triggerPrice: string;
  quantity: string;
  status: ConditionalStatus;
  reduceOnly: boolean;
  triggeredOrderId?: string; // matching engine order ID once triggered
  avgPrice?: string;
  executedQty?: string;
  failureReason?: string;
}

export interface PositionUpdate {
  eventTime: number;
  symbol: string;
  positionSide: PositionSide;
  positionAmt: string;
  entryPrice: string;
  unrealizedPnl: string;
}

export interface AccountUpdate {
  eventTime: number;
  reason: string;
  balances: Array<{
    asset: string;
    walletBalance: string;
    crossWalletBalance: string;
    balanceChange: string;
  }>;
  positions: PositionUpdate[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Ports (abstract classes — serve as both type and DI token in NestJS)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * REST surface required from any exchange.
 * Implementations must hide exchange-specific quirks (auth, endpoint paths,
 * SL/TP semantics like Binance algoOrder vs Bybit conditional orders).
 */
export abstract class IExchangeRest {
  abstract readonly provider: ExchangeProvider;

  // Time / public
  abstract getServerTime(): Promise<number>;
  abstract getExchangeInfo(): Promise<ExchangeInfo>;
  abstract getKlines(
    symbol: string,
    interval: string,
    limit?: number,
    startTime?: number,
    endTime?: number,
  ): Promise<Candle[]>;

  // Orders
  abstract placeOrder(req: PlaceOrderRequest): Promise<OrderResult>;
  abstract cancelOrder(symbol: string, clientOrderId: string): Promise<void>;
  abstract cancelAllOpenOrders(symbol: string): Promise<void>;

  // Conditional orders (Stop Loss / Take Profit) — abstracts:
  //   Binance: separate /algoOrder endpoint
  //   Bybit:   conditional order with triggerPrice on regular order endpoint
  abstract placeStopLoss(req: ConditionalOrderRequest): Promise<ConditionalResult>;
  abstract placeTakeProfit(
    req: ConditionalOrderRequest,
  ): Promise<ConditionalResult>;
  abstract cancelConditional(
    symbol: string,
    conditionalId: string,
  ): Promise<void>;
  abstract getOpenConditionals(symbol: string): Promise<ConditionalResult[]>;
  abstract cancelAllConditionals(symbol: string): Promise<void>;

  // Account
  abstract getBalance(asset: string): Promise<Balance | null>;
  abstract getPositions(symbol?: string): Promise<Position[]>;
  abstract changeLeverage(symbol: string, leverage: number): Promise<void>;

  // History / fees
  abstract getUserTrades(symbol: string, limit?: number): Promise<UserTrade[]>;
  abstract getIncome(filter: IncomeFilter): Promise<IncomeEntry[]>;

  // Diagnostics
  abstract getUsedWeight(): number;
}

/**
 * Market data WebSocket port — kline / price stream.
 * Implementations must:
 *   - Handle reconnection with bounded exponential backoff
 *   - Detect silent streams (connection alive but no data) and surface them
 *   - Emit only finalized candles via onCandleClose$
 *   - Throttle price ticks
 */
export abstract class IMarketDataPort {
  abstract readonly provider: ExchangeProvider;
  abstract readonly onCandleClose$: Observable<CandleEvent>;
  // Vela EN FORMACIÓN (no cerrada), emitida throttled mientras la vela actual se actualiza.
  // Es VISUAL: puede cambiar. NO usar para detección causal (el motor SMC solo usa cerradas).
  abstract readonly onCandleUpdate$: Observable<CandleEvent>;
  abstract readonly onPrice$: Observable<PriceTickEvent>;
  // Emite cuando el WS se reconecta y los datos vuelven a fluir (tras caída). El consumidor
  // debe reconciliar por REST el hueco para no perder cierres. No emite en la primera conexión.
  abstract readonly onReconnect$: Observable<void>;

  // Acumulativo: añade un stream (symbol, interval) sin descartar los existentes. Idempotente.
  abstract subscribe(symbol: string, interval: string): void;
  // Desuscribe un (symbol, interval) específico; omitir ambos args desuscribe todo.
  abstract unsubscribe(symbol?: string, interval?: string): void;
  // Snapshot de las suscripciones activas.
  abstract getSubscriptions(): CandleSubscription[];
}

/**
 * User data WebSocket port — order, conditional, position, account events.
 * Implementations must hide auth lifecycle (Binance ListenKey / Bybit HMAC).
 */
export abstract class IUserDataPort {
  abstract readonly provider: ExchangeProvider;
  abstract readonly onOrderUpdate$: Observable<OrderUpdate>;
  abstract readonly onConditionalUpdate$: Observable<ConditionalUpdate>;
  abstract readonly onAccountUpdate$: Observable<AccountUpdate>;

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract keepalive(): Promise<void>;
}

/**
 * Cached symbol info — exchange-agnostic helpers used heavily by execution
 * service for price/qty rounding and notional checks.
 */
export abstract class IExchangeInfoService {
  abstract refresh(): Promise<void>;
  abstract getSymbolInfo(symbol: string): SymbolInfo | undefined;
  abstract getTickSize(symbol: string): string;
  abstract getStepSize(symbol: string): string;
  abstract getMinNotional(symbol: string): number;
  abstract getPricePrecision(symbol: string): number;
  abstract getQuantityPrecision(symbol: string): number;
}
