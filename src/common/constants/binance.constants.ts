export const BINANCE_API = {
  EXCHANGE_INFO: '/fapi/v1/exchangeInfo',
  KLINES: '/fapi/v1/klines',
  ORDER: '/fapi/v1/order',
  ALL_OPEN_ORDERS: '/fapi/v1/allOpenOrders',
  // Algo Order API (STOP_MARKET, TAKE_PROFIT_MARKET, etc. migrated Dec 2025)
  ALGO_ORDER: '/fapi/v1/algoOrder',
  ALGO_OPEN_ORDERS: '/fapi/v1/openAlgoOrders',
  POSITION_RISK: '/fapi/v3/positionRisk',
  ACCOUNT_BALANCE: '/fapi/v3/balance',
  LISTEN_KEY: '/fapi/v1/listenKey',
  CHANGE_LEVERAGE: '/fapi/v1/leverage',
  USER_TRADES: '/fapi/v1/userTrades',
  SERVER_TIME: '/fapi/v1/time',
} as const;

export const QUEUE_NAMES = {
  STRATEGY_CYCLE: 'strategy-cycle',
} as const;

export const WS_EVENTS = {
  BOT_STATUS: 'bot:status',
  SIGNAL_NEW: 'signal:new',
  ORDER_UPDATE: 'order:update',
  POSITION_UPDATE: 'position:update',
  TRADE_CLOSED: 'trade:closed',
  ERROR: 'bot:error',
  GATE_RESULT: 'gate:result',
  ANALYSIS_COMPLETE: 'analysis:complete',
  PRICE_UPDATE: 'price:update',
} as const;
