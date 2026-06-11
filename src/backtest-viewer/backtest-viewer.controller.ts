import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { BacktestRunRepository } from '../backtest/backtest-run.repository';
import { CandleRepository } from '../market-data/candle.repository';
import { tfToMs } from '../market-data/candle-ingest.service';
import { detectOrderBlocks, computeStateTimeline } from '../bot-analysis/ob.detector';
import { detectLiquidity, DEFAULT_LIQ_PARAMS } from '../bot-analysis/liquidity.detector';
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
    const idxOfTime = new Map<number, number>();
    closed.forEach((c, i) => idxOfTime.set(c.openTime, i));

    // OBs vivos en algún punto de [from, to], con sus transiciones (el front filtra por cursor).
    const obs = detectOrderBlocks(run.symbol, run.tf, closed, {
      swingLookback,
      showLastBullish: Number.MAX_SAFE_INTEGER,
      showLastBearish: Number.MAX_SAFE_INTEGER,
    })
      .filter((o) => o.confirmedAtTime <= q.to)
      .map((o) => {
        const ci = idxOfTime.get(o.confirmedAtTime);
        const tl = computeStateTimeline(closed, (ci ?? closed.length) + 1, o.direction, o.obLow, o.obHigh);
        return {
          id: o.id,
          direction: o.direction,
          originTime: o.originTime,
          confirmedAtTime: o.confirmedAtTime,
          obLow: o.obLow,
          obHigh: o.obHigh,
          ...tl,
        };
      })
      .filter((o) => o.invalidatedAt == null || o.invalidatedAt >= q.from);

    // Liquidez (mismo lookback que los sweeps del candidato): visible desde que su último pivote
    // queda CONFIRMADO (lookback velas después), hasta su barrido.
    const liquidity = detectLiquidity(run.symbol, run.tf, closed, {
      ...DEFAULT_LIQ_PARAMS,
      swingLookback,
      showSweptLiquidity: true,
      maxDistanceFromPricePct: null,
      maxLevels: Number.MAX_SAFE_INTEGER,
    })
      .map((l) => {
        const lastPivotTime = l.candleTimes[l.candleTimes.length - 1];
        const li = idxOfTime.get(lastPivotTime);
        const confIdx = li != null ? li + swingLookback : -1;
        const visibleFromTime = confIdx >= 0 && confIdx < closed.length ? closed[confIdx].openTime : null;
        return {
          id: l.id,
          type: l.type,
          side: l.side,
          level: l.level,
          timeStart: l.timeStart,
          lastPivotTime,
          visibleFromTime,
          sweptAtTime: l.sweptAtTime,
        };
      })
      .filter(
        (l) =>
          l.visibleFromTime != null &&
          l.visibleFromTime <= q.to &&
          (l.sweptAtTime == null || l.sweptAtTime >= q.from),
      );

    return { runId: id, symbol: run.symbol, tf: run.tf, from: q.from, to: q.to, obs, liquidity };
  }
}
