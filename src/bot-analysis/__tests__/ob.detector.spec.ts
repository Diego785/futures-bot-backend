import { detectOrderBlocks, type ObCandle, type ObParams } from '../ob.detector';

// Modo IMPULSE (lente anterior): los tests de abajo lo prueban explícitamente.
const P: ObParams = {
  averageWindow: 3,
  strengthRangeMultiplier: 1.5,
  strengthBodyMultiplier: 1.5,
  closeNearExtremeThreshold: 0.55,
  swingLookback: 2,
  obMode: 'impulse',
};

const k = (openTime: number, open: number, high: number, low: number, close: number): ObCandle => ({
  openTime, open, high, low, close,
});

// 3 velas "tranquilas" de referencia (rango ~2).
const calm = [k(1, 100, 101, 99, 100), k(2, 100, 101, 99, 100), k(3, 100, 101, 99, 100)];

describe('detectOrderBlocks', () => {
  it('OB alcista: última vela bajista antes de un impulso alcista fuerte', () => {
    const candles = [
      ...calm,
      k(4, 100, 100.5, 98, 98.5), // OB bajista
      k(5, 98.5, 105, 98.4, 104.8), // impulso alcista fuerte que rompe el máximo del OB
    ];
    const [ob] = detectOrderBlocks('BTCUSDT', '15m', candles, P);
    expect(ob.direction).toBe('bullish');
    expect(ob.obLow).toBe(98);
    expect(ob.obHigh).toBe(100.5);
    expect(ob.originTime).toBe(4);
    expect(ob.confirmedAtTime).toBe(5);
    expect(ob.brokeStructure).toBe(true);
    expect(ob.state).toBe('untouched');
    expect(ob.strength).toBeGreaterThan(1.5);
  });

  it('OB bajista: última vela alcista antes de un impulso bajista fuerte', () => {
    const candles = [
      ...calm,
      k(4, 98.5, 100.5, 98, 100), // OB alcista
      k(5, 100, 100.1, 94, 94.5), // impulso bajista fuerte que rompe el mínimo del OB
    ];
    const [ob] = detectOrderBlocks('BTCUSDT', '15m', candles, P);
    expect(ob.direction).toBe('bearish');
    expect(ob.obLow).toBe(98);
    expect(ob.obHigh).toBe(100.5);
  });

  it('NO marca OB si el impulso es débil (no supera la media ni rompe el OB)', () => {
    const candles = [...calm, k(4, 100, 100.5, 98, 98.5), k(5, 98.5, 99.5, 98.4, 99.2)];
    expect(detectOrderBlocks('BTCUSDT', '15m', candles, P)).toHaveLength(0);
  });

  it('estado mitigated cuando una vela posterior alcanza el extremo distal del OB', () => {
    const candles = [
      ...calm,
      k(4, 100, 100.5, 98, 98.5),
      k(5, 98.5, 105, 98.4, 104.8),
      k(6, 104, 104, 97, 100), // baja hasta 97 (<= obLow 98) sin cerrar debajo → mitigated
    ];
    const [ob] = detectOrderBlocks('BTCUSDT', '15m', candles, P);
    expect(ob.state).toBe('mitigated');
  });

  it('estado invalidated cuando una vela CIERRA más allá del extremo distal', () => {
    const candles = [
      ...calm,
      k(4, 100, 100.5, 98, 98.5),
      k(5, 98.5, 105, 98.4, 104.8),
      k(6, 99, 99, 96, 96.5), // cierra en 96.5 (< obLow 98) → invalidated
    ];
    const [ob] = detectOrderBlocks('BTCUSDT', '15m', candles, P);
    expect(ob.state).toBe('invalidated');
  });

  it('id determinista', () => {
    const candles = [...calm, k(4, 100, 100.5, 98, 98.5), k(5, 98.5, 105, 98.4, 104.8)];
    expect(detectOrderBlocks('BTCUSDT', '15m', candles, P)[0].id).toBe('ob_BTCUSDT_15m_4_u');
  });
});

// Modo STRUCTURAL (swing-first, default): el OB nace al ROMPER un swing (BOS), no por impulso aislado.
const S: ObParams = {
  averageWindow: 3,
  strengthRangeMultiplier: 1.5,
  strengthBodyMultiplier: 1.5,
  closeNearExtremeThreshold: 0.55,
  swingLookback: 2,
  obMode: 'structural',
  showLastBullish: 3,
  showLastBearish: 3,
  useCandleBody: false,
  maxLegBars: 10,
};

