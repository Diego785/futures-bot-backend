import { generateIntents, generateIntentsDetailed } from '../signal-source';
import { detectOrderBlocks, type ObCandle } from '../../bot-analysis/ob.detector';
import { detectSweeps } from '../../bot-analysis/sweep.detector';

// Vela OHLC (openTime = índice para legibilidad).
const oc = (openTime: number, open: number, high: number, low: number, close: number): ObCandle => ({
  openTime,
  open,
  high,
  low,
  close,
});

// Serie que produce UN OB estructural alcista (swing high en idx2=105; origen bajista en idx5;
// impulso fuerte en idx6 cierra 107 > 105 = BOS). swingLookback=2.
const A_SERIES: ObCandle[] = [
  oc(0, 101, 104, 100, 103),
  oc(1, 103, 104, 100, 102),
  oc(2, 102, 105, 101, 104), // swing high 105
  oc(3, 103, 104, 100, 101),
  oc(4, 101, 103, 99, 100),
  oc(5, 100, 101, 96, 97), // origen del OB (última bajista antes del impulso)
  oc(6, 97, 108, 97, 107), // BOS alcista (cierre 107 > 105)
];

// Serie que produce UN sweep alcista (swing low en idx2=95; idx5 mecha a 90 < 95 y cierra 102 > 95).
const C_SERIES: ObCandle[] = [
  oc(0, 105, 110, 100, 105),
  oc(1, 104, 109, 101, 104),
  oc(2, 103, 108, 95, 103), // swing low 95
  oc(3, 102, 107, 101, 102),
  oc(4, 101, 106, 100, 101),
  oc(5, 101, 104, 90, 102), // sweep+reclaim (low 90 < 95, close 102 > 95)
];

const LB2 = { swingLookback: 2, slBufferFrac: 0.1, rMultipleTp: 2, minRr: 1 } as const;

describe('generateIntents — modo A (riesgo)', () => {
  it('mapea cada OB a un límite en su CE con SL en el distal + buffer', () => {
    const obs = detectOrderBlocks('BTCUSDT', '4h', A_SERIES, {
      swingLookback: 2,
      showLastBullish: 1e9,
      showLastBearish: 1e9,
    });
    expect(obs).toHaveLength(1);
    const o = obs[0];

    const intents = generateIntents('BTCUSDT', '4h', A_SERIES, { gatillo: 'A', tpRule: 'fixedR', ...LB2 });
    expect(intents).toHaveLength(1);
    const it = intents[0];

    const range = o.obHigh - o.obLow;
    const entry = (o.obLow + o.obHigh) / 2;
    const sl = o.direction === 'bullish' ? o.obLow - 0.1 * range : o.obHigh + 0.1 * range;
    const risk = Math.abs(entry - sl);

    expect(it.direction).toBe('LONG');
    expect(it.signalBarTime).toBe(o.confirmedAtTime); // causal: se conoce al BOS
    expect(it.entry).toBeCloseTo(entry, 6);
    expect(it.stopLoss).toBeCloseTo(sl, 6);
    expect(it.takeProfit).toBeCloseTo(entry + 2 * risk, 6); // fixedR 2R
    expect(it.invalidationPrice).toBeCloseTo(o.obLow, 6); // distal alcista
    expect(it.id).toBe(`A_BTCUSDT_4h_${o.originTime}`);
  });
});

describe('generateIntents — modo B (confirmación)', () => {
  it('sin madre mitigada previa, un OB suelto NO genera intent', () => {
    const intents = generateIntents('BTCUSDT', '4h', A_SERIES, { gatillo: 'B', tpRule: 'fixedR', ...LB2 });
    expect(intents).toHaveLength(0);
  });
});

