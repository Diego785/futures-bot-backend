import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';
import WebSocket from 'ws';
import type {
  Candle,
  KlineWsPayload,
} from '../common/interfaces/binance.interfaces';

@Injectable()
export class BinanceMarketWsService implements OnModuleDestroy {
  private readonly logger = new Logger(BinanceMarketWsService.name);
  private ws: InstanceType<typeof WebSocket> | null = null;
  private wsUrl: string;
  private currentStream: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTime = 0;
  private lastPongTime = 0;
  private destroyed = false;

  // Backoff cap raised from 30s → 30 min after the soft-ban incident: short
  // fixed retries kept hammering Binance and apparently extended the throttle.
  // Combined with a hard ceiling on consecutive failures (circuit breaker)
  // we trade a longer downtime for not provoking the upstream further.
  private readonly INITIAL_BACKOFF_MS = 30_000;
  private readonly MAX_RECONNECT_DELAY_MS = 30 * 60_000;
  private readonly MAX_CONSECUTIVE_FAILS = 10;
  private readonly HEALTH_CHECK_INTERVAL_MS = 120_000; // 2 minutes
  private readonly STALE_PONG_THRESHOLD_MS = 300_000; // 5 min no pong = connection dead
  private readonly STALE_MESSAGE_THRESHOLD_MS = 1_200_000; // 20 min no data despite pongs = silent stream
  private circuitOpen = false;

  private readonly candleCloseSubject = new Subject<{
    symbol: string;
    candle: Candle;
  }>();
  readonly onCandleClose$ = this.candleCloseSubject.asObservable();

  private readonly priceSubject = new Subject<{
    symbol: string;
    price: number;
  }>();
  readonly onPrice$ = this.priceSubject.asObservable();
  private lastPriceEmit = 0;
  private readonly PRICE_THROTTLE_MS = 5_000; // max 1 price emit per 5s

  constructor(private readonly config: ConfigService) {
    // Lenient read so the service can be instantiated even when EXCHANGE_PROVIDER=bybit
    // and Binance creds aren't configured. subscribe() will fail loudly if called
    // without a wsUrl, which only happens when this provider is actually selected.
    this.wsUrl = this.config.get<string>('BINANCE_FUTURES_WS_URL', '');
  }

  subscribe(symbol: string, interval: string): void {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;

    if (this.currentStream === stream && this.ws?.readyState === 1) {
      this.logger.log(`Already subscribed to ${stream}`);
      return;
    }

    this.cleanup();
    this.destroyed = false;
    this.circuitOpen = false; // explicit reset on user-initiated subscribe
    this.reconnectAttempts = 0;
    this.currentStream = stream;
    this.connect(stream);
  }

  unsubscribe(): void {
    this.destroyed = true;
    this.cleanup();
  }

