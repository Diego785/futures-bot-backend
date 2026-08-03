import { C5PoolDetector, C5_PARAMS, type C5PoolCandle } from '../c5-pool-detector';

// Ciclo 5 — detector de pools multi-día. Convenciones de los tests:
//   · velas 15m sintéticas desde T0, closeTime = openTime + 15m − 1 (como la DB);
//   · el "silencio" usa highs DESCENDENTES en pasos de 0.05 (cadenas de ~2 toques, span < P) para
//     no fabricar pools accidentales por repetición ni por goteo ascendente;
//   · parámetros REALES congelados: ε = 0.10 % · P = 16 velas · D = 2 días (= 192 velas 15m).

const M15 = 15 * 60_000;
const T0 = Date.UTC(2024, 0, 1);

const mk = (i: number, high: number, low: number): C5PoolCandle => ({
  openTime: T0 + i * M15,
  open: (high + low) / 2,
  high,
  low,
  close: (high + low) / 2,
  closeTime: T0 + (i + 1) * M15 - 1,
});

// Serie base: toque 1 del pool en i=0 (high 100), silencio descendente, toque 2 en `secondTouchAt`
// (high `secondHigh`), y silencio hasta `until` (exclusivo). Los lows bajan en pasos de 0.15
// (> ε·nivel): en el lado low el nivel SIGUE al mínimo, y un paso menor que ε encadenaría fusiones
// perpetuas hasta fabricar un pool low incidental que ensuciaría los contadores del test.
function series(secondTouchAt: number, secondHigh: number, until: number): C5PoolCandle[] {
  const out: C5PoolCandle[] = [mk(0, 100, 95)];
  for (let i = 1; i < until; i++) {
    if (i === secondTouchAt) out.push(mk(i, secondHigh, 95 - 0.15 * i));
    else out.push(mk(i, 90 - 0.05 * i, 85 - 0.15 * i));
  }
  return out;
}

const feedAll = (det: C5PoolDetector, candles: C5PoolCandle[]): void => {
  for (const c of candles) det.update(c);
};

describe('C5PoolDetector — calificación (≥2 extremos dentro de ε, separados ≥P, edad ≥D)', () => {
  it('dos toques dentro de ε, separados 200 velas y con >2 días → pool calificado con nivel = extremo más alto', () => {
    const det = new C5PoolDetector();
    feedAll(det, series(200, 100.05, 201)); // |100.05 − 100| = 0.05 ≤ ε·L (0.1); 201 velas ≈ 50.25 h ≥ 48 h
    const pools = det.activeQualifiedPools('high');
    expect(pools).toHaveLength(1);
    expect(pools[0].level).toBe(100.05); // el extremo MÁS ALTO del cluster
    expect(pools[0].touchCount).toBeGreaterThanOrEqual(2);
    expect(pools[0].firstTouchTime).toBe(T0);
  });

  it('un solo extremo NO es pool; dos extremos separados < P velas tampoco', () => {
    const solo = new C5PoolDetector();
    feedAll(solo, series(-1, 0, 300)); // sin segundo toque
    expect(solo.activeQualifiedPools('high')).toHaveLength(0);

    const juntos = new C5PoolDetector();
    feedAll(juntos, series(10, 100.05, 300)); // separación 10 < P=16 y nunca hay un 3er toque
    expect(juntos.activeQualifiedPools('high')).toHaveLength(0);
  });

  it('dos extremos separados ≥P pero con menos de D días NO califican… hasta que la edad llega (promoción sin toque nuevo)', () => {
    const det = new C5PoolDetector();
    const candles = series(50, 100.05, 300);
    // hasta i=190 (~47.75 h): span 50 ≥ 16 pero el extremo más viejo aún no cumple 2 días
    for (let i = 0; i <= 190; i++) det.update(candles[i]);
    expect(det.activeQualifiedPools('high')).toHaveLength(0);
    // al pasar los 2 días (i≈192) el MISMO cluster promueve por edad, sin necesidad de otro toque
    for (let i = 191; i <= 195; i++) det.update(candles[i]);
    expect(det.activeQualifiedPools('high')).toHaveLength(1);
    expect(det.activeQualifiedPools('high')[0].level).toBe(100.05);
  });

  it('un "toque" fuera de ε NO agrupa: barre el nivel y arranca cluster nuevo', () => {
    const det = new C5PoolDetector();
    feedAll(det, series(200, 100.2, 300)); // 100.2 > 100·(1+ε) = 100.1 → barrido, no toque
    expect(det.activeQualifiedPools('high')).toHaveLength(0);
    expect(det.stats().qualifiedEver).toBe(0);
  });

  it('lado low espejo: equal lows califican y el nivel es el extremo MÁS BAJO', () => {
    const det = new C5PoolDetector();
    const out: C5PoolCandle[] = [mk(0, 115, 100)];
    for (let i = 1; i < 201; i++) {
      if (i === 200) out.push(mk(i, 115, 99.97)); // |99.97 − 100| = 0.03 ≤ ε·L
      else out.push(mk(i, 120 + 0.05 * i, 110 + 0.05 * i)); // silencio ASCENDENTE (espejo)
    }
    feedAll(det, out);
    const pools = det.activeQualifiedPools('low');
    expect(pools).toHaveLength(1);
    expect(pools[0].level).toBe(99.97);
  });
});

