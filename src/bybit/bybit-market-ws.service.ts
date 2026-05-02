import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';
import WebSocket from 'ws';
import {
  IMarketDataPort,
  type Candle,
  type CandleEvent,
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

@Injectable()
export class BybitMarketWsService
  extends IMarketDataPort
  implements OnModuleDestroy
{
  private readonly logger = new Logger(BybitMarketWsService.name);
  readonly provider: ExchangeProvider = 'bybit';

  private ws: InstanceType<typeof WebSocket> | null = null;
  private wsUrl: string;
  private currentSymbol: string | null = null;
  private currentInterval: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTime = 0;
  private destroyed = false;

  // Backoff cap aligned with the lesson learned from the Binance soft-ban
  // incident: short fixed retries (30s-ish) extend bans. We grow up to 30 min
  // and stop after MAX_CONSECUTIVE_FAILS to avoid hammering a throttled exchange.
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
  private lastPriceEmit = 0;
  private readonly PRICE_THROTTLE_MS = 5_000;

  constructor(private readonly config: ConfigService) {
    super();
    this.wsUrl = this.config.get<string>(
      'BYBIT_WS_PUBLIC_URL',
      'wss://stream.bybit.com/v5/public/linear',
    );
  }

  subscribe(symbol: string, interval: string): void {
    const bybitInterval = mapInterval(interval);
    if (
      this.currentSymbol === symbol &&
      this.currentInterval === bybitInterval &&
      this.ws?.readyState === WebSocket.OPEN
    ) {
      this.logger.log(`Already subscribed to ${symbol} kline.${bybitInterval}`);
      return;
    }

    this.cleanup();
    this.destroyed = false;
    this.circuitOpen = false;
    this.currentSymbol = symbol;
    this.currentInterval = bybitInterval;
    this.connect();
  }

  unsubscribe(): void {
    this.destroyed = true;
    this.cleanup();
  }

  onModuleDestroy(): void {
    this.unsubscribe();
  }

  private cleanup(): void {
    this.currentSymbol = null;
    this.currentInterval = null;
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
    if (!this.currentSymbol || !this.currentInterval) return;

    this.logger.log(`Connecting to Bybit market WS: ${this.wsUrl}`);

    if (this.ws) {
      this.ws.removeAllListeners();
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
      this.logger.log(`Bybit market WS connected, subscribing to kline.${this.currentInterval}.${this.currentSymbol}`);
      this.ws?.send(
        JSON.stringify({
          op: 'subscribe',
          args: [`kline.${this.currentInterval}.${this.currentSymbol}`],
        }),
      );
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
          // Real data confirmed — reset failure counter only after we've seen
          // an actual data event (handled below), not just on subscribe ack.
        } else {
          this.logger.error(`Subscription failed: ${payload.ret_msg}`);
        }
        return;
      }

      if (payload.op === 'pong') return;

      if (payload.topic && payload.topic.startsWith('kline.')) {
        // Real kline data received — reset failure counter.
        if (this.reconnectAttempts !== 0) {
          this.logger.log(
            `Bybit market WS data flowing after ${this.reconnectAttempts} reconnect attempt(s)`,
          );
          this.reconnectAttempts = 0;
        }

        const event = payload as BybitKlineEvent;
        const symbol = this.currentSymbol!;
        for (const k of event.data ?? []) {
          // Emit price tick (throttled)
          const now = Date.now();
          if (now - this.lastPriceEmit >= this.PRICE_THROTTLE_MS) {
            this.lastPriceEmit = now;
            this.priceSubject.next({ symbol, price: parseFloat(k.close) });
          }

          // Emit candle close only when finalized
          if (k.confirm) {
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
            this.candleCloseSubject.next({ symbol, candle });
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
      if (!this.ws || !this.currentSymbol || this.destroyed) return;

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
    if (this.destroyed || !this.currentSymbol) return;

    if (this.reconnectAttempts >= this.MAX_CONSECUTIVE_FAILS) {
      this.circuitOpen = true;
      this.logger.error(
        `Bybit market WS reached ${this.MAX_CONSECUTIVE_FAILS} consecutive failures — opening circuit. ` +
          `Stopping reconnect attempts. Restart bot or call subscribe() to retry.`,
      );
      return;
    }

    // Exponential backoff: 30s, 60s, 120s, 240s, 480s, 960s, 1800s (cap)
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

function mapInterval(interval: string): string {
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
