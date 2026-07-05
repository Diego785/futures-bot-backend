// EL CANDIDATO CONGELADO del gate #7 (SMC-STRATEGY-MECHANICAL §8 / PAPER-TEST-SPEC §1).
// NO se tunea durante el paper-test (la trampa del v1). Sin dependencias de Nest: lo comparten el
// servicio live y la verificación de equivalencia. El paramsHash derivado por símbolo coincide con
// el de las corridas canónicas registradas en el visor (trazabilidad sim ↔ live).
//
// v2 (Ciclo 4, CYCLE-4-PREREG §8, 2026-07-04): MISMA señal/entrada/SL — cambia SOLO el motor de
// salida a PARCIAL+RUNNER (V5): TP1 cierra 50 % en +1R → SL del resto a BE (cierra EN GANANCIA) →
// el runner corre al 2R nominal. Validado §5 completo en held-out + walk-forward contra el v1.
// El gate del v2 arranca de CERO (PAPER_CLOCK_START nuevo al conmutar el deploy — no hereda N).
// ⚠️ El orden de claves de estos literales fija el paramsHash (JSON sin ordenar): no reordenar.

import { DEFAULT_SIGNAL_CONFIG, type SignalConfig } from '../backtest/signal-source';
import { DEFAULT_SIM_CONFIG, type SimConfig } from '../backtest/trade-simulator';

export const PAPER_TF = '15m';
export const PAPER_HTF = '4h';

export const FROZEN_SIGNAL: SignalConfig = {
  ...DEFAULT_SIGNAL_CONFIG,
  gatillo: 'C',
  tpRule: 'fixedR',
  rMultipleTp: 2,
  slBufferFrac: 0.1,
  cancelDistanceFrac: 3,
  minRr: 1,
  minStopPct: 0.003,
  swingLookback: 10,
  poolMode: 'lastSwing',
};

export const FROZEN_SIM: SimConfig = {
  ...DEFAULT_SIM_CONFIG,
  makerFee: 0.0002,
  takerFee: 0.0005,
  slippagePerSide: 0,
  breakevenAtTpFraction: 0.5, // ignorado en partial-runner (el BE se ancla al fill del TP1)
  maxWaitFillBars: 0,
  maxHoldBars: 0,
  pessimisticSameBar: true,
  // v2 — Ciclo 4 V5 (al FINAL del literal: preserva el orden de claves → paramsHash CLI == paper)
  exitMode: 'partial-runner',
  tp1AtR: 1,
  partialFrac: 0.5,
};

// Ventana del buffer del engine en vivo: ~31 días de 15m. La equivalencia con full-history la
// valida `verify-equivalence` sobre años de datos reales (condición del gate re-registrado).
export const PAPER_WINDOW_BARS = 3000;
