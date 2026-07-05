// P.2 — PAPER-TRADING LIVE (gate #7, PAPER-TEST-SPEC). REGLA CERO: shadow READ-ONLY — lee velas
// CERRADAS de NUESTRA DB, registra lo que el candidato CONGELADO haría y lo persiste/emite.
// Jamás coloca/modifica/cancela órdenes (el test de invarianza estructural vigila este módulo).
//
// Arquitectura: la DB es la cola ordenada (el ingest persiste y reconcilia huecos); este servicio
// mantiene un CURSOR por símbolo y drena las velas nuevas — el tick del WS solo "despierta", de modo
// que huecos reconciliados por REST nunca se pierden y la REHIDRATACIÓN tras un reinicio es el mismo
// código (drenar desde la ventana). Determinista: mismas velas → mismas señales que el backtest.

import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execSync } from 'child_process';
import { Subject, Subscription } from 'rxjs';
import { IMarketDataPort } from '../exchange/interfaces/exchange.interfaces';
import type { TradeIntent } from '../backtest/trade-simulator';
import { CandleRepository } from '../market-data/candle.repository';
import { computeHtfBias, type BiasPoint } from '../backtest/htf-bias';
import { makeParamsHash } from '../backtest/register.mapper';
import { PaperEngine, type PaperCandle, type PaperPosition } from './paper-engine';
import { PaperTradeRepository } from './paper-trade.repository';
import { toPaperTradeRow, type PaperTradeRow } from './paper-row.mapper';
import { PaperTradingGateway } from './paper-trading.gateway';
import { FROZEN_SIGNAL, FROZEN_SIM, PAPER_HTF, PAPER_TF, PAPER_WINDOW_BARS } from './frozen-candidate';

interface SymbolState {
  engine: PaperEngine;
  cursor: number; // openTime de la última vela 15m procesada
  bias: BiasPoint[];
  last4h: number | null; // openTime de la última vela 4h vista (para refrescar el bias)
  prev: Map<string, string>; // intentId → firma de estado (diff para persistir/emitir solo cambios)
  paramsHash: string;
}

// v2: el fill del TP1 (parcial) también es una transición persistible/emitible (cambia la fila).
const stateSig = (p: PaperPosition): string =>
  `${p.state}:${p.trade?.exitReason ?? ''}:${p.cancelReason ?? ''}:${(p.trade ?? p.live)?.tp1Filled ? '1' : '0'}`;

