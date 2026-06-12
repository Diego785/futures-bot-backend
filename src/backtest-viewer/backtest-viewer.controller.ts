import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { BacktestRunRepository } from '../backtest/backtest-run.repository';
import { CandleRepository } from '../market-data/candle.repository';
import { tfToMs } from '../market-data/candle-ingest.service';
import { buildSmcContext } from './smc-context';
import { GetContextQueryDto } from './dto/get-context-query.dto';

// Velas previas al rango pedido para que los OBs/swings vigentes al inicio de la ventana existan
// (re-derivación local: un OB confirmado mucho antes del warmup no aparece — contexto acotado).
const WARMUP_BARS = 1500;

/**
 * VISOR DE BACKTESTS — endpoints READ-ONLY sobre las corridas registradas por el CLI.
 * No corre backtests ni toca el exchange (Regla Cero): sirve lo registrado + el CONTEXTO SMC
 * re-derivado causalmente (cada objeto con sus tiempos de transición) para el replay.
 */
@Controller('api/backtest')
export class BacktestViewerController {
  constructor(
    private readonly repo: BacktestRunRepository,
    private readonly candles: CandleRepository,
  ) {}

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

  /**
   * Contexto SMC de una ventana del replay: OBs (con la LÍNEA DE TIEMPO de sus estados) y niveles
   * de liquidez (con su barrido). Re-derivado a demanda desde las velas (determinista y causal:
   * cada transición lleva su timestamp y el frontend solo dibuja lo conocido en el cursor).
   */
  @Get('runs/:id/context')
  async context(@Param('id') id: string, @Query() q: GetContextQueryDto) {
    const run = await this.repo.getRun(id);
    if (!run) throw new NotFoundException(`backtest run '${id}' no existe`);
    const params = run.params as { signal?: { swingLookback?: number } };
    const swingLookback = params.signal?.swingLookback ?? 10;
    const tfMs = tfToMs(run.tf);

    const rows = await this.candles.findCandles({
      symbol: run.symbol,
      tf: run.tf,
      from: q.from - WARMUP_BARS * tfMs,
      to: q.to,
      limit: WARMUP_BARS + 2000,
    });
    const closed = rows
      .filter((r) => r.isClosed)
      .map((r) => ({ openTime: r.openTime, open: r.open, high: r.high, low: r.low, close: r.close }));
    const ctx = buildSmcContext(run.symbol, run.tf, closed, swingLookback, q.from, q.to);
    return { runId: id, symbol: run.symbol, tf: run.tf, from: q.from, to: q.to, ...ctx };
  }
}
