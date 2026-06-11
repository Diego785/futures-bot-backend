// Motor de backtest v2 — SIMULADOR de un trade (núcleo PURO, en R). Fase C.1.
//
// Regla Cero: esto SIMULA sobre histórico; NO coloca/modifica/cancela ninguna orden real. Mide el
// EDGE de un gatillo en múltiplos de riesgo (R), neto de costes. Sin USD, sin quantity: todo se
// normaliza por el riesgo inicial |entry − SL|, así el tamaño de posición es irrelevante para la R.
//
// Causalidad (NO-REPAINT-RULES): la señal se conoce al CIERRE de `signalBarTime`; la orden se
// "coloca" para la vela SIGUIENTE. El simulador solo mira velas con openTime > signalBarTime.
//
// Decisiones de modelado (conservadoras y EXPLÍCITAS) — el sesgo intrabar es donde los backtests
// MIENTEN, así que elegimos siempre el lado pesimista y lo dejamos documentado:
//   1. FILL de límite: la vela alcanza el precio (low≤entry en LONG / high≥entry en SHORT); el fill
//      manda intrabar — si el precio tocó tu límite estás dentro, no se "descancela" porque la vela
//      cierre mal (por eso la invalidación por cuerpo casi nunca dispara ANTES del fill; ver abajo).
//   2. SL y TP en la MISMA vela tras el fill → se asume SL primero (`pessimisticSameBar`, default true).
//   3. Break-even: el SL se mueve a entrada (+buffer que cubre el coste round-trip, para que un stop
//      en BE rinda ≈ 0R) al alcanzar `breakevenAtTpFraction` del recorrido a TP; el movimiento surte
//      efecto en la vela SIGUIENTE (no reordenamos intrabar a nuestro favor).
//   4. Costes: fee taker por lado (sobre el nocional) + slippage adverso por lado, plegados en los
//      precios efectivos de entrada/salida. "Si solo es rentable con costes cero, no es rentable."
//   5. Cancelación (V2 "ni ganaste ni perdiste"): si la pendiente no llena y el precio se ALEJA
//      (`cancelBeyond`) o el POI se invalida por cuerpo (`invalidationPrice`) o EXPIRA
//      (`maxWaitFillBars`) → NO es trade (cuenta en el denominador del fill-rate, no en la expectancy).
//
// Concurrencia: cada intent se simula de forma INDEPENDIENTE contra la línea de velas (event-study).
// Mide el edge puro del gatillo (máx. N). El modelado secuencial de una sola cuenta (cooldown,
// maxDD real de balance) es un refinamiento posterior para la decisión de autonomía (Fase F).

export type TradeDirection = 'LONG' | 'SHORT';

// Vela de EJECUCIÓN (donde se evalúan fills/SL/TP). `open` no se usa; `closeTime` opcional (si falta,
// los tiempos de salida se anclan a openTime — el modelo canónico ancla la causalidad al cierre).
export interface SimCandle {
  openTime: number;
  high: number;
  low: number;
  close: number;
  closeTime?: number;
}

// Contexto CAUSAL de la señal (de dónde salió la zona): lo registra el visor/paper para explicar el
// PORQUÉ de cada entrada sin re-derivar. El simulador NO lo usa para nada.
export interface IntentContext {
  zoneLow: number; // zona de la reacción (sweep) o del OB
  zoneHigh: number;
  sweptLevel?: number; // gatillo C: nivel barrido (la liquidez tomada)
  wickExtreme?: number; // gatillo C: extremo de la mecha del sweep
  sweptSwingTime?: number; // gatillo C: openTime de la vela del swing barrido
}

// Intención de trade emitida por el generador de señales (gatillo A/B/C). Precios ABSOLUTOS.
export interface TradeIntent {
  id: string;
  symbol: string;
  tf: string; // TF de EJECUCIÓN
  direction: TradeDirection;
  signalBarTime: number; // openTime de la vela cuyo CIERRE generó la señal (la ejecución va después)
  entry: number; // precio límite (CE del OB usado)
  stopLoss: number; // SL inicial
  takeProfit: number; // TP
  invalidationPrice?: number; // pendiente: si el cuerpo CIERRA más allá (en contra) → cancelar
  cancelBeyond?: number; // pendiente: si el precio se ALEJA hasta aquí sin fill → cancelar (se fue sin nosotros)
  context?: IntentContext; // porqué causal (visor/paper); ignorado por el simulador
}

export interface SimConfig {
  feeRatePerSide: number; // fee fraccional por lado si NO se usa maker/taker (ej. 0.0005 = 0.05 %)
  // Fees maker/taker diferenciados (opcional): si AMBOS están definidos, la entrada (límite) paga
  // maker, y la salida paga maker si es TP (límite) o taker si es SL/BE/maxHold/endOfData (stop-market).
  // Más realista que una tarifa única. Si falta alguno, se usa feeRatePerSide en ambos lados.
  makerFee?: number; // ej. 0.0002 (0.02 %)
  takerFee?: number; // ej. 0.0005 (0.05 %)
  slippagePerSide: number; // slippage adverso en PRECIO por lado (entrada y salida)
  breakevenAtTpFraction: number; // mover SL→entrada al alcanzar esta fracción del recorrido a TP (0.5 = 50 %)
  maxWaitFillBars: number; // cancelar pendiente si no llena en N velas (0 = sin límite)
  maxHoldBars: number; // cerrar a mercado si sigue abierta tras N velas (0 = sin límite)
  pessimisticSameBar: boolean; // SL y TP en la misma vela → asumir SL primero (true = conservador)
}

