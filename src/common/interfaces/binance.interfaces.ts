// ─── Raw kline array from GET /fapi/v1/klines ───
export type BinanceKlineRaw = [
  number, // 0: openTime
  string, // 1: open
  string, // 2: high
  string, // 3: low
  string, // 4: close
  string, // 5: volume
  number, // 6: closeTime
  string, // 7: quoteAssetVolume
  number, // 8: numberOfTrades
  string, // 9: takerBuyBaseVolume
  string, // 10: takerBuyQuoteVolume
  string, // 11: ignore
];

// ─── Parsed candle for internal use ───
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

// ─── Exchange Info ───
export interface BinanceSymbolFilter {
  filterType: string;
  tickSize?: string;
  minPrice?: string;
  maxPrice?: string;
  stepSize?: string;
  minQty?: string;
  maxQty?: string;
  notional?: string;
}

export interface BinanceSymbolInfo {
  symbol: string;
  pair: string;
  contractType: string;
  baseAsset: string;
  quoteAsset: string;
  marginAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  filters: BinanceSymbolFilter[];
}

export interface BinanceExchangeInfoResponse {
  symbols: BinanceSymbolInfo[];
  rateLimits: Array<{
    rateLimitType: string;
    interval: string;
    intervalNum: number;
    limit: number;
  }>;
}

// ─── Order ───
export interface BinanceOrderResponse {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  type: string;
  status: string;
  price: string;
  origQty: string;
  executedQty: string;
  avgPrice: string;
  timeInForce: string;
  updateTime: number;
}

// ─── Algo Order (STOP_MARKET, TAKE_PROFIT_MARKET — migrated Dec 2025) ───
export interface BinanceAlgoOrderResponse {
  algoId: number;
  clientAlgoId: string;
  algoType: string;
  orderType: string;
  symbol: string;
  side: string;
  triggerPrice: string;
  algoStatus: string;
  createTime: number;
}

// ─── Position ───
export interface BinancePositionRisk {
  symbol: string;
  positionSide: string;
  positionAmt: string;
  entryPrice: string;
  breakEvenPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  notional: string;
  initialMargin: string;
  maintMargin: string;
  leverage: string;
  updateTime: number;
}

// ─── User Trades (fills) ───
export interface BinanceUserTrade {
  symbol: string;
  id: number;
  orderId: number;
  side: string;
  price: string;
  qty: string;
  realizedPnl: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  buyer: boolean;
  maker: boolean;
}

// ─── Balance ───
export interface BinanceAccountBalance {
  asset: string;
  balance: string;
  availableBalance: string;
  crossWalletBalance: string;
  crossUnPnl: string;
  updateTime: number;
}

// ─── WebSocket: Kline event ───
export interface KlineWsPayload {
  e: 'kline';
  E: number;
  s: string;
  k: {
    t: number; // open time
    T: number; // close time
    s: string; // symbol
    i: string; // interval
    f: number; // first trade ID
    L: number; // last trade ID
    o: string; // open
    c: string; // close
    h: string; // high
    l: string; // low
    v: string; // base volume
    n: number; // number of trades
    x: boolean; // is kline closed?
    q: string; // quote volume
    V: string; // taker buy base volume
    Q: string; // taker buy quote volume
  };
}

// ─── WebSocket: ORDER_TRADE_UPDATE event ───
export interface OrderTradeUpdatePayload {
  e: 'ORDER_TRADE_UPDATE';
  E: number;
  T: number;
  o: {
    s: string; // symbol
    c: string; // clientOrderId
    S: 'BUY' | 'SELL';
    o: string; // orderType
    f: string; // timeInForce
    q: string; // origQty
    p: string; // origPrice
    ap: string; // avgPrice
    x: string; // executionType (NEW, TRADE, CANCELED, EXPIRED)
    X: string; // orderStatus (NEW, FILLED, CANCELED, etc.)
    i: number; // orderId
    l: string; // lastFilledQty
    z: string; // cumFilledQty
    L: string; // lastFilledPrice
    N: string; // commissionAsset
    n: string; // commission
    R: boolean; // reduceOnly
    ps: string; // positionSide
    rp: string; // realizedProfit
  };
}

// ─── WebSocket: ALGO_UPDATE event (conditional SL/TP orders) ───
export interface AlgoUpdatePayload {
  e: 'ALGO_UPDATE';
  T: number;
  E: number;
  o: {
    caid: string; // clientAlgoId
    aid: number; // algoId
    at: string; // algoType (CONDITIONAL)
    o: string; // orderType (STOP_MARKET, TAKE_PROFIT_MARKET)
    s: string; // symbol
    S: 'BUY' | 'SELL';
    ps: string; // positionSide
    q: string; // quantity
    X: string; // algoStatus (NEW, TRIGGERING, TRIGGERED, FINISHED, CANCELED, REJECTED, EXPIRED)
    ai: string; // actualOrderId (matching engine order ID once triggered)
    ap: string; // avgPrice
    aq: string; // executedQty
    tp: string; // triggerPrice
    R: boolean; // reduceOnly
    rm: string; // failure reason
  };
}

// ─── WebSocket: ACCOUNT_UPDATE event ───
export interface AccountUpdatePayload {
  e: 'ACCOUNT_UPDATE';
  E: number;
  T: number;
  a: {
    m: string; // event reason
    B: Array<{
      a: string; // asset
      wb: string; // wallet balance
      cw: string; // cross wallet balance
      bc: string; // balance change
    }>;
    P: Array<{
      s: string; // symbol
      pa: string; // position amount
      ep: string; // entry price
      up: string; // unrealized PnL
      ps: string; // position side
    }>;
  };
}

// ─── Helper: parse raw kline to Candle ───
export function parseKline(raw: BinanceKlineRaw): Candle {
  return {
    openTime: raw[0],
    open: parseFloat(raw[1]),
    high: parseFloat(raw[2]),
    low: parseFloat(raw[3]),
    close: parseFloat(raw[4]),
    volume: parseFloat(raw[5]),
    closeTime: raw[6],
    quoteVolume: parseFloat(raw[7]),
    trades: raw[8],
  };
}
