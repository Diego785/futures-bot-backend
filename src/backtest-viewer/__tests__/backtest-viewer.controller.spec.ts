import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { BacktestViewerController } from '../backtest-viewer.controller';
import { BacktestRunRepository } from '../../backtest/backtest-run.repository';
import { CandleRepository } from '../../market-data/candle.repository';

const RUN = {
  id: 'bt_1',
  symbol: 'BTCUSDT',
  tf: '15m',
  paramsHash: 'abc123',
  params: { signal: { swingLookback: 2 } },
};
const SIGNALS = [
  { runId: 'bt_1', intentId: 'C_1_u', outcome: 'filled', signalBarTime: 100 },
  { runId: 'bt_1', intentId: 'C_2_d', outcome: 'rejected', signalBarTime: 200 },
];

// Velas sintéticas con un swing low confirmado (lookback 2) para que el contexto derive ALGO.
const M = 900_000; // 15m
const oc = (i: number, o: number, h: number, l: number, c: number) => ({
  openTime: i * M,
  open: o,
  high: h,
  low: l,
  close: c,
  isClosed: true,
});
const CANDLES = [
  oc(0, 105, 110, 100, 105),
  oc(1, 104, 109, 101, 104),
  oc(2, 103, 108, 95, 103), // swing low 95 (lookback 2)
  oc(3, 102, 107, 101, 102),
  oc(4, 101, 106, 100, 101),
  oc(5, 101, 104, 99, 102),
];

describe('BacktestViewerController (read-only)', () => {
  let controller: BacktestViewerController;
  const repo = {
    listRuns: jest.fn(),
    getRun: jest.fn(),
    getSignals: jest.fn(),
  };
  const candles = { findCandles: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    repo.listRuns.mockResolvedValue([RUN]);
    repo.getSignals.mockResolvedValue(SIGNALS);
    candles.findCandles.mockResolvedValue(CANDLES);
    const module = await Test.createTestingModule({
      controllers: [BacktestViewerController],
      providers: [
        { provide: BacktestRunRepository, useValue: repo },
        { provide: CandleRepository, useValue: candles },
      ],
    }).compile();
    controller = module.get(BacktestViewerController);
  });

  it('GET runs lista las corridas registradas', async () => {
    const res = await controller.list();
    expect(res).toEqual({ count: 1, runs: [RUN] });
  });

  it('GET runs/:id devuelve la corrida con TODO su embudo de señales', async () => {
    repo.getRun.mockResolvedValue(RUN);
    const res = await controller.byId('bt_1');
    expect(repo.getSignals).toHaveBeenCalledWith('bt_1');
    expect(res).toEqual({ run: RUN, count: 2, signals: SIGNALS });
  });

  it('GET runs/:id → 404 si la corrida no existe', async () => {
    repo.getRun.mockResolvedValue(null);
    await expect(controller.byId('bt_nope')).rejects.toThrow(NotFoundException);
    expect(repo.getSignals).not.toHaveBeenCalled();
  });

  it('GET runs/:id/context re-deriva OBs y liquidez del rango con warmup previo', async () => {
    repo.getRun.mockResolvedValue(RUN);
    const from = 3 * M;
    const to = 5 * M;
    const res = await controller.context('bt_1', { from, to });
    // Pide velas con warmup ANTES del rango (la re-derivación necesita historia previa).
    expect(candles.findCandles).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'BTCUSDT', tf: '15m', to, from: from - 1500 * M }),
    );
    expect(res.runId).toBe('bt_1');
    expect(Array.isArray(res.obs)).toBe(true);
    expect(Array.isArray(res.liquidity)).toBe(true);
    // El swing low 95 (vela 2, confirmado en la vela 4) entra como liquidez sellside visible.
    const sell = res.liquidity.find((l) => l.side === 'sellside' && l.level === 95);
    expect(sell).toBeDefined();
    expect(sell?.visibleFromTime).toBe(4 * M); // pivote idx2 + lookback 2 → vela idx4
  });

  it('GET runs/:id/context → 404 si la corrida no existe', async () => {
    repo.getRun.mockResolvedValue(null);
    await expect(controller.context('bt_nope', { from: 0, to: 1 })).rejects.toThrow(NotFoundException);
  });
});