// Defaults provisionales 🔴. feeRatePerSide ~0.05 % = taker Binance/Bitget futures (ver doc §6).
export const DEFAULT_SIM_CONFIG: SimConfig = {
  feeRatePerSide: 0.0005,
  slippagePerSide: 0,
  breakevenAtTpFraction: 0.5,
  maxWaitFillBars: 0,
  maxHoldBars: 0,
  pessimisticSameBar: true,
};

export type SimOutcome = 'filled' | 'cancelled' | 'expired';
export type ExitReason = 'SL' | 'TP' | 'BE' | 'maxHold' | 'endOfData';
export type SimReason = 'ranAway' | 'invalidated' | 'maxWaitFill' | 'badRisk' | 'noData' | 'noFill';

export interface SimTrade {
  id: string;
  symbol: string;
  tf: string;
  direction: TradeDirection;
  signalBarTime: number;
  entryTime: number;
  entryPrice: number; // fill efectivo (con slippage)
  exitTime: number;
  exitPrice: number; // fill efectivo (con slippage)
  exitReason: ExitReason;
  stopLoss: number; // SL INICIAL (no muta con el BE)
  takeProfit: number;
  grossR: number; // R nominal (sin costes): ((exitLevel − entry)·sign) / risk
  costR: number; // drag total por fees + slippage (grossR − rMultiple)
  rMultiple: number; // R NETA (lo que importa)
  barsToFill: number; // velas desde la colocación hasta el fill (0 = primera vela elegible)
  barsHeld: number; // velas en posición (incluye la de salida)
  movedToBE: boolean;
}

