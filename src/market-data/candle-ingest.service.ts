import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subscription } from 'rxjs';
import {
  IMarketDataPort,
  type CandleEvent,
} from '../exchange/interfaces/exchange.interfaces';
import { CandleRepository } from './candle.repository';
import { BackfillService } from './backfill.service';
import { toCandleRow } from './candle.mapper';

const TF_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Duración de un timeframe en ms ('15m'→900000, '1h'→3600000, '4h'→…, '1d'→…). */
export function tfToMs(tf: string): number {
  const m = tf.match(/^(\d+)([mhdw])$/);
  if (!m) throw new Error(`Timeframe inválido: ${tf}`);
  return Number(m[1]) * TF_UNIT_MS[m[2]];
}

/**
 * Punto de inicio de la reconciliación: con SOLAPE de 2 velas desde la última persistida
 * (o un lookback por defecto si no hay ninguna). El upsert idempotente absorbe el solape —
 * preferimos repetir 1-2 velas antes que perder un cierre.
 */
export function reconcileFrom(
  lastOpenTime: number | null,
  tf: string,
  now: number,
  defaultLookbackBars = 500,
): number {
  const ms = tfToMs(tf);
  return lastOpenTime != null
    ? lastOpenTime - 2 * ms
    : now - defaultLookbackBars * ms;
}

/**
 * Ingesta de velas en vivo (Fase 3, Commit 4). Persiste SOLO velas cerradas que llegan por
 * el WS (onCandleClose$ ya filtra cerradas), con symbol/tf correctos y upsert idempotente.
 * Al reconectar el WS, reconcilia por REST el hueco (BackfillService) con solape.
 * NO interpreta mercado (sin SMC, sin señales).
 *
 * Solo arranca en vivo si MARKET_DATA_LIVE=true; de lo contrario queda disponible on-demand
 * (start()/reconcile()) — así los tests/boots no se conectan al exchange por defecto.
 */
@Injectable()
export class CandleIngestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CandleIngestService.name);
  private readonly subs: Subscription[] = [];
  private readonly live: boolean;
  private readonly symbols: string[];
  private readonly timeframes: string[];
  private started = false;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;
  private readonly PERIODIC_RECONCILE_MS = 5 * 60_000;

  constructor(
    @Inject(IMarketDataPort) private readonly market: IMarketDataPort,
    private readonly repo: CandleRepository,
    private readonly backfill: BackfillService,
    private readonly config: ConfigService,
  ) {
    this.live =
      this.config.get<string>('MARKET_DATA_LIVE', 'false') === 'true';
    const symbolsRaw =
      this.config.get<string>('MARKET_DATA_SYMBOLS') ??
      this.config.get<string>('DEFAULT_SYMBOL', 'BTCUSDT');
    this.symbols = symbolsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.timeframes = this.config
      .get<string>('MARKET_DATA_TIMEFRAMES', '15m,1h,4h,1d')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async onModuleInit(): Promise<void> {
    if (!this.live) {
      this.logger.log(
        'MARKET_DATA_LIVE != true — ingest live NO arranca (disponible on-demand).',
      );
      return;
    }
    await this.start();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.logger.log(
      `Ingest start: ${this.symbols.join(',')} @ ${this.timeframes.join(',')}`,
    );

    // 1) Reconciliar el hueco desde la última corrida (con solape).
    await this.reconcileAll();

    // 2) Persistir velas cerradas en vivo (onCandleClose$ solo emite cerradas).
    this.subs.push(
      this.market.onCandleClose$.subscribe((e) => {
        void this.onClosedCandle(e);
      }),
    );

    // 3) Al reconectar el WS, reconciliar el hueco por REST (no perder cierres).
    this.subs.push(
      this.market.onReconnect$.subscribe(() => {
        this.logger.warn('WS reconectado — reconciliando huecos vía REST.');
        void this.reconcileAll();
      }),
    );

    // 4) Suscribir streams (acumulativo).
    for (const symbol of this.symbols) {
      for (const tf of this.timeframes) {
        this.market.subscribe(symbol, tf);
      }
    }

    // 5) Red de seguridad (fix 2026-08-02): reconcile periódico por REST, INDEPENDIENTE del estado
    // del WS. Antes la reconciliación solo corría al (re)conectar — si el WS moría con el circuito
    // abierto, NADIE insertaba velas y el paper quedaba ciego por horas (hallazgo 07-31: catch-up en
    // lote → intents nacidos-y-resueltos jamás emitidos al executor). Con esto, un stall del WS
    // degrada a lag ≤5 min: los lotes quedan chicos y la emisión de intents sigue viva. El upsert
    // idempotente + solape hace inocuo repetir; el peso REST es despreciable.
    this.reconcileTimer = setInterval(() => {
      if (this.reconciling) return;
      this.reconciling = true;
      void this.reconcileAll()
        .catch((e) => this.logger.warn(`reconcile periódico falló: ${e instanceof Error ? e.message : e}`))
        .finally(() => {
          this.reconciling = false;
        });
    }, this.PERIODIC_RECONCILE_MS);
  }

  private async onClosedCandle(e: CandleEvent): Promise<void> {
    try {
      await this.repo.upsertMany([toCandleRow(e.symbol, e.tf, e.candle, true)]);
    } catch (err) {
      this.logger.error(
        `Fallo al persistir vela ${e.symbol} ${e.tf} @ ${e.candle.openTime}: ${err}`,
      );
    }
  }

  async reconcileAll(): Promise<void> {
    for (const symbol of this.symbols) {
      for (const tf of this.timeframes) {
        await this.reconcile(symbol, tf);
      }
    }
  }

  /** Reconcilia (symbol, tf) por REST desde la última vela persistida con solape. */
  async reconcile(symbol: string, tf: string): Promise<void> {
    const last = await this.repo.findLastOpenTime(symbol, tf);
    const from = reconcileFrom(last, tf, Date.now());
    const { persisted, pages } = await this.backfill.backfillRange(
      symbol,
      tf,
      from,
    );
    // Solo loguear cuando se RECUPERÓ algo real (el solape re-persiste ~2 velas siempre):
    // con el reconcile periódico cada 5 min, loguear cada pasada inundaría los logs.
    if (persisted > 3 || pages > 1) {
      this.logger.log(
        `Reconcile ${symbol} ${tf}: desde ${from} (last=${last}) → ${persisted} velas, ${pages} página(s)`,
      );
    }
  }

  onModuleDestroy(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.subs.forEach((s) => s.unsubscribe());
    this.market.unsubscribe();
  }
}
