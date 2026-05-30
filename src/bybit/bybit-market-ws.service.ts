import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';
import WebSocket from 'ws';
import {
  IMarketDataPort,
  type Candle,
  type CandleEvent,
  type CandleSubscription,
  type ExchangeProvider,
  type PriceTickEvent,
} from '../exchange/interfaces/exchange.interfaces';

interface BybitKlineEvent {
  topic: string;
  data: Array<{
    start: number;
    end: number;
    interval: string;
    open: string;
    close: string;
    high: string;
    low: string;
    volume: string;
    turnover: string;
    confirm: boolean;
    timestamp: number;
  }>;
}

/** Mapea intervalo canónico ('15m','1h','4h','1d') al formato Bybit ('15','60','240','D'). */
export function mapInterval(interval: string): string {
  const m = interval.match(/^(\d+)([mhdw])$/);
  if (!m) return interval;
  const n = m[1];
  const unit = m[2];
  switch (unit) {
    case 'm':
      return n;
    case 'h':
      return (parseInt(n, 10) * 60).toString();
    case 'd':
      return 'D';
    case 'w':
      return 'W';
    default:
      return interval;
  }
}

/** Construye el topic de kline de Bybit: `kline.<bybitInterval>.<symbol>`. */
export function buildKlineTopic(symbol: string, bybitInterval: string): string {
  return `kline.${bybitInterval}.${symbol}`;
}

/** Parsea un topic `kline.<bybitInterval>.<symbol>`; null si no es kline. */
export function parseKlineTopic(
  topic: string,
): { bybitInterval: string; symbol: string } | null {
  const parts = topic.split('.');
  if (parts.length < 3 || parts[0] !== 'kline') return null;
  return { bybitInterval: parts[1], symbol: parts[2] };
}

