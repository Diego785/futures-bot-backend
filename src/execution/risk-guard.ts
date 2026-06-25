// Risk-guard — el ARNÉS de seguridad de la ejecución real (EXECUTION-SPEC §5). Decide si se permite
// ABRIR un intent dado el estado del portafolio y los topes duros, y lleva la cuenta de slots, margen,
// pérdida diaria/acumulada y el kill-switch. La decisión es PURA (evaluateOpen, sin efectos); la clase
// RiskGuard mantiene el estado. Sin dependencias de Nest/exchange/DB → 100% testeable.
//
// Modelo de "slot": un intent ocupa un slot desde que se COLOCA la límite (reserva) hasta que se
// RESUELVE (se cancela sin fill → release · se cierra la posición → settle). Así el tope de posiciones
// concurrentes acota la exposición PENDIENTE, no solo la abierta. El margen se reserva igual (una límite
// resting también compromete margen en Binance).

import type {
  BracketPlan,
  RiskLimits,
  RiskState,
  RiskDecision,
} from './execution.types';

export function dayKeyOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10); // 'YYYY-MM-DD' UTC
}

// Evaluación PURA: ¿se permite abrir este intent? No muta nada. El orden de los chequeos va de lo más
// barato/estructural a lo dependiente de mercado.
export function evaluateOpen(
  plan: BracketPlan,
  marketPrice: number,
  state: RiskState,
  limits: RiskLimits,
): RiskDecision {
  if (state.killed) {
    return deny(`kill-switch activo${state.killReason ? `: ${state.killReason}` : ''}`);
  }
  if (!limits.symbols.includes(plan.symbol)) {
    return deny(`símbolo fuera de whitelist: ${plan.symbol}`);
  }
  if (state.activeSlots >= limits.maxConcurrentPositions) {
    return deny(`máx posiciones concurrentes (${state.activeSlots}/${limits.maxConcurrentPositions})`);
  }
  if (plan.notionalUsd > limits.maxNotionalPerOrderUsd) {
    return deny(`nocional $${plan.notionalUsd.toFixed(2)} > tope $${limits.maxNotionalPerOrderUsd}`);
  }
  const newMargin = plan.notionalUsd / limits.leverage;
  if (state.marginUsedUsd + newMargin > limits.maxMarginUsedUsd) {
    return deny(
      `margen comprometido $${(state.marginUsedUsd + newMargin).toFixed(2)} > tope $${limits.maxMarginUsedUsd}`,
    );
  }
  if (state.dailyLossR >= limits.maxDailyLossR) {
    return deny(`pérdida diaria ${state.dailyLossR.toFixed(2)}R ≥ tope ${limits.maxDailyLossR}R (corte del día)`);
  }
  if (state.cumulativeLossR >= limits.circuitBreakerLossR) {
    return deny(`circuit breaker ${state.cumulativeLossR.toFixed(2)}R ≥ ${limits.circuitBreakerLossR}R`);
  }
  const entryPrice = parseFloat(plan.entry.price ?? '0');
  if (marketPrice > 0 && entryPrice > 0) {
    const dev = Math.abs(entryPrice - marketPrice) / marketPrice;
    if (dev > limits.priceSanityFrac) {
      return deny(
        `entrada ${entryPrice} a ${(dev * 100).toFixed(1)}% del mercado ${marketPrice} (>±${(limits.priceSanityFrac * 100).toFixed(0)}%)`,
      );
    }
  }
  return { allow: true };
}

function deny(reason: string): RiskDecision {
  return { allow: false, reason };
}

// Guardián con estado. El executor llama, en orden de vida del intent:
//   tryReserve (al colocar la límite) → release (si se cancela sin fill) | settle (al cerrar la posición).
export class RiskGuard {
  private state: RiskState;

  constructor(
    private readonly limits: RiskLimits,
    now: number,
  ) {
    this.state = {
      activeSlots: 0,
      marginUsedUsd: 0,
      dailyLossR: 0,
      cumulativeLossR: 0,
      realizedR: 0,
      dayKey: dayKeyOf(now),
      killed: false,
      killReason: null,
    };
  }

  // Chequea y, si pasa, RESERVA el slot + margen de forma atómica (sin TOCTOU entre check y reserva).
  tryReserve(plan: BracketPlan, marketPrice: number, now: number): RiskDecision {
    this.rollDay(now);
    const decision = evaluateOpen(plan, marketPrice, this.state, this.limits);
    if (decision.allow) {
      this.state.activeSlots += 1;
      this.state.marginUsedUsd += plan.notionalUsd / this.limits.leverage;
    }
    return decision;
  }

  // La límite se canceló sin llenar (ranAway): libera slot + margen, sin P&L.
  release(plan: BracketPlan): void {
    this.state.activeSlots = Math.max(0, this.state.activeSlots - 1);
    this.state.marginUsedUsd = Math.max(
      0,
      this.state.marginUsedUsd - plan.notionalUsd / this.limits.leverage,
    );
  }

  // La posición se cerró (TP/SL/BE): libera slot + margen y contabiliza la R realizada. Una pérdida
  // suma a la diaria y a la acumulada; si la acumulada cruza el circuit breaker → kill permanente.
  settle(plan: BracketPlan, rMultiple: number, now: number): void {
    this.rollDay(now);
    this.state.activeSlots = Math.max(0, this.state.activeSlots - 1);
    this.state.marginUsedUsd = Math.max(
      0,
      this.state.marginUsedUsd - plan.notionalUsd / this.limits.leverage,
    );
    this.state.realizedR += rMultiple;
    if (rMultiple < 0) {
      const loss = -rMultiple;
      this.state.dailyLossR += loss;
      this.state.cumulativeLossR += loss;
      if (this.state.cumulativeLossR >= this.limits.circuitBreakerLossR) {
        this.kill(
          `circuit breaker: pérdida acumulada ${this.state.cumulativeLossR.toFixed(2)}R ≥ ${this.limits.circuitBreakerLossR}R`,
        );
      }
    }
  }

  kill(reason: string): void {
    this.state.killed = true;
    this.state.killReason = reason;
  }

  unkill(): void {
    this.state.killed = false;
    this.state.killReason = null;
  }

  isKilled(): boolean {
    return this.state.killed;
  }

  snapshot(): Readonly<RiskState> {
    return { ...this.state };
  }

  // Resetea la pérdida diaria al cambiar de día UTC (el corte diario se auto-levanta; el circuit
  // breaker NO — ese requiere unkill manual).
  private rollDay(now: number): void {
    const key = dayKeyOf(now);
    if (this.state.dayKey !== key) {
      this.state.dayKey = key;
      this.state.dailyLossR = 0;
    }
  }
}