describe('detectOrderBlocks (structural)', () => {
  it('OB alcista estructural: al romper el swing high (BOS), marca la última vela bajista del origen', () => {
    const candles = [
      k(0, 100, 101, 99, 100),
      k(1, 100, 101, 99, 100),
      k(2, 100, 106, 99, 105), // swing high (106), confirmado en i4 (lookback 2)
      k(3, 105, 104, 102, 103),
      k(4, 103, 103, 100, 100.5),
      k(5, 100.5, 101, 97, 97.5), // última vela bajista del origen → OB [97, 101]
      k(6, 97.5, 108, 97.4, 107), // impulso que CIERRA 107 > 106 → BOS alcista
    ];
    const obs = detectOrderBlocks('BTCUSDT', '15m', candles, S);
    expect(obs).toHaveLength(1);
    const [ob] = obs;
    expect(ob.direction).toBe('bullish');
    expect(ob.obLow).toBe(97);
    expect(ob.obHigh).toBe(101);
    expect(ob.originTime).toBe(5);
    expect(ob.confirmedAtTime).toBe(6);
    expect(ob.brokeStructure).toBe(true);
    expect(ob.state).toBe('untouched');
  });

  it('sin ruptura de estructura (mercado plano) NO marca OBs', () => {
    const flat = Array.from({ length: 8 }, (_, i) => k(i, 100, 101, 99, 100));
    expect(detectOrderBlocks('BTCUSDT', '15m', flat, S)).toHaveLength(0);
  });

  it('useCandleBody: la zona usa el cuerpo en vez de las mechas', () => {
    const candles = [
      k(0, 100, 101, 99, 100),
      k(1, 100, 101, 99, 100),
      k(2, 100, 106, 99, 105),
      k(3, 105, 104, 102, 103),
      k(4, 103, 103, 100, 100.5),
      k(5, 100.5, 101, 97, 98), // cuerpo [98, 100.5], mechas [97, 101]
      k(6, 98, 108, 97.9, 107),
    ];
    const [ob] = detectOrderBlocks('BTCUSDT', '15m', candles, { ...S, useCandleBody: true });
    expect(ob.obLow).toBe(98); // cuerpo, no la mecha (97)
    expect(ob.obHigh).toBe(100.5);
  });
});

describe('computeStateTimeline — transiciones causales para el replay', () => {
  const { computeStateTimeline } = jest.requireActual<typeof import('../ob.detector')>('../ob.detector');
  const k = (openTime: number, open: number, high: number, low: number, close: number) => ({
    openTime,
    open,
    high,
    low,
    close,
  });

  it('registra touched → mitigated → invalidated con el openTime de cada vela (bullish)', () => {
    // Zona [100, 105]: A no toca · B entra (touched) · C alcanza el distal (mitigated) ·
    // D cierra con cuerpo por debajo (invalidated, y ahí se detiene).
    const candles = [
      k(10, 107, 108, 106, 107), // A
      k(20, 106, 107, 104, 106), // B: low 104 < 105 → touched
      k(30, 105, 106, 99, 103), // C: low 99 ≤ 100 → mitigated (cierre 103 dentro)
      k(40, 102, 103, 97, 98), // D: close 98 < 100 → invalidated
      k(50, 98, 99, 90, 91), // (no se procesa: el timeline se detiene al invalidarse)
    ];
    const tl = computeStateTimeline(candles, 0, 'bullish', 100, 105);
    expect(tl).toEqual({ touchedAt: 20, mitigatedAt: 30, invalidatedAt: 40 });
  });

  it('zona nunca tocada → todo null (untouched)', () => {
    const candles = [k(10, 110, 111, 108, 110), k(20, 110, 112, 109, 111)];
    expect(computeStateTimeline(candles, 0, 'bullish', 100, 105)).toEqual({
      touchedAt: null,
      mitigatedAt: null,
      invalidatedAt: null,
    });
  });

  it('bearish: toca por arriba y se invalida con cierre sobre el proximal', () => {
    // Zona bearish [100, 105]: entra si high > 100; mitiga si high ≥ 105; invalida si close > 105.
    const candles = [
      k(10, 95, 99, 94, 95),
      k(20, 96, 102, 95, 97), // touched (high 102 > 100)
      k(30, 97, 106, 96, 104), // mitigated (high 106 ≥ 105), cierre dentro
      k(40, 104, 108, 103, 107), // invalidated (close 107 > 105)
    ];
    expect(computeStateTimeline(candles, 0, 'bearish', 100, 105)).toEqual({
      touchedAt: 20,
      mitigatedAt: 30,
      invalidatedAt: 40,
    });
  });
});