@Injectable()
export class BybitMarketWsService
  extends IMarketDataPort
  implements OnModuleDestroy
{
  private readonly logger = new Logger(BybitMarketWsService.name);
  readonly provider: ExchangeProvider = 'bybit';

  private ws: InstanceType<typeof WebSocket> | null = null;
  private wsUrl: string;

  // Multi-symbol / multi-timeframe (2026-05-28): Bybit V5 admite múltiples topics
  // (distintos símbolos Y distintos intervalos) en una sola conexión. Keyed por topic
  // (kline.<bybitInterval>.<symbol>); value guarda el intervalo canónico para emitir tf.
  private subscriptions = new Map<string, CandleSubscription>();

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTime = 0;
  private destroyed = false;

  private readonly INITIAL_BACKOFF_MS = 30_000;
  private readonly MAX_BACKOFF_MS = 30 * 60_000;
  private readonly MAX_CONSECUTIVE_FAILS = 10;
  private readonly HEALTH_CHECK_INTERVAL_MS = 60_000;
  private readonly PING_INTERVAL_MS = 20_000;
  private readonly STALE_MESSAGE_THRESHOLD_MS = 1_200_000; // 20 min

  private circuitOpen = false;

  private readonly candleCloseSubject = new Subject<CandleEvent>();
  readonly onCandleClose$ = this.candleCloseSubject.asObservable();

  private readonly priceSubject = new Subject<PriceTickEvent>();
  readonly onPrice$ = this.priceSubject.asObservable();

  private readonly reconnectSubject = new Subject<void>();
  readonly onReconnect$ = this.reconnectSubject.asObservable();

  // Vela en formación (visual). Throttle por (symbol, tf).
  private readonly candleUpdateSubject = new Subject<CandleEvent>();
  readonly onCandleUpdate$ = this.candleUpdateSubject.asObservable();
  private lastCandleUpdateEmit = new Map<string, number>();
  private readonly CANDLE_UPDATE_THROTTLE_MS = 1000;
  // Throttle de price ticks por símbolo (max 1 emit / 5s por símbolo).
  private lastPriceEmitBySymbol = new Map<string, number>();
  private readonly PRICE_THROTTLE_MS = 5_000;

  constructor(private readonly config: ConfigService) {
    super();
    this.wsUrl = this.config.get<string>(
      'BYBIT_WS_PUBLIC_URL',
      'wss://stream.bybit.com/v5/public/linear',
    );
  }

  /** Acumulativo: añade (symbol, interval) sin tirar las suscripciones existentes. Idempotente. */
  subscribe(symbol: string, interval: string): void {
    const bybitInterval = mapInterval(interval);
    const topic = buildKlineTopic(symbol, bybitInterval);

    if (this.subscriptions.has(topic) && this.ws?.readyState === WebSocket.OPEN) {
      this.logger.log(`Already subscribed to ${topic}`);
      return;
    }

    this.subscriptions.set(topic, { symbol, interval });

    const state = this.ws?.readyState;
    if (state === WebSocket.OPEN) {
      this.logger.log(`Subscribing additional topic: ${topic}`);
      this.ws?.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
    } else if (state === WebSocket.CONNECTING) {
      // Conexión en curso: el handler 'open' suscribirá TODOS los topics acumulados.
      this.logger.log(`Queued ${topic} (WS connecting)`);
    } else {
      this.destroyed = false;
      this.circuitOpen = false;
      this.connect();
    }
  }

  /** Desuscribe un (symbol, interval) específico; sin args desuscribe todo y cierra. */
  unsubscribe(symbol?: string, interval?: string): void {
    if (symbol && interval) {
      const topic = buildKlineTopic(symbol, mapInterval(interval));
      if (this.subscriptions.delete(topic)) {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] }));
        }
        this.logger.log(`Unsubscribed from ${topic}`);
      }
      if (this.subscriptions.size === 0) {
        this.destroyed = true;
        this.cleanup();
      }
      return;
    }
    this.destroyed = true;
    this.cleanup();
  }

  getSubscriptions(): CandleSubscription[] {
    return Array.from(this.subscriptions.values());
  }

  onModuleDestroy(): void {
    this.unsubscribe();
  }

  private cleanup(): void {
    this.subscriptions.clear();
    this.stopHealthCheck();
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      } else if (this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.terminate();
      }
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.circuitOpen) {
      this.logger.error(
        'Market WS circuit breaker OPEN — refusing to reconnect. Manual intervention required.',
      );
      return;
    }
    if (this.subscriptions.size === 0) return;
    // Idempotente: no abrir una segunda conexión sobre una ya viva o en curso.
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING ||
        this.ws.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    this.logger.log(`Connecting to Bybit market WS: ${this.wsUrl}`);

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => {}); // absorbe errores tardíos del socket abandonado
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.terminate();
      }
      this.ws = null;
    }

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch {
      this.logger.error(`Failed to create WebSocket for ${this.wsUrl}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.lastMessageTime = Date.now();
      const topics = Array.from(this.subscriptions.keys());
      this.logger.log(
        `Bybit market WS connected, subscribing to ${topics.length} topic(s): ${topics.join(', ')}`,
      );
      this.ws?.send(JSON.stringify({ op: 'subscribe', args: topics }));
      this.startHealthCheck();
      this.startPing();
    });

    this.ws.on('message', (data: Buffer | string) => {
      this.lastMessageTime = Date.now();

      let payload: any;
      try {
        payload = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (payload.op === 'subscribe') {
        if (payload.success) {
          this.logger.log(`Subscription ack: ${payload.ret_msg ?? 'OK'}`);
        } else {
          this.logger.error(`Subscription failed: ${payload.ret_msg}`);
        }
        return;
      }

      if (payload.op === 'pong') return;

      if (payload.topic && payload.topic.startsWith('kline.')) {
        if (this.reconnectAttempts !== 0) {
          this.logger.log(
            `Bybit market WS data flowing after ${this.reconnectAttempts} reconnect attempt(s)`,
          );
          this.reconnectAttempts = 0;
          this.reconnectSubject.next(); // datos recuperados tras reconexión → reconciliar
        }

        const event = payload as BybitKlineEvent;
        const sub = this.subscriptions.get(payload.topic);
        if (!sub) {
          // Topic ajeno / desuscrito — ignorar.
          return;
        }
        const { symbol, interval: tf } = sub;

        for (const k of event.data ?? []) {
          const now = Date.now();
          const lastEmit = this.lastPriceEmitBySymbol.get(symbol) ?? 0;
          if (now - lastEmit >= this.PRICE_THROTTLE_MS) {
            this.lastPriceEmitBySymbol.set(symbol, now);
            this.priceSubject.next({ symbol, price: parseFloat(k.close) });
          }

          const candle: Candle = {
            openTime: k.start,
            open: parseFloat(k.open),
            high: parseFloat(k.high),
            low: parseFloat(k.low),
            close: parseFloat(k.close),
            volume: parseFloat(k.volume),
            closeTime: k.end,
            quoteVolume: parseFloat(k.turnover ?? '0'),
            trades: 0,
          };

          // Vela en formación (visual), throttled por (symbol, tf); siempre en el cierre.
          const uKey = `${symbol}:${tf}`;
          if (
            k.confirm ||
            now - (this.lastCandleUpdateEmit.get(uKey) ?? 0) >=
              this.CANDLE_UPDATE_THROTTLE_MS
          ) {
            this.lastCandleUpdateEmit.set(uKey, now);
            this.candleUpdateSubject.next({ symbol, tf, candle });
          }

          // Vela cerrada (causal) solo cuando se finaliza.
          if (k.confirm) {
            this.candleCloseSubject.next({ symbol, tf, candle });
          }
        }
      }
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error(`Bybit market WS error: ${err.message}`);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.logger.warn(
        `Bybit market WS closed: code=${code} reason=${reason.toString()}`,
      );
      this.stopPing();
      if (!this.destroyed) this.scheduleReconnect();
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, this.PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckTimer = setInterval(() => {
      if (!this.ws || this.subscriptions.size === 0 || this.destroyed) return;

      const elapsedMessage = Date.now() - this.lastMessageTime;
      if (elapsedMessage > this.STALE_MESSAGE_THRESHOLD_MS) {
        this.logger.warn(
          `Bybit market WS silent: no data for ${(elapsedMessage / 1000).toFixed(0)}s — forcing reconnect`,
        );
        if (this.ws) this.ws.terminate();
      }
    }, this.HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.subscriptions.size === 0) return;

    if (this.reconnectAttempts >= this.MAX_CONSECUTIVE_FAILS) {
      this.circuitOpen = true;
      this.logger.error(
        `Bybit market WS reached ${this.MAX_CONSECUTIVE_FAILS} consecutive failures — opening circuit. ` +
          `Stopping reconnect attempts. Restart bot or call subscribe() to retry.`,
      );
      return;
    }

    const delay = Math.min(
      this.INITIAL_BACKOFF_MS * Math.pow(2, this.reconnectAttempts),
      this.MAX_BACKOFF_MS,
    );
    this.reconnectAttempts++;
    this.logger.log(
      `Reconnecting Bybit market WS in ${delay}ms (attempt ${this.reconnectAttempts}/${this.MAX_CONSECUTIVE_FAILS})`,
    );

    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed) this.connect();
    }, delay);
  }
}