describe('generateIntents — modo C (sweep + reclaim)', () => {
  it('mapea el sweep a una entrada en la reacción con SL bajo la mecha', () => {
    const sweeps = detectSweeps('BTCUSDT', '15m', C_SERIES, { swingLookback: 2 });
    expect(sweeps).toHaveLength(1);
    const s = sweeps[0];

    const intents = generateIntents('BTCUSDT', '15m', C_SERIES, { gatillo: 'C', tpRule: 'fixedR', ...LB2 });
    expect(intents).toHaveLength(1);
    const it = intents[0];

    const zoneLow = s.wickExtreme; // bullish: low de la mecha
    const zoneHigh = s.sweptLevel; // nivel barrido
    const range = zoneHigh - zoneLow;
    const entry = (zoneLow + zoneHigh) / 2;
    const sl = zoneLow - 0.1 * range; // bajo la mecha

    expect(it.direction).toBe('LONG');
    expect(it.signalBarTime).toBe(s.sweepBarTime);
    expect(it.entry).toBeCloseTo(entry, 6);
    expect(it.stopLoss).toBeCloseTo(sl, 6);
    expect(it.invalidationPrice).toBeCloseTo(zoneLow, 6);
    expect(it.id).toBe(`C_BTCUSDT_15m_${s.sweepBarTime}_u`);
  });

  it('dos sweeps opuestos en la MISMA vela generan intents con ids DISTINTOS (sin colisión)', () => {
    // Swing high 120 (idx2) y swing low 90 (idx4), ambos confirmados; la vela idx7 barre los dos
    // (h125>120 con cierre 106<120 · l85<90 con cierre 106>90) y reclama ambos.
    const series: ObCandle[] = [
      oc(0, 100, 105, 95, 100),
      oc(1, 100, 106, 96, 100),
      oc(2, 100, 120, 99, 101), // swing high 120
      oc(3, 101, 107, 97, 102),
      oc(4, 102, 108, 90, 103), // swing low 90
      oc(5, 103, 109, 92, 104),
      oc(6, 104, 110, 93, 105),
      oc(7, 105, 125, 85, 106), // barre ambos y cierra entre los dos niveles
    ];
    const sweeps = detectSweeps('BTCUSDT', '15m', series, { swingLookback: 2 });
    expect(sweeps).toHaveLength(2); // uno bullish + uno bearish en la misma vela

    const intents = generateIntents('BTCUSDT', '15m', series, { gatillo: 'C', tpRule: 'fixedR', ...LB2 });
    expect(intents).toHaveLength(2);
    const ids = new Set(intents.map((i) => i.id));
    expect(ids.size).toBe(2); // ids únicos: el dedup del paper-trading no los colapsa
    expect(intents.map((i) => i.direction).sort()).toEqual(['LONG', 'SHORT']);
  });

  it('filtro fee-aware: minStopPct alto descarta el stop micro', () => {
    // entry 92.5, risk 3 → risk/entry ≈ 3.24 %. minStopPct 0.05 (5 %) lo filtra; 0 lo deja.
    const sin = generateIntents('BTCUSDT', '15m', C_SERIES, { gatillo: 'C', tpRule: 'fixedR', minStopPct: 0.05, ...LB2 });
    expect(sin).toHaveLength(0);
    const con = generateIntents('BTCUSDT', '15m', C_SERIES, { gatillo: 'C', tpRule: 'fixedR', minStopPct: 0, ...LB2 });
    expect(con).toHaveLength(1);
  });

  it('TP por liquidez cae a R-fijo cuando no hay nivel válido', () => {
    const intents = generateIntents('BTCUSDT', '15m', C_SERIES, { gatillo: 'C', tpRule: 'liquidity', ...LB2 });
    expect(intents).toHaveLength(1);
    const it = intents[0];
    const risk = Math.abs(it.entry - it.stopLoss);
    expect(it.takeProfit).toBeCloseTo(it.entry + 2 * risk, 6); // fallback fixedR
  });

  it('filtro de sesgo HTF: el sweep LONG solo pasa si el HTF es alcista', () => {
    // El sweep de C_SERIES es LONG (signalBarTime 5).
    const conBull = generateIntents('BTCUSDT', '15m', C_SERIES, { gatillo: 'C', tpRule: 'fixedR', ...LB2 }, [
      { time: 0, bias: 'bullish' },
    ]);
    expect(conBull).toHaveLength(1); // a favor → pasa
    const conBear = generateIntents('BTCUSDT', '15m', C_SERIES, { gatillo: 'C', tpRule: 'fixedR', ...LB2 }, [
      { time: 0, bias: 'bearish' },
    ]);
    expect(conBear).toHaveLength(0); // en contra → filtrado
  });

  it('lleva el contexto causal del sweep (qué liquidez barrió) para el visor/paper', () => {
    const s = detectSweeps('BTCUSDT', '15m', C_SERIES, { swingLookback: 2 })[0];
    const it = generateIntents('BTCUSDT', '15m', C_SERIES, { gatillo: 'C', tpRule: 'fixedR', ...LB2 })[0];
    expect(it.context).toMatchObject({
      zoneLow: s.wickExtreme,
      zoneHigh: s.sweptLevel,
      sweptLevel: s.sweptLevel,
      wickExtreme: s.wickExtreme,
      sweptSwingTime: s.sweptSwingTime,
    });
  });
});

