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

describe('detectSweeps — modo pools (Ciclo 2, CYCLE-2-PREREG Eje 2)', () => {
  const PP: SweepParams = { swingLookback: 2, poolMode: 'pools' };

  it('equal lows: dos pivotes dentro de tolerancia forman UN pool (≥2 toques) y su barrida es un sweep equal', () => {
    const candles = [
      k(0, 100, 106, 98, 100),
      k(1, 100, 106, 97, 100),
      k(2, 100, 106, 95, 100), // pivote low 95
      k(3, 100, 106, 98, 100),
      k(4, 100, 106, 97.5, 100), // confirma i2 → pool {95}
      k(5, 100, 106, 98, 100),
      k(6, 100, 106, 95.05, 100), // pivote low 95.05 (|Δ|/95 ≈ 0.05 % ≤ 0.1 %) → merge
      k(7, 100, 106, 98, 100),
      k(8, 100, 106, 97, 100), // confirma i6 → pool {95, touches 2}
      k(9, 100, 106, 94, 96), // barre (94 < 95) y reclama (96 > 95)
    ];
    const sweeps = detectSweeps('BTCUSDT', '15m', candles, PP);
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatchObject({
      direction: 'bullish',
      sweptLevel: 95, // el extremo del cluster (mínimo de los lows)
      sweepBarTime: 9,
      sweptSwingTime: 6, // el ÚLTIMO pivote que formó el pool
      poolType: 'equal',
      touches: 2,
      wickExtreme: 94,
    });
  });

  it('los swings VIEJOS no barridos siguen vigentes (el modo lastSwing solo ve el último)', () => {
    const candles = [
      k(0, 100, 106, 98, 100),
      k(1, 100, 106, 97, 100),
      k(2, 100, 106, 90, 100), // pivote low 90 (profundo, viejo)
      k(3, 100, 106, 96, 100),
      k(4, 100, 106, 97, 100), // confirma i2 → pool {90}
      k(5, 100, 106, 98, 100),
      k(6, 100, 106, 95, 100), // pivote low 95 (lejos de 90 → pool propio)
      k(7, 100, 106, 97, 100),
      k(8, 100, 106, 96, 100), // confirma i6 → pools {90} y {95}
      k(9, 100, 106, 94, 97), // barre 95 y reclama → sweep A; el pool 90 sigue vivo (94 > 90)
      k(10, 100, 106, 89, 92), // barre 90 y reclama → sweep B
    ];
    const pools = detectSweeps('BTCUSDT', '15m', candles, PP);
    expect(pools).toHaveLength(2);
    expect(pools[0]).toMatchObject({ sweptLevel: 95, sweepBarTime: 9, poolType: 'swing', touches: 1 });
    expect(pools[1]).toMatchObject({ sweptLevel: 90, sweepBarTime: 10 });

    // Contraste: el modo default (candidato congelado) solo barre el ÚLTIMO swing confirmado.
    const last = detectSweeps('BTCUSDT', '15m', candles, P);
    expect(last).toHaveLength(1);
    expect(last[0].sweptLevel).toBe(95);
  });

  it('el pool MUERE al cruce de mecha aunque NO haya reclaim (ruptura): un retest posterior ya no es sweep', () => {
    const candles = [
      k(0, 100, 106, 98, 100),
      k(1, 100, 106, 97, 100),
      k(2, 100, 106, 95, 100), // pivote low 95
      k(3, 100, 106, 98, 100),
      k(4, 100, 106, 97, 100), // confirma → pool {95}
      k(5, 100, 106, 92, 93), // CRUZA (92 < 95) pero cierra DEBAJO (93 < 95) = ruptura → pool muerto, sin señal
      k(6, 100, 106, 94, 97), // "retest con reclaim" sobre un pool muerto → nada
    ];
    expect(detectSweeps('BTCUSDT', '15m', candles, PP)).toHaveLength(0);
  });

  it('si una vela barre y reclama VARIOS pools del mismo lado, emite UNO: el más profundo', () => {
    const candles = [
      k(0, 100, 106, 98, 100),
      k(1, 100, 106, 97, 100),
      k(2, 100, 106, 90, 100), // pivote low 90
      k(3, 100, 106, 96, 100),
      k(4, 100, 106, 97, 100), // confirma → pool {90}
      k(5, 100, 106, 98, 100),
      k(6, 100, 106, 95, 100), // pivote low 95
      k(7, 100, 106, 97, 100),
      k(8, 100, 106, 96, 100), // confirma → pools {90} y {95}
      k(9, 100, 106, 88, 97), // barre AMBOS (88 < 90 < 95) y reclama ambos (97 > 95) → UN sweep, el de 90
    ];
    const sweeps = detectSweeps('BTCUSDT', '15m', candles, PP);
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatchObject({ sweptLevel: 90, wickExtreme: 88, direction: 'bullish', sweepBarTime: 9 });
  });
});
