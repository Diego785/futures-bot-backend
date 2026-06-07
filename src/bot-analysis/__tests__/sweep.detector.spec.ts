import { detectSweeps, type SweepParams } from '../sweep.detector';
import { type ObCandle } from '../ob.detector';

// swingLookback 2 (igual estilo que ob.detector.spec): swings pequeños para fixtures legibles.
const P: SweepParams = { swingLookback: 2 };

const k = (openTime: number, open: number, high: number, low: number, close: number): ObCandle => ({
  openTime,
  open,
  high,
  low,
  close,
});

describe('detectSweeps', () => {
  it('sweep alcista: la mecha barre un swing low y el cuerpo reclama por encima', () => {
    const candles = [
      k(0, 100, 101, 99, 100),
      k(1, 100, 101, 99, 100),
      k(2, 100, 101, 95, 96), // swing low 95 (vecinos low 99 > 95), confirmado en i4
      k(3, 100, 101, 99, 100),
      k(4, 100, 101, 99, 100),
      k(5, 100, 101, 94, 100), // barre (low 94 < 95) y RECLAMA (close 100 > 95)
    ];
    const sweeps = detectSweeps('BTCUSDT', '15m', candles, P);
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0].direction).toBe('bullish');
    expect(sweeps[0].sweptLevel).toBe(95);
    expect(sweeps[0].sweepBarTime).toBe(5);
    expect(sweeps[0].wickExtreme).toBe(94);
    expect(sweeps[0].penetration).toBe(1);
    expect(sweeps[0].id).toBe('sweep_BTCUSDT_15m_5_u');
  });

  it('sweep bajista: la mecha barre un swing high y el cuerpo reclama por debajo', () => {
    const candles = [
      k(0, 100, 101, 99, 100),
      k(1, 100, 101, 99, 100),
      k(2, 100, 106, 99, 105), // swing high 106
      k(3, 100, 101, 99, 100),
      k(4, 100, 101, 99, 100),
      k(5, 100, 107, 99, 100), // barre (high 107 > 106) y RECLAMA (close 100 < 106)
    ];
    const sweeps = detectSweeps('BTCUSDT', '15m', candles, P);
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0].direction).toBe('bearish');
    expect(sweeps[0].sweptLevel).toBe(106);
    expect(sweeps[0].wickExtreme).toBe(107);
  });

  it('NO es sweep si el cuerpo cierra FUERA (es ruptura/BOS, no reclaim)', () => {
    const candles = [
      k(0, 100, 101, 99, 100),
      k(1, 100, 101, 99, 100),
      k(2, 100, 101, 95, 96), // swing low 95
      k(3, 100, 101, 99, 100),
      k(4, 100, 101, 99, 100),
      k(5, 96, 96, 94, 94.5), // low 94 < 95 pero close 94.5 < 95 → ruptura, NO sweep
    ];
    expect(detectSweeps('BTCUSDT', '15m', candles, P)).toHaveLength(0);
  });

  it('mercado plano (sin swings estrictos) no genera sweeps', () => {
    const flat = Array.from({ length: 8 }, (_, i) => k(i, 100, 101, 99, 100));
    expect(detectSweeps('BTCUSDT', '15m', flat, P)).toHaveLength(0);
  });

  it('un mismo swing barrido se cuenta UNA sola vez (la liquidez ya fue tomada)', () => {
    const candles = [
      k(0, 100, 101, 99, 100),
      k(1, 100, 101, 99, 100),
      k(2, 100, 101, 95, 96), // swing low 95
      k(3, 100, 101, 99, 100),
      k(4, 100, 101, 99, 100),
      k(5, 100, 101, 94, 100), // sweep (1 evento)
      k(6, 100, 101, 93, 100), // perfora otra vez el MISMO nivel → no recuenta
    ];
    expect(detectSweeps('BTCUSDT', '15m', candles, P)).toHaveLength(1);
  });
});
