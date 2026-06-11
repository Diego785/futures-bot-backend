import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { BacktestViewerController } from '../backtest-viewer.controller';
import { BacktestRunRepository } from '../../backtest/backtest-run.repository';

const RUN = { id: 'bt_1', symbol: 'BTCUSDT', tf: '15m', paramsHash: 'abc123' };
const SIGNALS = [
  { runId: 'bt_1', intentId: 'C_1_u', outcome: 'filled', signalBarTime: 100 },
  { runId: 'bt_1', intentId: 'C_2_d', outcome: 'rejected', signalBarTime: 200 },
];

describe('BacktestViewerController (read-only)', () => {
  let controller: BacktestViewerController;
  const repo = {
    listRuns: jest.fn().mockResolvedValue([RUN]),
    getRun: jest.fn(),
    getSignals: jest.fn().mockResolvedValue(SIGNALS),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    repo.listRuns.mockResolvedValue([RUN]);
    repo.getSignals.mockResolvedValue(SIGNALS);
    const module = await Test.createTestingModule({
      controllers: [BacktestViewerController],
      providers: [{ provide: BacktestRunRepository, useValue: repo }],
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
});
