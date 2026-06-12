// Paper-trading v2 — núcleo PURO incremental (P.1). Forward-test #7 (ver docs/PAPER-TEST-SPEC.md).
//
// REGLA CERO: este módulo SOLO lee velas y registra lo que el candidato HARÍA. NO coloca/modifica/
// cancela órdenes; NO importa el write-API del exchange (un test de invarianza lo verifica). Es shadow.
//
// Reutiliza SIN cambios signal-source (genera intents del candidato congelado) y trade-simulator
// (resuelve cada posición). El motor es incremental (vela a vela) pero reproduce EXACTO el backtest:
// por cada vela CERRADA nueva, (1) detecta señales nuevas y (2) re-evalúa cada posición abierta con la
// misma lógica del simulador sobre las velas conocidas. Causal por construcción (el futuro no existe aún).

import { generateIntents, type SignalConfig } from '../backtest/signal-source';
import {
  simulateTrade,
  type SimCandle,
  type SimConfig,
  type SimTrade,
  type TradeIntent,
} from '../backtest/trade-simulator';
import type { BiasPoint } from '../backtest/htf-bias';
import type { ObCandle } from '../bot-analysis/ob.detector';

export type PaperCandle = ObCandle & { closeTime?: number };
// PENDING: señal viva, aún sin fill · FILLED: dentro de la posición · CLOSED: resuelta (con trade) o cancelada.
export type PaperState = 'PENDING' | 'FILLED' | 'CLOSED';

export interface PaperPosition {
  id: string; // = intent.id
  intent: TradeIntent;
  state: PaperState;
  trade?: SimTrade; // presente si CLOSED por fill + salida (lleva la R definitiva)
  live?: SimTrade; // FILLED: el estado provisional (fill real + "salida" endOfData al último cierre)
  cancelReason?: string; // presente si CLOSED sin trade (cancelada)
}

const toSim = (c: PaperCandle): SimCandle => ({
  openTime: c.openTime,
  high: c.high,
  low: c.low,
  close: c.close,
  closeTime: c.closeTime,
});

/**
 * Motor de paper-trading incremental y PURO (sin red, sin DB). Aliméntalo con cada vela CERRADA nueva
 * (orden ascendente) + el sesgo HTF vigente; mantiene las paper-positions del candidato y su desenlace.
 *
 * VENTANA (P.2): con `maxBufferBars > 0` el buffer se recorta para que el coste por vela no crezca
 * sin límite en un proceso 24/7. El recorte es SEGURO: nunca descarta velas necesarias para una
 * posición viva (la re-simulación escanea desde su señal). La equivalencia con el backtest
 * full-history la garantizan el test de invarianza y la verificación empírica sobre años de datos
 * reales (`verify-equivalence`). Sin ventana (default 0) el comportamiento es el de P.1: exacto.
 */
export class PaperEngine {
  private candles: PaperCandle[] = [];
  private readonly positions: PaperPosition[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly symbol: string,
    private readonly tf: string,
    private readonly signalConfig: Partial<SignalConfig> = {},
    private readonly simConfig: Partial<SimConfig> = {},
    private readonly maxBufferBars = 0, // 0 = sin recorte (P.1)
  ) {}

  /** openTime de la última vela procesada (cursor del consumidor), o null si aún no hay velas. */
  lastCandleTime(): number | null {
    return this.candles.length ? this.candles[this.candles.length - 1].openTime : null;
  }

  /** Copia del buffer actual (para instrumentación: penetraciones touched-vs-crossed). */
  bufferSnapshot(): PaperCandle[] {
    return [...this.candles];
  }

