import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { BacktestRunRepository } from '../backtest/backtest-run.repository';

/**
 * VISOR DE BACKTESTS (V.1) — endpoints READ-ONLY sobre las corridas registradas por el CLI.
 * No corre backtests ni toca el exchange (Regla Cero): solo sirve lo ya registrado para que el
 * frontend reproduzca la corrida (replay causal) y el usuario audite cada señal del embudo.
 */
@Controller('api/backtest')
export class BacktestViewerController {
  constructor(private readonly repo: BacktestRunRepository) {}

  @Get('runs')
  async list() {
    const runs = await this.repo.listRuns();
    return { count: runs.length, runs };
  }

  @Get('runs/:id')
  async byId(@Param('id') id: string) {
    const run = await this.repo.getRun(id);
    if (!run) throw new NotFoundException(`backtest run '${id}' no existe`);
    const signals = await this.repo.getSignals(id);
    return { run, count: signals.length, signals };
  }
}
