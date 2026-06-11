import { buildSignalRows, makeParamsHash } from '../register.mapper';
import type { IntentReject } from '../signal-source';
import type { SimResult, TradeIntent } from '../trade-simulator';

const intent = (id: string, signalBarTime: number): TradeIntent => ({
  id,
  symbol: 'BTCUSDT',
  tf: '15m',
  direction: 'LONG',
  signalBarTime,
  entry: 100,
  stopLoss: 97,
  takeProfit: 106,
  invalidationPrice: 98,
  cancelBeyond: 109,
  context: { zoneLow: 98, zoneHigh: 102, sweptLevel: 102, wickExtreme: 98, sweptSwingTime: 10 },
});

describe('makeParamsHash', () => {
  it('es estable para el mismo objeto y cambia si un parámetro cambia', () => {
    const a = { symbol: 'BTCUSDT', signal: { swingLookback: 10 } };
    expect(makeParamsHash(a)).toBe(makeParamsHash({ symbol: 'BTCUSDT', signal: { swingLookback: 10 } }));
    expect(makeParamsHash(a)).toHaveLength(12);
    expect(makeParamsHash(a)).not.toBe(makeParamsHash({ symbol: 'BTCUSDT', signal: { swingLookback: 12 } }));
  });
});

describe('buildSignalRows — el embudo completo de la corrida', () => {
  it('mapea filled (con trade), cancelled (con razón) y rejected (con razón y zona)', () => {
    const filled = intent('C_x_1_u', 100);
    const cancelled = intent('C_x_2_u', 200);
    const results: SimResult[] = [
      {
        intentId: filled.id,
        outcome: 'filled',
        trade: {
          id: filled.id,
          symbol: 'BTCUSDT',
          tf: '15m',
          direction: 'LONG',
          signalBarTime: 100,
          entryTime: 110,
          entryPrice: 100,
          exitTime: 130,
          exitPrice: 106,
          exitReason: 'TP',
          stopLoss: 97,
          takeProfit: 106,
          grossR: 2,
          costR: 0.05,
          rMultiple: 1.95,
          barsToFill: 1,
          barsHeld: 2,
          movedToBE: true,
        },
      },
      { intentId: cancelled.id, outcome: 'cancelled', reason: 'ranAway', endTime: 250 },
    ];
    const rejects: IntentReject[] = [
      { id: 'C_x_3_d', direction: 'SHORT', signalBarTime: 300, zoneLow: 120, zoneHigh: 125, reason: 'htfBias' },
    ];

    const rows = buildSignalRows('bt_1', [filled, cancelled], rejects, results);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.signalBarTime)).toEqual([100, 200, 300]); // orden temporal

    const f = rows[0];
    expect(f).toMatchObject({
      runId: 'bt_1',
      intentId: 'C_x_1_u',
      outcome: 'filled',
      reason: null,
      entry: 100,
      stopLoss: 97,
      takeProfit: 106,
      zoneLow: 98,
      zoneHigh: 102,
      sweptLevel: 102,
      exitReason: 'TP',
      rMultiple: 1.95,
      movedToBE: true,
    });

    const c = rows[1];
    expect(c).toMatchObject({
      outcome: 'cancelled',
      reason: 'ranAway',
      endTime: 250, // cuándo murió la pendiente (replay causal)
      entry: 100,
      exitTime: null,
      rMultiple: null,
    });

    const r = rows[2];
    expect(r).toMatchObject({
      outcome: 'rejected',
      reason: 'htfBias',
      direction: 'SHORT',
      zoneLow: 120,
      zoneHigh: 125,
      entry: null,
      stopLoss: null,
      rMultiple: null,
    });
  });

  it('un intent sin resultado (caso defensivo) queda como expired sin razón', () => {
    const it = intent('C_x_9_u', 900);
    const rows = buildSignalRows('bt_1', [it], [], []);
    expect(rows[0]).toMatchObject({ outcome: 'expired', reason: null });
  });
});