export interface SimResult {
  intentId: string;
  outcome: SimOutcome;
  reason?: SimReason; // por qué se canceló/expiró (solo si no llenó)
  endTime?: number; // cuándo se decidió la cancelación/expiración (closeTime de esa vela) — informativo
  // para el replay causal del visor; NO afecta la mecánica. Ausente en badRisk/noData (nunca vivió).
  trade?: SimTrade; // presente solo si outcome === 'filled'
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Simula UN trade candidato contra la línea de velas de ejecución (causal, conservador).
 * Devuelve el resultado: 'filled' (con el trade y su R neta), 'cancelled' (la pendiente se canceló)
 * o 'expired' (nunca llenó / sin datos). Ver cabecera para las decisiones de modelado.
 */
export function simulateTrade(
  intent: TradeIntent,
  candles: SimCandle[],
  config: Partial<SimConfig> = {},
): SimResult {
  const cfg: SimConfig = { ...DEFAULT_SIM_CONFIG, ...config };
  const sign = intent.direction === 'LONG' ? 1 : -1;
  const risk = Math.abs(intent.entry - intent.stopLoss);
  if (risk <= 0) return { intentId: intent.id, outcome: 'cancelled', reason: 'badRisk' };

  // Primera vela EJECUTABLE: estrictamente posterior al cierre de la vela de señal (lookahead = 0).
  let start = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].openTime > intent.signalBarTime) {
      start = i;
      break;
    }
  }
  if (start === -1) return { intentId: intent.id, outcome: 'expired', reason: 'noData' };

  // Resolución de fees: maker/taker diferenciados si ambos están definidos, si no tarifa única.
  const useMt = cfg.makerFee != null && cfg.takerFee != null;
  const feeEntry = useMt ? (cfg.makerFee as number) : cfg.feeRatePerSide; // entrada = límite (maker)
  const feeExitTaker = useMt ? (cfg.takerFee as number) : cfg.feeRatePerSide;
  const feeExitMaker = useMt ? (cfg.makerFee as number) : cfg.feeRatePerSide;

  // Buffer del BE en precio: compensa el coste round-trip (entrada maker + salida taker, que es el
  // caso de un stop en BE) para que ese stop rinda ≈ 0R.
  const beBufferPrice = 2 * cfg.slippagePerSide + intent.entry * (feeEntry + feeExitTaker);

  let filled = false;
  let entryFill = 0;
  let entryTime = 0;
  let barsToFill = 0;
  let sl = intent.stopLoss;
  let movedToBE = false;
  let barsHeld = 0;

  // Cierra el trade en `exitLevel` y devuelve la R neta de costes (slippage plegado en los fills).
  const finishTrade = (exitLevel: number, exitTime: number, reason: ExitReason): SimResult => {
    const exitFill = exitLevel - sign * cfg.slippagePerSide; // salida adversa
    const nominalGross = ((exitLevel - intent.entry) * sign) / risk;
    const feeExit = reason === 'TP' ? feeExitMaker : feeExitTaker; // TP=límite maker; SL/BE/etc=stop taker
    const netPrice = (exitFill - entryFill) * sign - entryFill * feeEntry - exitFill * feeExit;
    const netR = netPrice / risk;
    return {
      intentId: intent.id,
      outcome: 'filled',
      trade: {
        id: intent.id,
        symbol: intent.symbol,
        tf: intent.tf,
        direction: intent.direction,
        signalBarTime: intent.signalBarTime,
        entryTime,
        entryPrice: round4(entryFill),
        exitTime,
        exitPrice: round4(exitFill),
        exitReason: reason,
        stopLoss: intent.stopLoss,
        takeProfit: intent.takeProfit,
        grossR: round4(nominalGross),
        costR: round4(nominalGross - netR),
        rMultiple: round4(netR),
        barsToFill,
        barsHeld,
        movedToBE,
      },
    };
  };

  for (let b = start; b < candles.length; b++) {
    const c = candles[b];
    const ct = c.closeTime ?? c.openTime;

    if (!filled) {
      const offset = b - start;
      if (cfg.maxWaitFillBars > 0 && offset >= cfg.maxWaitFillBars) {
        return { intentId: intent.id, outcome: 'cancelled', reason: 'maxWaitFill', endTime: ct };
      }
      const hitEntry = intent.direction === 'LONG' ? c.low <= intent.entry : c.high >= intent.entry;
      if (hitEntry) {
        filled = true;
        entryFill = intent.entry + sign * cfg.slippagePerSide; // entrada adversa
        entryTime = c.openTime;
        barsToFill = offset;
        // cae al bloque de posición abierta en ESTA misma vela (un knife puede llenar y pegar SL/TP ya)
      } else {
        // Sin fill: ¿se alejó el precio? ¿se invalidó el POI por cuerpo?
        if (intent.cancelBeyond != null) {
          const ranAway =
            intent.direction === 'LONG' ? c.high >= intent.cancelBeyond : c.low <= intent.cancelBeyond;
          if (ranAway) return { intentId: intent.id, outcome: 'cancelled', reason: 'ranAway', endTime: ct };
        }
        if (intent.invalidationPrice != null) {
          const invalidated =
            intent.direction === 'LONG' ? c.close < intent.invalidationPrice : c.close > intent.invalidationPrice;
          if (invalidated) return { intentId: intent.id, outcome: 'cancelled', reason: 'invalidated', endTime: ct };
        }
        continue;
      }
    }

    // —— posición abierta ——
    barsHeld++;

    // 1) Salida en ESTA vela con el SL/TP vigentes (SL tal cual al INICIO de la vela).
    const slHit = intent.direction === 'LONG' ? c.low <= sl : c.high >= sl;
    const tpHit = intent.direction === 'LONG' ? c.high >= intent.takeProfit : c.low <= intent.takeProfit;
    if (slHit && tpHit) {
      // Ambigüedad intrabar → lado pesimista (SL) salvo override explícito.
      if (cfg.pessimisticSameBar) return finishTrade(sl, ct, movedToBE ? 'BE' : 'SL');
      return finishTrade(intent.takeProfit, ct, 'TP');
    }
    if (slHit) return finishTrade(sl, ct, movedToBE ? 'BE' : 'SL');
    if (tpHit) return finishTrade(intent.takeProfit, ct, 'TP');

    // 2) Tope de duración.
    if (cfg.maxHoldBars > 0 && barsHeld >= cfg.maxHoldBars) {
      return finishTrade(c.close, ct, 'maxHold');
    }

    // 3) Break-even para la vela SIGUIENTE (no reordenamos intrabar a favor).
    if (!movedToBE) {
      const favorable = intent.direction === 'LONG' ? c.high : c.low;
      const progress = ((favorable - intent.entry) * sign) / ((intent.takeProfit - intent.entry) * sign);
      if (progress >= cfg.breakevenAtTpFraction) {
        const beLevel = intent.entry + sign * beBufferPrice;
        if (intent.direction === 'LONG' ? beLevel > sl : beLevel < sl) {
          sl = beLevel;
          movedToBE = true;
        }
      }
    }
  }

  // Fin de datos: si seguía abierta, se cierra al último cierre; si nunca llenó, expira (no es trade).
  if (filled) {
    const last = candles[candles.length - 1];
    return finishTrade(last.close, last.closeTime ?? last.openTime, 'endOfData');
  }
  const last = candles[candles.length - 1];
  return { intentId: intent.id, outcome: 'expired', reason: 'noFill', endTime: last.closeTime ?? last.openTime };
}

/**
 * Simula una lista de intents de forma independiente contra la MISMA línea de velas. Cada intent
 * escanea desde su propia `signalBarTime` hacia adelante. Devuelve un resultado por intent.
 */
export function simulateAll(
  intents: TradeIntent[],
  candles: SimCandle[],
  config: Partial<SimConfig> = {},
): SimResult[] {
  return intents.map((i) => simulateTrade(i, candles, config));
}
