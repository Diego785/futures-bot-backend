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
  trade?: SimTrade; // presente si CLOSED por fill + salida (lleva la R)
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
 */
export class PaperEngine {
  private readonly candles: PaperCandle[] = [];
  private readonly positions: PaperPosition[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly symbol: string,
    private readonly tf: string,
    private readonly signalConfig: Partial<SignalConfig> = {},
    private readonly simConfig: Partial<SimConfig> = {},
  ) {}

  /** Procesa una vela cerrada nueva: registra señales nuevas y actualiza las posiciones abiertas. */
  onClosedCandle(candle: PaperCandle, htfBias: BiasPoint[] = []): void {
    this.candles.push(candle);
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
        } else {
          p.state = 'CLOSED'; // SL/TP/BE/maxHold → resuelta con su R
          p.trade = res.trade;
        }
      } else if (res.outcome === 'cancelled') {
        p.state = 'CLOSED'; // ranAway / invalidated / maxWaitFill / badRisk → no es trade
        p.cancelReason = res.reason;
      }
      // outcome 'expired' (noFill / noData = sin velas adelante todavía) → sin cambio: sigue PENDING.
    }
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
