// Capital simulado del paper-test (D.1). Transforma FIELMENTE el registro en R a $: riesgo fijo
// = capital_base × riesgo% por operación (fijo, no compuesto → el $ es linealmente proporcional al
// R realizado, sin distorsión). NO inventa nada: el $ es solo una capa de presentación del R que el
// motor ya registró. Solo cuentan operaciones CERRADAS del forward-test ('live'); las posiciones
// abiertas (FILLED) son no-realizadas. No es una orden ni una cuenta real (Regla Cero).

import type { PaperTrade } from './paper.types';

export interface CapitalConfig {
  baseCapital: number; // $ inicial simulado
  riskPct: number; // fracción arriesgada por trade sobre el capital BASE (fijo). 0.005 = 0.5%
}

export const DEFAULT_CAPITAL_CONFIG: CapitalConfig = { baseCapital: 300, riskPct: 0.005 };

export interface CapitalPoint {
  time: number; // exitTime del trade realizado (0 = punto base inicial)
  balance: number; // saldo $ DESPUÉS de este trade
  pnl: number; // $ de este trade
  intentId: string;
}

export interface MonthPnl {
  month: string; // 'YYYY-MM'
  pnl: number; // $ del mes
  n: number; // operaciones cerradas en el mes
}

export interface CapitalSummary {
  config: CapitalConfig;
  riskPerTrade: number; // $ arriesgado por operación (= base × riskPct)
  baseCapital: number;
  balance: number; // saldo actual (realizado)
  totalPnl: number; // balance − base
  totalPnlPct: number; // sobre el capital base
  maxDrawdown: number; // $ (magnitud positiva de la caída pico→valle)
  maxDrawdownPct: number; // sobre el pico
  closedCount: number; // operaciones cerradas (realizadas)
  openCount: number; // posiciones FILLED (no realizadas)
  curve: CapitalPoint[]; // incluye el punto base al inicio
  byMonth: MonthPnl[];
}

function monthKey(ms: number): string {
  const d = new Date(ms);
  const m = d.getUTCMonth() + 1;
  return `${d.getUTCFullYear()}-${m < 10 ? '0' : ''}${m}`;
}

export function computeCapital(trades: PaperTrade[], cfg: CapitalConfig): CapitalSummary {
  const riskPerTrade = cfg.baseCapital * cfg.riskPct;
  const closed = trades
    .filter((t) => t.state === 'CLOSED' && t.rMultiple != null && t.exitTime != null)
    .sort((a, b) => (a.exitTime as number) - (b.exitTime as number));
  const openCount = trades.filter((t) => t.state === 'FILLED').length;

  const curve: CapitalPoint[] = [{ time: 0, balance: cfg.baseCapital, pnl: 0, intentId: 'base' }];
  let balance = cfg.baseCapital;
  let peak = cfg.baseCapital;
  let maxDrawdown = 0;
  const monthMap = new Map<string, MonthPnl>();

  for (const t of closed) {
    const pnl = (t.rMultiple as number) * riskPerTrade;
    balance += pnl;
    curve.push({ time: t.exitTime as number, balance, pnl, intentId: t.intentId });
    if (balance > peak) peak = balance;
    const dd = peak - balance;
    if (dd > maxDrawdown) maxDrawdown = dd;
    const mk = monthKey(t.exitTime as number);
    const e = monthMap.get(mk) ?? { month: mk, pnl: 0, n: 0 };
    e.pnl += pnl;
    e.n++;
    monthMap.set(mk, e);
  }

  const totalPnl = balance - cfg.baseCapital;
  return {
    config: cfg,
    riskPerTrade,
    baseCapital: cfg.baseCapital,
    balance,
    totalPnl,
    totalPnlPct: cfg.baseCapital ? totalPnl / cfg.baseCapital : 0,
    maxDrawdown,
    maxDrawdownPct: peak ? maxDrawdown / peak : 0,
    closedCount: closed.length,
    openCount,
    curve,
    byMonth: [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month)),
  };
}

// ── Formato (compartido por la pestaña Paper) ──
export const formatUsd = (n: number, signed = false): string => {
  const s = `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return n < 0 ? `−${s}` : signed ? `+${s}` : s;
};
export const formatPct = (f: number, signed = true): string => {
  const v = (Math.abs(f) * 100).toFixed(2);
  return f < 0 ? `−${v}%` : signed ? `+${v}%` : `${v}%`;
};