  private cleanup(): void {
    this.currentStream = null;
    this.stopHealthCheck();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      } else if (this.ws.readyState === WebSocket.CONNECTING) {
        // Can't close while connecting — terminate instead
        this.ws.terminate();
      }
      this.ws = null;
    }
  }

  onModuleDestroy(): void {
    this.unsubscribe();
  }

  private connect(stream: string): void {
    const url = `${this.wsUrl}/ws/${stream}`;
    this.logger.log(`Connecting to market WS: ${url}`);

    // Cleanup any stale socket reference before creating a new one.
    // scheduleReconnect() does not call cleanup(), so without this the old
    // WS object lingers with its listeners attached until GC.
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
      this.ws = new WebSocket(url);
    } catch {
      this.logger.error(`Failed to create WebSocket for ${url}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.lastMessageTime = Date.now();
      this.lastPongTime = Date.now();
      this.startHealthCheck();
      this.logger.log(`Market WS connected: ${stream}`);
    });

    this.ws.on('message', (data: Buffer | string) => {
      // Reset backoff only when actual data flows. If the socket opens
      // but serves a silent stream (Binance edge case post-1006), we want
      // exponential backoff to keep growing so we stop hammering a
      // broken endpoint.
      if (this.reconnectAttempts !== 0) {
        this.logger.log(
          `Market WS data flowing after ${this.reconnectAttempts} reconnect attempt(s)`,
        );
        this.reconnectAttempts = 0;
      }
      this.lastMessageTime = Date.now();
      try {
        const payload = JSON.parse(data.toString()) as KlineWsPayload;
        if (payload.e === 'kline') {
          const k = payload.k;

          // Emit price tick (throttled to max 1 per 5s)
          const now = Date.now();
          if (now - this.lastPriceEmit >= this.PRICE_THROTTLE_MS) {
            this.lastPriceEmit = now;
            this.priceSubject.next({
              symbol: payload.s,
              price: parseFloat(k.c),
            });
          }

          // Emit candle close (only when candle is finalized)
          if (k.x) {
            const candle: Candle = {
              openTime: k.t,
              open: parseFloat(k.o),
              high: parseFloat(k.h),
              low: parseFloat(k.l),
              close: parseFloat(k.c),
              volume: parseFloat(k.v),
              closeTime: k.T,
              quoteVolume: parseFloat(k.q),
              trades: k.n,
            };
            this.candleCloseSubject.next({ symbol: payload.s, candle });
          }
        }
      } catch (err) {
        this.logger.error('Failed to parse market WS message', err);
      }
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error(`Market WS error: ${err.message}`);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.logger.warn(
        `Market WS closed: code=${code} reason=${reason.toString()}`,
      );
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('ping', (data: Buffer) => {
      this.ws?.pong(data);
    });

    this.ws.on('pong', () => {
      this.lastPongTime = Date.now();
    });
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckTimer = setInterval(() => {
      if (!this.ws || !this.currentStream || this.destroyed) return;

      // Primary: pong-based liveness — catches real TCP/WS death fast.
      const elapsedPong = Date.now() - this.lastPongTime;
      if (elapsedPong > this.STALE_PONG_THRESHOLD_MS) {
        this.logger.warn(
          `Market WS stale: no pong for ${(elapsedPong / 1000).toFixed(0)}s — forcing reconnect`,
        );
        if (this.ws) this.ws.terminate();
        return;
      }

      // Secondary: silent-stream detection.
      // After abnormal close (code 1006) Binance occasionally serves a
      // connection that responds to pings/pongs but never delivers kline
      // data — pong health check misses this. kline_15m emits multiple
      // messages per minute even in quiet markets, so 20 min of silence
      // despite healthy pongs means the subscription is dead.
      const elapsedMessage = Date.now() - this.lastMessageTime;
      if (elapsedMessage > this.STALE_MESSAGE_THRESHOLD_MS) {
        this.logger.warn(
          `Market WS silent: no data for ${(elapsedMessage / 1000).toFixed(0)}s despite healthy pongs — forcing reconnect`,
        );
        if (this.ws) this.ws.terminate();
        return;
      }

      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
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
    if (this.destroyed || !this.currentStream) return;

    if (this.reconnectAttempts >= this.MAX_CONSECUTIVE_FAILS) {
      this.circuitOpen = true;
      this.logger.error(
        `Binance market WS reached ${this.MAX_CONSECUTIVE_FAILS} consecutive failures — opening circuit. ` +
          `Stopping reconnect attempts to avoid extending any upstream throttle. ` +
          `Restart bot or call subscribe() to retry.`,
      );
      return;
    }

    // Exponential: 30s, 60s, 120s, 240s, 480s, 960s, 1800s (capped at 30min).
    const delay = Math.min(
      this.INITIAL_BACKOFF_MS * Math.pow(2, this.reconnectAttempts),
      this.MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts++;
    this.logger.log(
      `Reconnecting market WS in ${delay}ms (attempt ${this.reconnectAttempts}/${this.MAX_CONSECUTIVE_FAILS})`,
    );

    this.reconnectTimer = setTimeout(() => {
      if (this.currentStream && !this.destroyed && !this.circuitOpen) {
        this.connect(this.currentStream);
      }
    }, delay);
  }
}