describe('generateIntentsDetailed — el porqué-no (rejects con razón)', () => {
  it('un sweep contra el sesgo HTF sale como reject htfBias con su zona', () => {
    const { intents, rejects } = generateIntentsDetailed(
      'BTCUSDT',
      '15m',
      C_SERIES,
      { gatillo: 'C', tpRule: 'fixedR', ...LB2 },
      [{ time: 0, bias: 'bearish' }], // el sweep es LONG → contra-tendencia
    );
    expect(intents).toHaveLength(0);
    expect(rejects).toHaveLength(1);
    const s = detectSweeps('BTCUSDT', '15m', C_SERIES, { swingLookback: 2 })[0];
    expect(rejects[0]).toMatchObject({
      reason: 'htfBias',
      direction: 'LONG',
      signalBarTime: s.sweepBarTime,
      zoneLow: s.wickExtreme,
      zoneHigh: s.sweptLevel,
    });
  });

  it('un stop micro sale como reject minStop (filtro fee-aware)', () => {
    const { intents, rejects } = generateIntentsDetailed('BTCUSDT', '15m', C_SERIES, {
      gatillo: 'C',
      tpRule: 'fixedR',
      minStopPct: 0.05, // risk/entry ≈ 3.24 % < 5 % → descartado
      ...LB2,
    });
    expect(intents).toHaveLength(0);
    expect(rejects).toHaveLength(1);
    expect(rejects[0].reason).toBe('minStop');
  });

  it('generateIntents (la API estable) devuelve exactamente los intents del detallado', () => {
    const detailed = generateIntentsDetailed('BTCUSDT', '15m', C_SERIES, { gatillo: 'C', tpRule: 'fixedR', ...LB2 });
    const simple = generateIntents('BTCUSDT', '15m', C_SERIES, { gatillo: 'C', tpRule: 'fixedR', ...LB2 });
    expect(simple).toEqual(detailed.intents);
  });
});

describe('TP estructural (Ciclo 2 — CYCLE-2-PREREG Eje 1)', () => {
  const { resolveStructuralTp, DEFAULT_SIGNAL_CONFIG } =
    jest.requireActual<typeof import('../signal-source')>('../signal-source');
  const cfg = { ...DEFAULT_SIGNAL_CONFIG, swingLookback: 2 };
  const target = (
    direction: 'bullish' | 'bearish',
    proximal: number,
    confirmedAtTime: number,
    invalidatedAt: number | null = null,
  ) => ({ direction, proximal, confirmedAtTime, invalidatedAt });

  it('elige el OB OPUESTO vigente más cercano (su borde proximal)', () => {
    const obT = [target('bearish', 110, 0), target('bearish', 120, 0), target('bullish', 90, 0)];
    const r = resolveStructuralTp('LONG', 100, 50, 5, obT, [], cfg, new Map());
    expect(r).toEqual({ price: 110, source: 'structural-ob' });
  });

  it('descarta el OB invalidado ANTES de la señal y el confirmado DESPUÉS (causalidad)', () => {
    const obT = [
      target('bearish', 110, 0, 40), // invalidado en t40 ≤ señal t50 → muerto
      target('bearish', 115, 60), // confirmado en t60 > señal t50 → aún no se conocía
      target('bearish', 125, 0), // vigente
    ];
    const r = resolveStructuralTp('LONG', 100, 50, 5, obT, [], cfg, new Map());
    expect(r).toEqual({ price: 125, source: 'structural-ob' });
  });

  it('la liquidez opuesta gana si está más cerca que el OB', () => {
    const liq = {
      id: 'liq_x',
      symbol: 'BTCUSDT',
      tf: '15m',
      type: 'swingHigh' as const,
      side: 'buyside' as const,
      level: 105,
      candleTimes: [0],
      touches: 1,
      swept: false,
      sweptAtTime: null,
      distancePct: 0,
      timeStart: 0,
    };
    const idx = new Map([[0, 0]]);
    const r = resolveStructuralTp('LONG', 100, 50, 5, [target('bearish', 110, 0)], [liq], cfg, idx);
    expect(r).toEqual({ price: 105, source: 'structural-liq' });
  });

  it('e2e: sin OB ni liquidez vigente → fallback 2R ETIQUETADO (tpSource fallbackFixedR)', () => {
    const intents = generateIntents('BTCUSDT', '15m', C_SERIES, { gatillo: 'C', tpRule: 'structural', ...LB2 });
    expect(intents).toHaveLength(1);
    const it = intents[0];
    const risk = Math.abs(it.entry - it.stopLoss);
    expect(it.takeProfit).toBeCloseTo(it.entry + 2 * risk, 6);
    expect(it.tpSource).toBe('fallbackFixedR');
  });

  it('e2e: con liquidez buyside confirmada encima, el TP structural apunta a ella', () => {
    // Swing high 114 (i2, confirmado en i4) = liquidez buyside · swing low 95 (i3, confirmado en
    // i5) · i6 barre el low (90 < 95) y reclama (102 > 95) → LONG con TP en la liquidez (114).
    const series: ObCandle[] = [
      oc(0, 105, 110, 100, 105),
      oc(1, 104, 109, 101, 104),
      oc(2, 103, 114, 100.5, 103), // swing high 114
      oc(3, 102, 107, 95, 102), // swing low 95
      oc(4, 101, 106, 100, 101), // confirma el high
      oc(5, 101, 104, 98, 102), // confirma el low
      oc(6, 102, 103, 90, 102), // sweep + reclaim → señal LONG
    ];
    const intents = generateIntents('BTCUSDT', '15m', series, { gatillo: 'C', tpRule: 'structural', ...LB2 });
    expect(intents).toHaveLength(1);
    expect(intents[0].tpSource).toBe('structural-liq');
    expect(intents[0].takeProfit).toBeCloseTo(114, 6);
  });
});