@Injectable()
export class PaperTradingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaperTradingService.name);
  private readonly enabled: boolean;
  private readonly symbols: string[];
  private readonly engineVersion: string;
  private readonly clockStart: number; // arranque del reloj del gate (epoch ms); MAX = no arrancó
  private readonly states = new Map<string, SymbolState>();
  private readonly draining = new Set<string>();
  private readonly subs: Subscription[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private live = false; // false durante la rehidratación (no se emiten eventos del pasado)

  // Hooks READ-ONLY para la capa de ejecución (P.5.3, módulo APARTE): emiten el intent nuevo (la
  // decisión del candidato de entrar) y la cancelación. NO tocan órdenes — la Regla Cero del paper
  // sigue intacta (el test de invarianza estructural no halla write-API aquí); el executor, en otro
  // módulo, se suscribe y actúa. Solo emiten en vivo (jamás durante la rehidratación del pasado).
  private readonly liveIntent$ = new Subject<TradeIntent>();
  private readonly liveCancel$ = new Subject<string>();
  readonly onLiveIntent$ = this.liveIntent$.asObservable();
  readonly onLiveCancel$ = this.liveCancel$.asObservable();

  constructor(
    private readonly candles: CandleRepository,
    private readonly trades: PaperTradeRepository,
    private readonly config: ConfigService,
    @Optional() private readonly gateway: PaperTradingGateway | null,
    @Optional() @Inject(IMarketDataPort) private readonly market: IMarketDataPort | null,
  ) {
    this.enabled = this.config.get<string>('PAPER_TRADING', 'false') === 'true';
    const raw = this.config.get<string>('MARKET_DATA_SYMBOLS') ?? this.config.get<string>('DEFAULT_SYMBOL', 'BTCUSDT');
    this.symbols = raw.split(',').map((s) => s.trim()).filter(Boolean);
    let version = this.config.get<string>('BUILD_VERSION', '');
    if (!version) {
      try {
        version = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      } catch {
        version = 'unknown';
      }
    }
    this.engineVersion = version;

    // Reloj del gate: sin PAPER_CLOCK_START, NADA es 'live' (todo es histórico/contexto) — el deploy
    // debe fijarlo para encender el forward-test limpio. Acepta fecha ISO o epoch ms.
    const raw2 = this.config.get<string>('PAPER_CLOCK_START', '');
    let cs = Number.MAX_SAFE_INTEGER;
    if (raw2) {
      const asNum = Number(raw2);
      const ms = Number.isFinite(asNum) && asNum > 1e11 ? asNum : Date.parse(raw2);
      if (Number.isFinite(ms)) cs = ms;
      else this.logger.warn(`PAPER_CLOCK_START inválido ('${raw2}') — el reloj NO arranca (todo backfill).`);
    }
    this.clockStart = cs;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('PAPER_TRADING != true — paper-trading NO arranca.');
      return;
    }
    this.logger.log(`Paper-trading (shadow, Regla Cero) arrancando: ${this.symbols.join(',')} @ ${PAPER_TF}+${PAPER_HTF}`);
    await this.rehydrate();
    this.live = true;

    // Despertadores: cierre de vela de nuestros símbolos (reactivo) + timer de respaldo (huecos
    // reconciliados por REST sin tick). El dren siempre lee la DB → nada se pierde.
    if (this.market) {
      this.subs.push(
        this.market.onCandleClose$.subscribe(({ symbol, tf }) => {
          if ((tf === PAPER_TF || tf === PAPER_HTF) && this.states.has(symbol)) void this.drain(symbol);
        }),
      );
    }
    this.timer = setInterval(() => void this.drainAll(), 60_000);
  }

  /** Reconstrucción tras reinicio: ventana de velas desde DB (ampliada hasta cubrir la señal viva
   *  más vieja persistida) → el engine re-deriva TODO determinísticamente; el upsert idempotente
   *  absorbe lo ya registrado y NADA se emite por WS (fase replay). */
  private async rehydrate(): Promise<void> {
    for (const symbol of this.symbols) {
      const paramsHash = makeParamsHash({
        symbol,
        tf: PAPER_TF,
        signal: FROZEN_SIGNAL,
        sim: FROZEN_SIM,
        htf: PAPER_HTF,
        htf2: null,
      });
      const engine = new PaperEngine(symbol, PAPER_TF, FROZEN_SIGNAL, FROZEN_SIM, PAPER_WINDOW_BARS);
      const st: SymbolState = { engine, cursor: 0, bias: [], last4h: null, prev: new Map(), paramsHash };
      this.states.set(symbol, st);

      await this.refreshBias(symbol, st);

      // Ventana: las últimas PAPER_WINDOW_BARS velas o desde la señal viva más vieja (lo más viejo).
      const recent = await this.candles.findCandles({ symbol, tf: PAPER_TF, limit: PAPER_WINDOW_BARS });
      let fromTime = recent.length ? recent[0].openTime : 0;
      const oldestOpen = await this.trades.oldestOpenSignalTime(symbol);
      if (oldestOpen != null && oldestOpen < fromTime) fromTime = oldestOpen;
      if (recent.length === 0) {
        this.logger.warn(`${symbol}: sin velas ${PAPER_TF} en DB — esperando ingest/backfill.`);
        continue;
      }
      st.cursor = fromTime - 1;
      await this.drain(symbol); // la rehidratación ES un dren desde la ventana (mismo código)
      this.logger.log(
        `${symbol}: rehidratado (cursor=${st.cursor}, abiertas=${engine.openPositions().length}, hash=${paramsHash})`,
      );
    }
  }

  private async refreshBias(symbol: string, st: SymbolState): Promise<void> {
    const h4 = await this.candles.findCandles({ symbol, tf: PAPER_HTF, from: 0, limit: 20_000 });
    const closed = h4.filter((c) => c.isClosed);
    st.bias = computeHtfBias(
      closed.map((c) => ({ openTime: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close, closeTime: c.closeTime })),
      FROZEN_SIGNAL.swingLookback,
    );
    st.last4h = closed.length ? closed[closed.length - 1].openTime : null;
  }

  async drainAll(): Promise<void> {
    for (const symbol of this.states.keys()) await this.drain(symbol);
  }

  /** Drena las velas 15m nuevas (cursor → ∞) alimentando el engine; persiste/emite SOLO cambios. */
  async drain(symbol: string): Promise<void> {
    const st = this.states.get(symbol);
    if (!st || this.draining.has(symbol)) return;
    this.draining.add(symbol);
    try {
      // ¿Cerró una 4h nueva? → refrescar la serie de bias (biasAt es causal por tiempo: pasar la
      // serie completa siempre es correcto, igual que en el backtest).
      const last4h = await this.candles.findLastOpenTime(symbol, PAPER_HTF);
      if (last4h != null && last4h !== st.last4h) await this.refreshBias(symbol, st);

      for (;;) {
        const rows = await this.candles.findCandles({ symbol, tf: PAPER_TF, cursor: st.cursor, limit: 500 });
        const closed = rows.filter((c) => c.isClosed);
        if (closed.length === 0) break;
        const changes: PaperTradeRow[] = [];
        const batch: PaperCandle[] = closed.map((c) => ({
          openTime: c.openTime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          closeTime: c.closeTime,
        }));
        st.engine.onClosedCandles(batch, st.bias); // lote: 1 pasada (rehidratación viable); en vivo el lote es de 1
        st.cursor = batch[batch.length - 1].openTime;
        // Diff de estados tras el lote (las transiciones intermedias del lote colapsan al final —
        // el desenlace es idéntico al del backtest; el lote >1 solo ocurre en rehidratación/huecos).
        const now = Date.now();
        const buffer = st.engine.bufferSnapshot(); // para las penetraciones touched-vs-crossed
        for (const p of st.engine.allPositions()) {
          const sig = stateSig(p);
          if (st.prev.get(p.id) !== sig) {
            const wasKnown = st.prev.has(p.id);
            st.prev.set(p.id, sig);
            const row = toPaperTradeRow(p, buffer, this.engineVersion, st.paramsHash, now, this.clockStart);
            // SOLO el forward-test real (live) se persiste/emite. El histórico rehidratado es CONTEXTO:
            // vive solo en el motor (para continuidad) y NUNCA ensucia el historial del paper — el
            // pasado se audita en Backtests. (El reloj NO arrancado ⇒ todo backfill ⇒ no se guarda nada.)
            if (row.phase === 'live') {
              changes.push(row);
              // Hooks de ejecución (solo en vivo): intent NUEVO aún PENDING → el executor coloca la
              // límite · cancelación → el executor retira la límite si sigue resting. El executor
              // ignora lo que no tenga en vuelo, así que emitir de más es inocuo.
              if (this.live) {
                if (!wasKnown && p.state === 'PENDING') this.liveIntent$.next(p.intent);
                else if (p.state === 'CLOSED' && p.cancelReason) this.liveCancel$.next(p.id);
              }
            }
          }
        }
        if (changes.length > 0) {
          await this.trades.upsertMany(changes);
          if (this.live && this.gateway) for (const row of changes) this.gateway.emitPosition(row);
        }
        if (closed.length < 500) break;
      }
    } catch (err) {
      this.logger.error(`drain(${symbol}) falló: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.draining.delete(symbol);
    }
  }

  /** Resumen para /api/paper/status. clockStart=null si el reloj del gate aún no arrancó. */
  status(): {
    enabled: boolean;
    engineVersion: string;
    clockStart: number | null;
    symbols: { symbol: string; cursor: number; open: number; paramsHash: string }[];
  } {
    return {
      enabled: this.enabled,
      engineVersion: this.engineVersion,
      clockStart: this.clockStart >= Number.MAX_SAFE_INTEGER ? null : this.clockStart,
      symbols: [...this.states.entries()].map(([symbol, st]) => ({
        symbol,
        cursor: st.cursor,
        open: st.engine.openPositions().length,
        paramsHash: st.paramsHash,
      })),
    };
  }

  onModuleDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    if (this.timer) clearInterval(this.timer);
    this.liveIntent$.complete();
    this.liveCancel$.complete();
  }
}
