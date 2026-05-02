import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';
import * as crypto from 'crypto';
import WebSocket from 'ws';
import {
  IUserDataPort,
  OrderSide,
  PositionSide,
  OrderType,
  OrderStatus,
  ConditionalStatus,
  type ExchangeProvider,
  type OrderUpdate,
  type ConditionalUpdate,
  type AccountUpdate,
  type PositionUpdate,
} from '../exchange/interfaces/exchange.interfaces';

@Injectable()
export class BybitUserWsService
  extends IUserDataPort
  implements OnModuleDestroy
{
  private readonly logger = new Logger(BybitUserWsService.name);
  readonly provider: ExchangeProvider = 'bybit';

  private wsUrl: string;
  private apiKey!: string;
  private apiSecret!: string;
  private ws: WebSocket | null = null;
  private destroyed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private readonly INITIAL_BACKOFF_MS = 30_000;
  private readonly MAX_BACKOFF_MS = 30 * 60_000;
  private readonly MAX_CONSECUTIVE_FAILS = 10;
  private readonly PING_INTERVAL_MS = 20_000;
  private circuitOpen = false;

  private readonly orderUpdateSubject = new Subject<OrderUpdate>();
  private readonly conditionalUpdateSubject = new Subject<ConditionalUpdate>();
  private readonly accountUpdateSubject = new Subject<AccountUpdate>();

  readonly onOrderUpdate$ = this.orderUpdateSubject.asObservable();
  readonly onConditionalUpdate$ = this.conditionalUpdateSubject.asObservable();
  readonly onAccountUpdate$ = this.accountUpdateSubject.asObservable();

  constructor(private readonly config: ConfigService) {
    super();
    this.wsUrl = this.config.get<string>(
      'BYBIT_WS_PRIVATE_URL',
      'wss://stream.bybit.com/v5/private',
    );
  }

  async start(): Promise<void> {
    if (this.config.get<string>('EXCHANGE_PROVIDER') !== 'bybit') return;
    this.apiKey = this.config.getOrThrow<string>('BYBIT_API_KEY');
    this.apiSecret = this.config.getOrThrow<string>('BYBIT_API_SECRET');
    this.destroyed = false;
    this.circuitOpen = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.destroyed = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  async keepalive(): Promise<void> {
    // Bybit uses in-band auth on each connection — no ListenKey lifecycle.
    // Ping is handled by the periodic pingTimer below. Nothing to do here.
  }

  onModuleDestroy(): void {
    this.stop();
  }

  private connect(): void {
    if (this.circuitOpen) return;
    this.logger.log(`Connecting to Bybit private WS: ${this.wsUrl}`);

    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.logger.log('Bybit private WS connected — authenticating');
      this.authenticate();
    });

    this.ws.on('message', (data: Buffer | string) => {
      let payload: any;
      try {
        payload = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (payload.op === 'auth') {
        if (payload.success) {
          this.logger.log('Bybit private WS auth OK');
          this.subscribe();
          this.startPing();
          this.reconnectAttempts = 0;
        } else {
          this.logger.error(`Bybit private WS auth failed: ${payload.ret_msg}`);
          this.ws?.close();
        }
        return;
      }

      if (payload.op === 'subscribe') {
        this.logger.log(`Subscription ack: ${payload.ret_msg ?? 'OK'}`);
        return;
      }

      if (payload.op === 'pong') return;

      if (!payload.topic) return;

      try {
        switch (payload.topic) {
          case 'order':
            for (const o of payload.data ?? []) {
              if (o.stopOrderType && o.stopOrderType !== '') {
                this.conditionalUpdateSubject.next(mapConditionalUpdate(o));
              } else {
                this.orderUpdateSubject.next(mapOrderUpdate(o));
              }
            }
            break;
          case 'wallet':
            for (const w of payload.data ?? []) {
              this.accountUpdateSubject.next(mapAccountUpdateFromWallet(w));
            }
            break;
          case 'position':
            // Bybit emits position separately. Combine into AccountUpdate-shape
            // event so consumers can handle uniformly.
            this.accountUpdateSubject.next(
              mapAccountUpdateFromPositions(payload.data ?? []),
            );
            break;
          default:
            // Unhandled topic — ignore silently.
            break;
        }
      } catch (err: any) {
        this.logger.error(
          `Failed to map Bybit private WS message: ${err?.message ?? err}`,
        );
      }
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error(`Bybit private WS error: ${err.message}`);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.logger.warn(
        `Bybit private WS closed: code=${code} reason=${reason.toString()}`,
      );
      this.stopPing();
      if (!this.destroyed) this.scheduleReconnect();
    });
  }

  private authenticate(): void {
    if (!this.ws) return;
    const expires = Date.now() + 10_000;
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(`GET/realtime${expires}`)
      .digest('hex');
    this.ws.send(
      JSON.stringify({
        op: 'auth',
        args: [this.apiKey, expires, signature],
      }),
    );
  }

  private subscribe(): void {
    if (!this.ws) return;
    this.ws.send(
      JSON.stringify({
        op: 'subscribe',
        args: ['order', 'wallet', 'position'],
      }),
    );
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

  private scheduleReconnect(): void {
    if (this.destroyed) return;

    if (this.reconnectAttempts >= this.MAX_CONSECUTIVE_FAILS) {
      this.circuitOpen = true;
      this.logger.error(
        `Bybit private WS reached ${this.MAX_CONSECUTIVE_FAILS} consecutive failures — opening circuit.`,
      );
      return;
    }

    const delay = Math.min(
      this.INITIAL_BACKOFF_MS * Math.pow(2, this.reconnectAttempts),
      this.MAX_BACKOFF_MS,
    );
    this.reconnectAttempts++;
    this.logger.log(
      `Reconnecting Bybit private WS in ${delay}ms (attempt ${this.reconnectAttempts}/${this.MAX_CONSECUTIVE_FAILS})`,
    );

    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed) this.connect();
    }, delay);
  }
}