describe('runner TP (Ciclo 4 — CYCLE-4-PREREG §2)', () => {
  // Misma serie del e2e structural: liquidez buyside 114 confirmada encima de la señal LONG.
  const SERIES: ObCandle[] = [
    oc(0, 105, 110, 100, 105),
    oc(1, 104, 109, 101, 104),
    oc(2, 103, 114, 100.5, 103), // swing high 114
    oc(3, 102, 107, 95, 102), // swing low 95
    oc(4, 101, 106, 100, 101), // confirma el high
    oc(5, 101, 104, 98, 102), // confirma el low
    oc(6, 102, 103, 90, 102), // sweep + reclaim → señal LONG
  ];

  it('runnerTpLiquidity: el intent lleva el pool causal SIN tocar el TP nominal (2R)', () => {
    const intents = generateIntents('BTCUSDT', '15m', SERIES, { gatillo: 'C', runnerTpLiquidity: true, ...LB2 });
    expect(intents).toHaveLength(1);
    const it = intents[0];
    const risk = Math.abs(it.entry - it.stopLoss);
    expect(it.tpSource).toBe('fixedR'); // el TP nominal sigue siendo el 2R del candidato
    expect(it.takeProfit).toBeCloseTo(it.entry + 2 * risk, 6);
    expect(it.runnerTakeProfit).toBeCloseTo(114, 6); // y el runner apunta a la liquidez
    expect(it.runnerTpSource).toBe('liquidity');
  });

  it('sin pool vigente → runnerTpSource fallbackFixedR (el sim usará el TP nominal)', () => {
    const intents = generateIntents('BTCUSDT', '15m', C_SERIES, { gatillo: 'C', runnerTpLiquidity: true, ...LB2 });
    expect(intents).toHaveLength(1);
    expect(intents[0].runnerTakeProfit).toBeUndefined();
    expect(intents[0].runnerTpSource).toBe('fallbackFixedR');
  });

  it('N-invarianza: el flag NO cambia ids, entradas, SL ni TP (solo agrega los campos del runner)', () => {
    const base = generateIntents('BTCUSDT', '15m', SERIES, { gatillo: 'C', ...LB2 });
    const flagged = generateIntents('BTCUSDT', '15m', SERIES, { gatillo: 'C', runnerTpLiquidity: true, ...LB2 });
    expect(flagged.length).toBe(base.length);
    for (let i = 0; i < base.length; i++) {
      expect(flagged[i].id).toBe(base[i].id);
      expect(flagged[i].entry).toBe(base[i].entry);
      expect(flagged[i].stopLoss).toBe(base[i].stopLoss);
      expect(flagged[i].takeProfit).toBe(base[i].takeProfit);
      expect(flagged[i].cancelBeyond).toBe(base[i].cancelBeyond);
    }
    expect(base[0].runnerTakeProfit).toBeUndefined(); // sin flag, nada nuevo en el intent
    expect(base[0].runnerTpSource).toBeUndefined();
  });
});

