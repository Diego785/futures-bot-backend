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
  CombinedStreamPayload,
} from '../common/interfaces/binance.interfaces';
import type {
  CandleEvent,
  CandleSubscription,
} from '../exchange/interfaces/exchange.interfaces';

/** Nombre del stream de kline combinado de Binance: `btcusdt@kline_15m`. */
export function klineStreamName(symbol: string, interval: string): string {
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

@Injectable()
export class BinanceMarketWsService implements OnModuleDestroy {
  private readonly logger = new Logger(BinanceMarketWsService.name);
  private ws: InstanceType<typeof WebSocket> | null = null;
  private wsUrl: string;

  // Multi-symbol / multi-timeframe (2026-05-28): una sola conexión combinada /stream
  // sostiene N suscripciones (symbol, interval). Keyed por stream name (btcusdt@kline_15m).
  private subscriptions = new Map<string, CandleSubscription>();
  private msgId = 1;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTime = 0;
  private lastPongTime = 0;
  private destroyed = false;

  // Backoff cap raised from 30s → 30 min after the soft-ban incident: short
  // fixed retries kept hammering Binance and apparently extended the throttle.
  private readonly INITIAL_BACKOFF_MS = 30_000;
  private readonly MAX_RECONNECT_DELAY_MS = 30 * 60_000;
  private readonly MAX_CONSECUTIVE_FAILS = 10;
  private readonly HEALTH_CHECK_INTERVAL_MS = 120_000; // 2 minutes
  private readonly STALE_PONG_THRESHOLD_MS = 300_000; // 5 min no pong = connection dead
  private readonly STALE_MESSAGE_THRESHOLD_MS = 1_200_000; // 20 min no data despite pongs = silent stream
  private circuitOpen = false;

  private readonly candleCloseSubject = new Subject<CandleEvent>();
  readonly onCandleClose$ = this.candleCloseSubject.asObservable();

  private readonly priceSubject = new Subject<{ symbol: string; price: number }>();
  readonly onPrice$ = this.priceSubject.asObservable();
  // Throttle de price ticks por símbolo (max 1 emit / 5s por símbolo).
  private lastPriceEmitBySymbol = new Map<string, number>();
  private readonly PRICE_THROTTLE_MS = 5_000;

  constructor(private readonly config: ConfigService) {
    // Lenient read so the service can be instantiated even when EXCHANGE_PROVIDER=bybit
    // and Binance creds aren't configured. subscribe() will fail loudly if called
    // without a wsUrl, which only happens when this provider is actually selected.
    this.wsUrl = this.config.get<string>('BINANCE_FUTURES_WS_URL', '');
  }

  /** Acumulativo: añade (symbol, interval) sin tirar las suscripciones existentes. Idempotente. */
  subscribe(symbol: string, interval: string): void {
    const stream = klineStreamName(symbol, interval);

    if (this.subscriptions.has(stream) && this.ws?.readyState === WebSocket.OPEN) {
      this.logger.log(`Already subscribed to ${stream}`);
      return;
    }

    this.subscriptions.set(stream, { symbol, interval });

    if (this.ws?.readyState === WebSocket.OPEN) {
      // Conexión viva — suscripción incremental solo de este stream.
      this.sendSubscribe([stream]);
      this.logger.log(`Subscribed (incremental) to ${stream}`);
    } else {
      // Sin conexión (o cerrada) — abrir una; todos los streams se suscriben en 'open'.
      this.destroyed = false;
      this.circuitOpen = false;
      this.reconnectAttempts = 0;
      this.connect();
    }
  }

  /** Desuscribe un (symbol, interval) específico; sin args desuscribe todo y cierra. */
  unsubscribe(symbol?: string, interval?: string): void {
    if (symbol && interval) {
      const stream = klineStreamName(symbol, interval);
      if (this.subscriptions.delete(stream)) {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.sendUnsubscribe([stream]);
        }
        this.logger.log(`Unsubscribed from ${stream}`);
      }
      // Si ya no queda nada, cerrar la conexión.
      if (this.subscriptions.size === 0) {
        this.destroyed = true;
        this.cleanup();
      }
      return;
    }
    // Sin args: desuscribir todo.
    this.destroyed = true;
    this.cleanup();
  }

  getSubscriptions(): CandleSubscription[] {
    return Array.from(this.subscriptions.values());
  }

  private sendSubscribe(streams: string[]): void {
    this.ws?.send(
      JSON.stringify({ method: 'SUBSCRIBE', params: streams, id: this.msgId++ }),
    );
  }

  private sendUnsubscribe(streams: string[]): void {
    this.ws?.send(
      JSON.stringify({ method: 'UNSUBSCRIBE', params: streams, id: this.msgId++ }),
    );
  }

  private cleanup(): void {
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
        this.ws.terminate();
      }
      this.ws = null;
    }
    if (this.destroyed) {
      this.subscriptions.clear();
    }
  }

  onModuleDestroy(): void {
    this.unsubscribe();
  }

  private connect(): void {
    if (this.circuitOpen || this.destroyed || this.subscriptions.size === 0) return;

    // Endpoint combinado: una conexión, múltiples streams vía SUBSCRIBE.
    const url = `${this.wsUrl}/stream`;
    this.logger.log(
      `Connecting to combined market WS: ${url} (${this.subscriptions.size} stream(s))`,
    );

    // Cleanup any stale socket reference before creating a new one.
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
      // Suscribir TODOS los streams activos al (re)conectar.
      const streams = Array.from(this.subscriptions.keys());
      if (streams.length > 0) this.sendSubscribe(streams);
      this.logger.log(
        `Market WS connected; subscribed to ${streams.length} stream(s): ${streams.join(', ')}`,
      );
    });

    this.ws.on('message', (data: Buffer | string) => {
      if (this.reconnectAttempts !== 0) {
        this.logger.log(
          `Market WS data flowing after ${this.reconnectAttempts} reconnect attempt(s)`,
        );
        this.reconnectAttempts = 0;
      }
      this.lastMessageTime = Date.now();
      try {
        const raw = JSON.parse(data.toString());

        // Respuesta a SUBSCRIBE/UNSUBSCRIBE: { result: null, id }.
        if (raw && typeof raw === 'object' && 'result' in raw && !('stream' in raw)) {
          return;
        }

        // Mensaje de stream combinado: { stream, data: KlineWsPayload }.
        const wrapped = raw as CombinedStreamPayload<KlineWsPayload>;
        const payload = wrapped?.data;
        if (!payload || payload.e !== 'kline') return;

        const k = payload.k;
        const symbol = payload.s;
        const tf = k.i; // intervalo de la vela

        // Price tick (throttle por símbolo)
        const now = Date.now();
        const lastEmit = this.lastPriceEmitBySymbol.get(symbol) ?? 0;
        if (now - lastEmit >= this.PRICE_THROTTLE_MS) {
          this.lastPriceEmitBySymbol.set(symbol, now);
          this.priceSubject.next({ symbol, price: parseFloat(k.c) });
        }

        // Candle close (solo velas finalizadas)
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
          this.candleCloseSubject.next({ symbol, tf, candle });
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
      if (!this.ws || this.subscriptions.size === 0 || this.destroyed) return;

      // Primary: pong-based liveness.
      const elapsedPong = Date.now() - this.lastPongTime;
      if (elapsedPong > this.STALE_PONG_THRESHOLD_MS) {
        this.logger.warn(
          `Market WS stale: no pong for ${(elapsedPong / 1000).toFixed(0)}s — forcing reconnect`,
        );
        if (this.ws) this.ws.terminate();
        return;
      }

      // Secondary: silent-stream detection.
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
    if (this.destroyed || this.subscriptions.size === 0) return;

    if (this.reconnectAttempts >= this.MAX_CONSECUTIVE_FAILS) {
      this.circuitOpen = true;
      this.logger.error(
        `Binance market WS reached ${this.MAX_CONSECUTIVE_FAILS} consecutive failures — opening circuit. ` +
          `Stopping reconnect attempts to avoid extending any upstream throttle. ` +
          `Restart bot or call subscribe() to retry.`,
      );
      return;
    }

    const delay = Math.min(
      this.INITIAL_BACKOFF_MS * Math.pow(2, this.reconnectAttempts),
      this.MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts++;
    this.logger.log(
      `Reconnecting market WS in ${delay}ms (attempt ${this.reconnectAttempts}/${this.MAX_CONSECUTIVE_FAILS})`,
    );

    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed && !this.circuitOpen && this.subscriptions.size > 0) {
        this.connect();
      }
    }, delay);
  }
}