  // Recorta el buffer a maxBufferBars respetando las posiciones VIVAS: simulateTrade re-escanea
  // las velas con openTime > signalBarTime, así que solo pueden descartarse velas con
  // openTime ≤ señal-viva-más-vieja. Las CERRADAS no re-escanean: no limitan el recorte.
  private trimBuffer(): void {
    if (this.maxBufferBars <= 0 || this.candles.length <= this.maxBufferBars) return;
    let cutIdx = this.candles.length - this.maxBufferBars; // corte deseado por tamaño
    const oldestOpen = this.positions.reduce<number | null>(
      (min, p) =>
        p.state !== 'CLOSED' && (min == null || p.intent.signalBarTime < min) ? p.intent.signalBarTime : min,
      null,
    );
    if (oldestOpen != null) {
      // Máximo recorte permitido: hasta la primera vela POSTERIOR a esa señal (exclusive).
      let maxCut = 0;
      while (maxCut < this.candles.length && this.candles[maxCut].openTime <= oldestOpen) maxCut++;
      cutIdx = Math.min(cutIdx, maxCut);
    }
    if (cutIdx > 0) this.candles = this.candles.slice(cutIdx);
  }

  /** Procesa una vela cerrada nueva: registra señales nuevas y actualiza las posiciones abiertas. */
  onClosedCandle(candle: PaperCandle, htfBias: BiasPoint[] = []): void {
    this.onClosedCandles([candle], htfBias);
  }

  /**
   * Procesa un LOTE de velas cerradas (ascendentes) con UNA sola pasada de detección/simulación.
   * Determinista ⇒ los estados FINALES son idénticos a procesarlas una a una (los intents son
   * función de la serie, y la re-simulación siempre re-escanea desde la señal); solo colapsan las
   * transiciones intermedias del lote — que el consumidor ya colapsa igual. Es lo que hace viable
   * la REHIDRATACIÓN (miles de velas) en segundos.
   */
  onClosedCandles(batch: PaperCandle[], htfBias: BiasPoint[] = []): void {
    if (batch.length === 0) return;
    this.candles.push(...batch);
    // OJO: el recorte va AL FINAL (tras detectar/simular) — recortar antes perdería las señales
    // del frente de un lote grande (rehidratación). Lote y vela-a-vela quedan equivalentes.
    const sim = this.candles.map(toSim);

    // 1) Señales NUEVAS del candidato (dedup por id; causal: solo aparecen al cerrar su vela de señal).
    for (const intent of generateIntents(this.symbol, this.tf, this.candles, this.signalConfig, htfBias)) {
      if (this.seen.has(intent.id)) continue;
      this.seen.add(intent.id);
      this.positions.push({ id: intent.id, intent, state: 'PENDING' });
    }

    // 2) Re-evaluar cada posición abierta con el simulador sobre las velas conocidas.
    for (const p of this.positions) {
      if (p.state === 'CLOSED') continue;
      const res = simulateTrade(p.intent, sim, this.simConfig);
      if (res.outcome === 'filled' && res.trade) {
        if (res.trade.exitReason === 'endOfData') {
          p.state = 'FILLED'; // llenó pero aún no sale → sigue abierta
          p.live = res.trade; // estado provisional (fill real; R flotante al último cierre)
        } else {
          p.state = 'CLOSED'; // SL/TP/BE/maxHold → resuelta con su R
          p.trade = res.trade;
          p.live = undefined;
        }
      } else if (res.outcome === 'cancelled') {
        p.state = 'CLOSED'; // ranAway / invalidated / maxWaitFill / badRisk → no es trade
        p.cancelReason = res.reason;
      }
      // outcome 'expired' (noFill / noData = sin velas adelante todavía) → sin cambio: sigue PENDING.
    }

    this.trimBuffer(); // al final: las señales del lote ya se detectaron y las vivas protegen su historia
  }

  /** Posiciones aún vivas (PENDING o FILLED). */
  openPositions(): PaperPosition[] {
    return this.positions.filter((p) => p.state !== 'CLOSED');
  }

  /** Trades cerrados CON resultado (llenaron y salieron) — la muestra mecánica para la expectancy. */
  closedTrades(): SimTrade[] {
    return this.positions.filter((p) => p.state === 'CLOSED' && p.trade).map((p) => p.trade as SimTrade);
  }

  /** Todas las posiciones (para el dashboard / historial). */
  allPositions(): PaperPosition[] {
    return [...this.positions];
  }
}