describe('generateIntents — modo D (sweep → CHoCH → entrada FVG, Ciclo 3)', () => {
  // Serie construida para un setup D LONG completo:
  // - swing high 110 (idx1) y swing low 95 (idx3), ambos confirmados con lookback 2.
  // - idx7 barre el low 95 (low 90 < 95) y reclama (close 99 > 95) = sweep alcista.
  // - idx8 cierra 112 > 110 (el último swing high) = CHoCH alcista, con un FVG alcista en el impulso
  //   (idx7.high 100 < idx9.low 104 → gap [100,104]).
  const oc2 = (openTime: number, open: number, high: number, low: number, close: number): ObCandle => ({
    openTime, open, high, low, close,
  });
  const D_SERIES: ObCandle[] = [
    oc2(0, 105, 108, 102, 105),
    oc2(1, 105, 110, 103, 106), // swing high 110
    oc2(2, 106, 107, 100, 101),
    oc2(3, 101, 103, 95, 98), // swing low 95
    oc2(4, 98, 104, 96, 102),
    oc2(5, 102, 106, 99, 103),
    oc2(6, 103, 105, 98, 100),
    oc2(7, 100, 100, 90, 99), // sweep: low 90 < 95, reclama close 99 > 95 (high 100 = c1 del FVG)
    oc2(8, 99, 113, 99, 112), // CHoCH: close 112 > 110 (impulso; c2 del FVG)
    oc2(9, 112, 116, 104, 110), // c3 del FVG: low 104 > c1.high 100 → FVG alcista [100, 104]
    oc2(10, 110, 112, 101, 103), // retest hacia el FVG
  ];
  const LBD = { swingLookback: 2, slBufferFrac: 0.1, rMultipleTp: 2, minRr: 1, maxChochBars: 10 } as const;

  it('emite una entrada LONG en el CE del FVG tras el sweep + CHoCH', () => {
    const intents = generateIntents('BTCUSDT', '15m', D_SERIES, { gatillo: 'D', tpRule: 'fixedR', ...LBD });
    expect(intents).toHaveLength(1);
    const it = intents[0];
    expect(it.direction).toBe('LONG');
    expect(it.signalBarTime).toBe(9); // CHoCH en idx8, el FVG del impulso completa en idx9 → se conoce ahí
    expect(it.entry).toBeCloseTo((100 + 104) / 2, 6); // CE del FVG [100,104]
    expect(it.stopLoss).toBeCloseTo(100 - 0.1 * 4, 6); // borde inferior del FVG − buffer
    expect(it.context).toMatchObject({ zoneLow: 100, zoneHigh: 104 });
  });

  it('SIN CHoCH dentro de la ventana → no hay entrada (el filtro del Ciclo 3)', () => {
    // maxChochBars 0 ⇒ no se busca CHoCH ⇒ ningún sweep confirma.
    const intents = generateIntents('BTCUSDT', '15m', D_SERIES, { gatillo: 'D', tpRule: 'fixedR', ...LBD, maxChochBars: 0 });
    expect(intents).toHaveLength(0);
  });

  it('es CAUSAL: el intent se conoce en el CHoCH, no antes del sweep', () => {
    const intents = generateIntents('BTCUSDT', '15m', D_SERIES, { gatillo: 'D', tpRule: 'fixedR', ...LBD });
    // signalBarTime (8) es POSTERIOR al sweep (7) — nunca se adelanta.
    expect(intents[0].signalBarTime).toBeGreaterThan(7);
  });

  it('respeta el sesgo HTF: un setup D LONG se filtra si el 4H es bajista', () => {
    const conBear = generateIntents('BTCUSDT', '15m', D_SERIES, { gatillo: 'D', tpRule: 'fixedR', ...LBD }, [
      { time: 0, bias: 'bearish' },
    ]);
    expect(conBear).toHaveLength(0);
  });
});
