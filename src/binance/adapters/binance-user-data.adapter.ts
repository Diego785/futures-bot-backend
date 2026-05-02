import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject, type Observable, Subscription } from 'rxjs';
import { BinanceUserWsService } from '../binance-user-ws.service';
import type {
  OrderTradeUpdatePayload,
  AlgoUpdatePayload,
  AccountUpdatePayload,
} from '../../common/interfaces/binance.interfaces';
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
} from '../../exchange/interfaces/exchange.interfaces';

@Injectable()
export class BinanceUserDataAdapter
  extends IUserDataPort
  implements OnModuleDestroy
{
  readonly provider: ExchangeProvider = 'binance';

  private readonly orderUpdateSubject = new Subject<OrderUpdate>();
  private readonly conditionalUpdateSubject = new Subject<ConditionalUpdate>();
  private readonly accountUpdateSubject = new Subject<AccountUpdate>();

  readonly onOrderUpdate$: Observable<OrderUpdate> =
    this.orderUpdateSubject.asObservable();
  readonly onConditionalUpdate$: Observable<ConditionalUpdate> =
    this.conditionalUpdateSubject.asObservable();
  readonly onAccountUpdate$: Observable<AccountUpdate> =
    this.accountUpdateSubject.asObservable();

  private subs: Subscription[] = [];

  constructor(private readonly inner: BinanceUserWsService) {
    super();
    this.subs.push(
      inner.onOrderUpdate$.subscribe((p) =>
        this.orderUpdateSubject.next(mapOrderUpdate(p)),
      ),
      inner.onAlgoUpdate$.subscribe((p) =>
        this.conditionalUpdateSubject.next(mapConditionalUpdate(p)),
      ),
      inner.onAccountUpdate$.subscribe((p) =>
        this.accountUpdateSubject.next(mapAccountUpdate(p)),
      ),
    );
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }

  keepalive(): Promise<void> {
    return this.inner.keepalive();
  }

  onModuleDestroy(): void {
    for (const sub of this.subs) sub.unsubscribe();
  }
}

// ─── Mapping helpers (Binance → neutral) ───────────────────────────────────

function mapOrderUpdate(p: OrderTradeUpdatePayload): OrderUpdate {
  const o = p.o;
  return {
    eventTime: p.E,
    symbol: o.s,
    clientOrderId: o.c,
    orderId: String(o.i),
    side: o.S as OrderSide,
    positionSide: mapPositionSide(o.ps),
    orderType: mapOrderType(o.o),
    status: mapOrderStatus(o.X),
    origQty: o.q,
    cumFilledQty: o.z,
    lastFilledQty: o.l,
    lastFilledPrice: o.L,
    avgPrice: o.ap,
    origPrice: o.p,
    commission: o.n,
    commissionAsset: o.N,
    realizedPnl: o.rp,
    reduceOnly: o.R,
  };
}

function mapConditionalUpdate(p: AlgoUpdatePayload): ConditionalUpdate {
  const o = p.o;
  return {
    eventTime: p.E,
    conditionalId: String(o.aid),
    clientOrderId: o.caid,
    symbol: o.s,
    side: o.S as OrderSide,
    positionSide: mapPositionSide(o.ps),
    orderType:
      o.o === 'TAKE_PROFIT_MARKET'
        ? OrderType.TAKE_PROFIT_MARKET
        : OrderType.STOP_MARKET,
    triggerPrice: o.tp,
    quantity: o.q,
    status: mapConditionalStatus(o.X),
    reduceOnly: o.R,
    triggeredOrderId: o.ai || undefined,
    avgPrice: o.ap || undefined,
    executedQty: o.aq || undefined,
    failureReason: o.rm || undefined,
  };
}

function mapAccountUpdate(p: AccountUpdatePayload): AccountUpdate {
  return {
    eventTime: p.E,
    reason: p.a.m,
    balances: p.a.B.map((b) => ({
      asset: b.a,
      walletBalance: b.wb,
      crossWalletBalance: b.cw,
      balanceChange: b.bc,
    })),
    positions: p.a.P.map(
      (pos): PositionUpdate => ({
        eventTime: p.E,
        symbol: pos.s,
        positionSide: mapPositionSide(pos.ps),
        positionAmt: pos.pa,
        entryPrice: pos.ep,
        unrealizedPnl: pos.up,
      }),
    ),
  };
}

function mapPositionSide(s: string): PositionSide {
  switch (s) {
    case 'LONG':
      return PositionSide.LONG;
    case 'SHORT':
      return PositionSide.SHORT;
    default:
      return PositionSide.BOTH;
  }
}

function mapOrderType(t: string): OrderType {
  switch (t) {
    case 'LIMIT':
      return OrderType.LIMIT;
    case 'MARKET':
      return OrderType.MARKET;
    case 'STOP_MARKET':
      return OrderType.STOP_MARKET;
    case 'TAKE_PROFIT_MARKET':
      return OrderType.TAKE_PROFIT_MARKET;
    default:
      return OrderType.MARKET;
  }
}

function mapOrderStatus(s: string): OrderStatus {
  switch (s) {
    case 'NEW':
      return OrderStatus.NEW;
    case 'PARTIALLY_FILLED':
      return OrderStatus.PARTIALLY_FILLED;
    case 'FILLED':
      return OrderStatus.FILLED;
    case 'CANCELED':
      return OrderStatus.CANCELED;
    case 'EXPIRED':
      return OrderStatus.EXPIRED;
    case 'REJECTED':
      return OrderStatus.REJECTED;
    default:
      return OrderStatus.NEW;
  }
}

function mapConditionalStatus(s: string): ConditionalStatus {
  switch (s) {
    case 'NEW':
      return ConditionalStatus.NEW;
    case 'TRIGGERING':
      return ConditionalStatus.TRIGGERING;
    case 'TRIGGERED':
      return ConditionalStatus.TRIGGERED;
    case 'FINISHED':
      return ConditionalStatus.FINISHED;
    case 'CANCELED':
      return ConditionalStatus.CANCELED;
    case 'EXPIRED':
      return ConditionalStatus.EXPIRED;
    case 'REJECTED':
      return ConditionalStatus.REJECTED;
    default:
      return ConditionalStatus.NEW;
  }
}
