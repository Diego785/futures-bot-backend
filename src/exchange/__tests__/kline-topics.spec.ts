import {
  klineStreamName,
  binanceWsBase,
} from '../../binance/binance-market-ws.service';
import {
  mapInterval,
  buildKlineTopic,
  parseKlineTopic,
} from '../../bybit/bybit-market-ws.service';

// Tests del mapeo de topics/streams → symbol/tf, base del refactor multi-symbol/timeframe.

describe('Binance kline stream naming', () => {
  it('construye el stream combinado en minúsculas', () => {
    expect(klineStreamName('BTCUSDT', '15m')).toBe('btcusdt@kline_15m');
    expect(klineStreamName('ETHUSDT', '1h')).toBe('ethusdt@kline_1h');
    expect(klineStreamName('BTCUSDT', '4h')).toBe('btcusdt@kline_4h');
    expect(klineStreamName('BTCUSDT', '1d')).toBe('btcusdt@kline_1d');
  });
});

describe('Binance WS base normalization (migración /market 2026)', () => {
  it('deja intacto el host base', () => {
    expect(binanceWsBase('wss://fstream.binance.com')).toBe(
      'wss://fstream.binance.com',
    );
  });
  it('quita el slash final', () => {
    expect(binanceWsBase('wss://fstream.binance.com/')).toBe(
      'wss://fstream.binance.com',
    );
  });
  it('normaliza rutas legacy /ws y /stream al host base', () => {
    expect(binanceWsBase('wss://fstream.binance.com/ws')).toBe(
      'wss://fstream.binance.com',
    );
    expect(binanceWsBase('wss://fstream.binance.com/stream')).toBe(
      'wss://fstream.binance.com',
    );
  });
  it('normaliza rutas nuevas /market y /market/stream al host base', () => {
    expect(binanceWsBase('wss://fstream.binance.com/market')).toBe(
      'wss://fstream.binance.com',
    );
    expect(binanceWsBase('wss://fstream.binance.com/market/stream')).toBe(
      'wss://fstream.binance.com',
    );
  });
});

describe('Bybit interval mapping (canónico → Bybit)', () => {
  it('mapea los 4 timeframes del alcance', () => {
    expect(mapInterval('15m')).toBe('15');
    expect(mapInterval('1h')).toBe('60');
    expect(mapInterval('4h')).toBe('240');
    expect(mapInterval('1d')).toBe('D');
  });
  it('soporta semanal y deja intactos los desconocidos', () => {
    expect(mapInterval('1w')).toBe('W');
    expect(mapInterval('raro')).toBe('raro');
  });
});

describe('Bybit topic build/parse', () => {
  it('construye el topic kline.<interval>.<symbol>', () => {
    expect(buildKlineTopic('BTCUSDT', '15')).toBe('kline.15.BTCUSDT');
    expect(buildKlineTopic('ETHUSDT', 'D')).toBe('kline.D.ETHUSDT');
  });
  it('parsea un topic de kline', () => {
    expect(parseKlineTopic('kline.240.ETHUSDT')).toEqual({
      bybitInterval: '240',
      symbol: 'ETHUSDT',
    });
    expect(parseKlineTopic('kline.D.BTCUSDT')).toEqual({
      bybitInterval: 'D',
      symbol: 'BTCUSDT',
    });
  });
  it('devuelve null para topics que no son kline', () => {
    expect(parseKlineTopic('orderbook.1.BTCUSDT')).toBeNull();
    expect(parseKlineTopic('tickers.BTCUSDT')).toBeNull();
  });
  it('round-trip build → parse preserva interval y symbol', () => {
    const topic = buildKlineTopic('BTCUSDT', mapInterval('4h'));
    expect(parseKlineTopic(topic)).toEqual({
      bybitInterval: '240',
      symbol: 'BTCUSDT',
    });
  });
});