describe('C5PoolDetector — barrido (la mecha supera nivel±ε ⇒ el pool deja de estar vigente)', () => {
  it('pool calificado + mecha > nivel·(1+ε) → desaparece de los vigentes', () => {
    const det = new C5PoolDetector();
    const candles = series(200, 100.05, 201);
    feedAll(det, candles);
    expect(det.activeQualifiedPools('high')).toHaveLength(1);
    det.update(mk(201, 100.5, 95)); // 100.5 > 100.05·1.001 ≈ 100.155 → barrido
    expect(det.activeQualifiedPools('high')).toHaveLength(0);
    expect(det.stats().sweptQualified).toBe(1);
    expect(det.stats().qualifiedEver).toBe(1); // existió — el embudo lo recuerda
  });

  it('una mecha DENTRO de ε no barre: es otro toque y puede subir el nivel', () => {
    const det = new C5PoolDetector();
    feedAll(det, series(200, 100.05, 201));
    det.update(mk(201, 100.09, 95)); // ≤ 100.05·1.001 ≈ 100.155 → toque, no barrido
    const pools = det.activeQualifiedPools('high');
    expect(pools).toHaveLength(1);
    expect(pools[0].level).toBe(100.09);
  });
});

describe('C5PoolDetector — causalidad (incremental ≡ lote sobre el mismo prefijo)', () => {
  it('el estado tras la vela k es función exclusiva de las velas ≤ k (las velas futuras no lo alteran)', () => {
    // Serie con vida: pool que califica en i=200, toque extra en 201, barrido en 205, nada después.
    const candles = series(200, 100.05, 201);
    candles.push(mk(201, 100.06, 95));
    candles.push(mk(202, 90, 85));
    candles.push(mk(203, 89, 84));
    candles.push(mk(204, 88, 83));
    candles.push(mk(205, 100.5, 95)); // barre el pool
    candles.push(mk(206, 87, 82));

    // Pasada incremental única, con snapshot de los pools vigentes tras CADA vela.
    const inc = new C5PoolDetector();
    const snapshots: string[] = [];
    for (const c of candles) {
      inc.update(c);
      snapshots.push(JSON.stringify(inc.activeQualifiedPools()));
    }

    // Un detector FRESCO alimentado solo con el prefijo [0..k] reproduce el snapshot exacto:
    // nada de lo que vino después pintó hacia atrás.
    for (const k of [0, 50, 199, 200, 201, 205, 206]) {
      const fresh = new C5PoolDetector();
      for (let i = 0; i <= k; i++) fresh.update(candles[i]);
      expect(JSON.stringify(fresh.activeQualifiedPools())).toBe(snapshots[k]);
    }
  });
});

describe('C5_PARAMS — el grid congelado del prereg §2 no se toca', () => {
  it('valores exactos', () => {
    expect(C5_PARAMS.epsilonFrac).toBe(0.001);
    expect(C5_PARAMS.minSeparationBars).toBe(16);
    expect(C5_PARAMS.minAgeMs).toBe(2 * 86_400_000);
    expect(C5_PARAMS.poiBetaFrac).toBe(0);
    expect(C5_PARAMS.slBufferFrac).toBe(0.0035);
    expect(C5_PARAMS.maxWaitFillMs).toBe(10 * 86_400_000);
    expect(C5_PARAMS.minStopPct).toBe(0.003);
    expect(C5_PARAMS.makerFee).toBe(0.0002);
    expect(C5_PARAMS.takerFee).toBe(0.0005);
    expect(C5_PARAMS.tp1AtR).toBe(1);
    expect(C5_PARAMS.partialFrac).toBe(0.5);
    expect(C5_PARAMS.runnerFixedR).toBe(2);
    expect(C5_PARAMS.swingLookback4h).toBe(10);
  });
});