// ─── Mapping helpers ────────────────────────────────────────────────────────

function mapOrderUpdate(o: any): OrderUpdate {
  return {
    eventTime: parseInt(o.updatedTime ?? Date.now().toString(), 10),
    symbol: o.symbol,
    clientOrderId: o.orderLinkId ?? '',
    orderId: o.orderId ?? '',
    side: o.side === 'Buy' ? OrderSide.BUY : OrderSide.SELL,
    positionSide: PositionSide.BOTH,
    orderType: o.orderType === 'Limit' ? OrderType.LIMIT : OrderType.MARKET,
    status: mapBybitOrderStatus(o.orderStatus),
    origQty: o.qty ?? '0',
    cumFilledQty: o.cumExecQty ?? '0',
    lastFilledQty: o.lastExecQty ?? o.cumExecQty ?? '0',
    lastFilledPrice: o.lastExecPrice ?? o.avgPrice ?? '0',
    avgPrice: o.avgPrice ?? '0',
    origPrice: o.price ?? '0',
    commission: o.cumExecFee ?? o.execFee ?? '0',
    commissionAsset: o.feeCurrency ?? 'USDT',
    realizedPnl: o.closedPnl ?? '0',
    reduceOnly: !!o.reduceOnly,
  };
}

function mapConditionalUpdate(o: any): ConditionalUpdate {
  const orderType =
    o.stopOrderType === 'TakeProfit'
      ? OrderType.TAKE_PROFIT_MARKET
      : OrderType.STOP_MARKET;
  return {
    eventTime: parseInt(o.updatedTime ?? Date.now().toString(), 10),
    conditionalId: o.orderId ?? '',
    clientOrderId: o.orderLinkId ?? '',
    symbol: o.symbol,
    side: o.side === 'Buy' ? OrderSide.BUY : OrderSide.SELL,
    positionSide: PositionSide.BOTH,
    orderType,
    triggerPrice: o.triggerPrice ?? '0',
    quantity: o.qty ?? '0',
    status: mapBybitConditionalStatus(o.orderStatus),
    reduceOnly: !!o.reduceOnly,
    triggeredOrderId: o.orderId,
    avgPrice: o.avgPrice ?? '0',
    executedQty: o.cumExecQty ?? '0',
    failureReason: o.rejectReason || undefined,
  };
}

function mapAccountUpdateFromWallet(w: any): AccountUpdate {
  return {
    eventTime: Date.now(),
    reason: 'WALLET_UPDATE',
    balances: (w.coin ?? []).map((c: any) => ({
      asset: c.coin,
      walletBalance: c.walletBalance ?? '0',
      crossWalletBalance: c.equity ?? c.walletBalance ?? '0',
      balanceChange: '0',
    })),
    positions: [],
  };
}

function mapAccountUpdateFromPositions(positions: any[]): AccountUpdate {
  return {
    eventTime: Date.now(),
    reason: 'POSITION_UPDATE',
    balances: [],
    positions: positions.map(
      (p): PositionUpdate => ({
        eventTime: Date.now(),
        symbol: p.symbol,
        positionSide:
          p.side === 'Buy'
            ? PositionSide.LONG
            : p.side === 'Sell'
              ? PositionSide.SHORT
              : PositionSide.BOTH,
        positionAmt: p.side === 'Sell' ? `-${p.size}` : p.size ?? '0',
        entryPrice: p.entryPrice ?? '0',
        unrealizedPnl: p.unrealisedPnl ?? '0',
      }),
    ),
  };
}

function mapBybitOrderStatus(s: string): OrderStatus {
  switch (s) {
    case 'New':
    case 'Created':
      return OrderStatus.NEW;
    case 'PartiallyFilled':
      return OrderStatus.PARTIALLY_FILLED;
    case 'Filled':
      return OrderStatus.FILLED;
    case 'Cancelled':
    case 'Deactivated':
      return OrderStatus.CANCELED;
    case 'Rejected':
      return OrderStatus.REJECTED;
    default:
      return OrderStatus.NEW;
  }
}

function mapBybitConditionalStatus(s: string): ConditionalStatus {
  switch (s) {
    case 'New':
    case 'Untriggered':
    case 'Created':
      return ConditionalStatus.NEW;
    case 'Triggered':
      return ConditionalStatus.TRIGGERED;
    case 'Filled':
      return ConditionalStatus.FINISHED;
    case 'Cancelled':
    case 'Deactivated':
      return ConditionalStatus.CANCELED;
    case 'Rejected':
      return ConditionalStatus.REJECTED;
    default:
      return ConditionalStatus.NEW;
  }
}
