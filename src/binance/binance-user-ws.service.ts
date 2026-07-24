import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';
import WebSocket from 'ws';
import { BinanceRestService } from './binance-rest.service';
import type {
  OrderTradeUpdatePayload,
  AccountUpdatePayload,
  AlgoUpdatePayload,
} from '../common/interfaces/binance.interfaces';

@Injectable()
export class BinanceUserWsService implements OnModuleDestroy {
  private readonly logger = new Logger(BinanceUserWsService.name);
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private listenKey: string | null = null;
  private destroyed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly MAX_RECONNECT_DELAY_MS = 30_000;

  // WATCHDOG anti-zombi (hallazgo P.5.4): en VPS el TCP puede morir SIN evento 'close' (NAT corta en
  // silencio) → el socket queda "open" para siempre sin entregar eventos. Binance pinguea cada ~3 min;
  // si no llega NADA (ni ping ni mensajes) en STALE_MS, el stream está muerto → reinicio con listenKey
  // nuevo. Además, Binance corta toda conexión a las 24h → refresh PLANEADO a las 23h (mejor elegido
  // que sorpresivo). El sweep de ExecutionService cubre el hueco residual (≤60 s) en cualquier caso.
  private lastActivityAt = 0;
  private connectedAt = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private restarting = false;
  private readonly STALE_MS = 10 * 60_000;
  private readonly PLANNED_REFRESH_MS = 23 * 60 * 60_000;

  private readonly orderUpdateSubject = new Subject<OrderTradeUpdatePayload>();
  readonly onOrderUpdate$ = this.orderUpdateSubject.asObservable();

  private readonly accountUpdateSubject =
    new Subject<AccountUpdatePayload>();
  readonly onAccountUpdate$ = this.accountUpdateSubject.asObservable();

  private readonly algoUpdateSubject = new Subject<AlgoUpdatePayload>();
  readonly onAlgoUpdate$ = this.algoUpdateSubject.asObservable();

  private readonly isDemoMode: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly binanceRest: BinanceRestService,
  ) {
    // Lenient read — see BinanceMarketWsService for rationale.
    this.wsUrl = this.config.get<string>('BINANCE_FUTURES_WS_URL', '');
    const restUrl = this.config.get<string>('BINANCE_FUTURES_BASE_URL', '');
    this.isDemoMode = restUrl.includes('demo-');
    if (this.isDemoMode) {
      this.logger.warn(
        'Demo mode detected — User Data Stream is not available. ' +
          'Order/position updates will rely on REST polling.',
      );
    }
  }

  async start(): Promise<void> {
    if (this.isDemoMode) return;
    this.destroyed = false;
    try {
      this.listenKey = await this.binanceRest.createListenKey();
      this.logger.log(`ListenKey created: ${this.listenKey.slice(0, 10)}...`);
      this.connect();
    } catch (err) {
      this.logger.error('Failed to create listenKey', err);
    }
  }

  async stop(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    if (this.listenKey) {
      try {
        await this.binanceRest.deleteListenKey();
      } catch {
        // Best-effort cleanup
      }
      this.listenKey = null;
    }
  }

  async keepalive(): Promise<void> {
    if (this.isDemoMode || !this.listenKey) return;
    try {
      await this.binanceRest.keepaliveListenKey();
      this.logger.log('ListenKey keepalive sent');
    } catch (err) {
      this.logger.error('ListenKey keepalive failed, recreating', err);
      await this.stop();
      await this.start();
    }
  }

  getListenKey(): string | null {
    return this.listenKey;
  }

  onModuleDestroy(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.stop();
  }

  private connect(): void {
    if (!this.listenKey) return;

    const url = `${this.wsUrl}/ws/${this.listenKey}`;
    this.logger.log('Connecting to User Data Stream...');

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.lastActivityAt = Date.now();
      this.connectedAt = Date.now();
      this.startWatchdog();
      this.logger.log('User Data Stream connected');
    });

    this.ws.on('message', (data: Buffer | string) => {
      this.lastActivityAt = Date.now();
      try {
        const payload = JSON.parse(data.toString());

        if (payload.e === 'ORDER_TRADE_UPDATE') {
          this.orderUpdateSubject.next(
            payload as OrderTradeUpdatePayload,
          );
        } else if (payload.e === 'ALGO_UPDATE') {
          this.algoUpdateSubject.next(
            payload as AlgoUpdatePayload,
          );
        } else if (payload.e === 'ACCOUNT_UPDATE') {
          this.accountUpdateSubject.next(
            payload as AccountUpdatePayload,
          );
        }
      } catch (err) {
        this.logger.error('Failed to parse user WS message', err);
      }
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error(`User WS error: ${err.message}`);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.logger.warn(
        `User WS closed: code=${code} reason=${reason.toString()}`,
      );
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('ping', (data: Buffer) => {
      this.lastActivityAt = Date.now();
      this.ws?.pong(data);
    });
  }

  // Vigila el stream cada 60 s: sin actividad (ni pings) por STALE_MS = zombi → reinicio completo con
  // listenKey fresco. Y refresh planeado antes del corte de 24 h de Binance.
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (this.destroyed || this.restarting || !this.ws) return;
      const idleMs = Date.now() - this.lastActivityAt;
      const ageMs = Date.now() - this.connectedAt;
      if (idleMs > this.STALE_MS) {
        this.logger.warn(
          `User WS ZOMBI: sin actividad hace ${Math.round(idleMs / 60000)} min (ni pings) — reinicio con listenKey nuevo.`,
        );
        void this.restart();
      } else if (ageMs > this.PLANNED_REFRESH_MS) {
        this.logger.log('User WS: refresh planeado (~23h, antes del corte de 24h de Binance).');
        void this.restart();
      }
    }, 60_000);
  }

  private async restart(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    try {
      await this.stop();
      await this.start();
    } catch (err) {
      this.logger.error('User WS restart falló — reintento vía scheduleReconnect', err);
      this.destroyed = false;
      this.scheduleReconnect();
    } finally {
      this.restarting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts++;
    this.logger.log(
      `Reconnecting user WS in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(async () => {
      if (this.destroyed) return;
      // Recreate listenKey on reconnect (might have expired)
      try {
        this.listenKey = await this.binanceRest.createListenKey();
        this.connect();
      } catch (err) {
        this.logger.error('Failed to recreate listenKey on reconnect', err);
        this.scheduleReconnect();
      }
    }, delay);
  }
}
