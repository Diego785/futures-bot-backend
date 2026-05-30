import {
  Inject,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  type OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Subscription } from 'rxjs';
import { IMarketDataPort } from '../exchange/interfaces/exchange.interfaces';
import { rawToCandleDto } from './candle.presenter';

export type MarketStatus = 'OFFLINE' | 'LIVE' | 'STALE' | 'RECONNECTING';

/** Room por (symbol, tf) para velas; room por símbolo para price ticks. */
export function roomFor(symbol: string, tf: string): string {
  return `c:${symbol}:${tf}`;
}
export function symbolRoom(symbol: string): string {
  return `p:${symbol}`;
}

/** Estado de mercado en función de si hay live y de la antigüedad del último dato. */
export function computeStatus(
  live: boolean,
  lastDataAt: number | null,
  now: number,
  staleMs: number,
): MarketStatus {
  if (!live) return 'OFFLINE';
  if (lastDataAt == null) return 'STALE';
  return now - lastDataAt <= staleMs ? 'LIVE' : 'STALE';
}

interface SubPayload {
  symbol: string;
  tf: string;
}

/**
 * Gateway READ-ONLY de market data en vivo (Socket.IO, namespace /market). Reenvía a los
 * clientes (por rooms symbol/tf) los eventos del puerto: price.tick, candle.live_update,
 * candle.closed y market.status. No coloca órdenes ni usa credenciales privadas.
 *
 * Live solo si MARKET_DATA_LIVE=true (si no, market.status=OFFLINE y no hay eventos).
 */
@WebSocketGateway({ namespace: '/market', cors: { origin: true } })
export class MarketDataGateway
  implements OnGatewayInit, OnGatewayConnection, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(MarketDataGateway.name);
  private readonly subs: Subscription[] = [];
  private readonly live: boolean;
  private readonly STALE_MS = 30_000;
  private readonly RECONNECTING_GRACE_MS = 15_000;
  private lastDataAt: number | null = null;
  private reconnectingUntil = 0;
  private status: MarketStatus;
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  @WebSocketServer()
  server!: Server;

  constructor(
    @Inject(IMarketDataPort) private readonly market: IMarketDataPort,
    private readonly config: ConfigService,
  ) {
    this.live = this.config.get<string>('MARKET_DATA_LIVE', 'false') === 'true';
    this.status = this.live ? 'STALE' : 'OFFLINE';
  }

  afterInit(): void {
    this.logger.log(
      `Market data gateway (/market) initialized — live=${this.live}`,
    );
  }

  onModuleInit(): void {
    if (!this.live) return; // sin live, no hay nada que reenviar

    this.subs.push(
      this.market.onPrice$.subscribe(({ symbol, price }) => {
        this.markData();
        this.server?.to(symbolRoom(symbol)).emit('price.tick', {
          symbol,
          price,
          t: Date.now(),
        });
      }),
    );
    this.subs.push(
      this.market.onCandleUpdate$.subscribe(({ symbol, tf, candle }) => {
        this.markData();
        this.server
          ?.to(roomFor(symbol, tf))
          .emit('candle.live_update', rawToCandleDto(symbol, tf, candle, false));
      }),
    );
    this.subs.push(
      this.market.onCandleClose$.subscribe(({ symbol, tf, candle }) => {
        this.markData();
        this.server
          ?.to(roomFor(symbol, tf))
          .emit('candle.closed', rawToCandleDto(symbol, tf, candle, true));
      }),
    );
    this.subs.push(
      this.market.onReconnect$.subscribe(() => {
        this.reconnectingUntil = Date.now() + this.RECONNECTING_GRACE_MS;
        this.setStatus('RECONNECTING');
      }),
    );

    this.statusTimer = setInterval(() => this.refreshStatus(), 5_000);
  }

  handleConnection(client: Socket): void {
    client.emit('market.status', { status: this.status, lastDataAt: this.lastDataAt });
  }

  @SubscribeMessage('subscribe')
  onSubscribe(client: Socket, payload: SubPayload): void {
    if (!payload?.symbol || !payload?.tf) return;
    client.join(symbolRoom(payload.symbol));
    client.join(roomFor(payload.symbol, payload.tf));
    // Asegura el stream en el exchange (acumulativo, idempotente) cuando hay live.
    if (this.live) this.market.subscribe(payload.symbol, payload.tf);
    client.emit('market.status', { status: this.status, lastDataAt: this.lastDataAt });
  }

  @SubscribeMessage('unsubscribe')
  onUnsubscribe(client: Socket, payload: SubPayload): void {
    if (!payload?.symbol || !payload?.tf) return;
    client.leave(roomFor(payload.symbol, payload.tf));
    client.leave(symbolRoom(payload.symbol));
  }

  private markData(): void {
    this.lastDataAt = Date.now();
    if (this.reconnectingUntil <= Date.now() && this.status !== 'LIVE') {
      this.setStatus('LIVE');
    }
  }

  private refreshStatus(): void {
    if (this.reconnectingUntil > Date.now()) return; // respeta la ventana de reconexión
    this.setStatus(computeStatus(this.live, this.lastDataAt, Date.now(), this.STALE_MS));
  }

  private setStatus(next: MarketStatus): void {
    if (next === this.status) return;
    this.status = next;
    this.server?.emit('market.status', { status: next, lastDataAt: this.lastDataAt });
    this.logger.log(`market.status → ${next}`);
  }

  onModuleDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    if (this.statusTimer) clearInterval(this.statusTimer);
  }
}
