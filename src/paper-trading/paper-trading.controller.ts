import { Controller, Get, Query } from '@nestjs/common';
import { CandleRepository } from '../market-data/candle.repository';
import { tfToMs } from '../market-data/candle-ingest.service';
import { buildSmcContext } from '../backtest-viewer/smc-context';
import { GetPaperContextQueryDto } from './dto/get-paper-context-query.dto';
import { PaperTradeRepository } from './paper-trade.repository';
import { PaperTradingService } from './paper-trading.service';
import { FROZEN_SIGNAL, PAPER_TF } from './frozen-candidate';

const WARMUP_BARS = 1500;

/**
 * Lectura del paper-test (P.3). READ-ONLY: estado del motor, historial mecánico completo y el
 * contexto SMC causal de una ventana (misma derivación que el visor de backtests).
 */
@Controller('api/paper')
export class PaperTradingController {
  constructor(
    private readonly trades: PaperTradeRepository,
    private readonly service: PaperTradingService,
    private readonly candles: CandleRepository,
  ) {}

  @Get('status')
  status() {
    return this.service.status();
  }

  @Get('trades')
  async list(@Query('limit') limit?: string) {
    const n = Math.min(Math.max(parseInt(limit ?? '500', 10) || 500, 1), 5000);
    const trades = await this.trades.findAll(n);
    return { count: trades.length, trades };
  }

  /** Contexto SMC (OBs + liquidez, tiempos causales) para la gráfica de una posición del paper. */
  @Get('context')
  async context(@Query() q: GetPaperContextQueryDto) {
    const sym = q.symbol.toUpperCase();
    const tfMs = tfToMs(PAPER_TF);
    const rows = await this.candles.findCandles({
      symbol: sym,
      tf: PAPER_TF,
      from: q.from - WARMUP_BARS * tfMs,
      to: q.to,
      limit: WARMUP_BARS + 2000,
    });
    const closed = rows
      .filter((r) => r.isClosed)
      .map((r) => ({ openTime: r.openTime, open: r.open, high: r.high, low: r.low, close: r.close }));
    const ctx = buildSmcContext(sym, PAPER_TF, closed, FROZEN_SIGNAL.swingLookback, q.from, q.to);
    return { symbol: sym, tf: PAPER_TF, from: q.from, to: q.to, ...ctx };
  }
}
