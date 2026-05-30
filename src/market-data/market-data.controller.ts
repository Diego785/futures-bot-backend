import { Controller, Get, Query } from '@nestjs/common';
import { CandleRepository } from './candle.repository';
import { GetCandlesQueryDto } from './dto/get-candles-query.dto';
import { toCandleDto } from './candle.presenter';

/**
 * API read-only de velas (Fase 3, Commit 5). Lee SOLO de la DB local; nunca llama al
 * exchange ni usa credenciales. Vive aquí (no en DashboardController) para que market data
 * sea dueño de sus datos. Sin SMC, sin señales.
 */
@Controller('api')
export class MarketDataController {
  constructor(private readonly repo: CandleRepository) {}

  @Get('candles')
  async getCandles(@Query() q: GetCandlesQueryDto) {
    const rows = await this.repo.findCandles({
      symbol: q.symbol,
      tf: q.tf,
      from: q.from,
      to: q.to,
      cursor: q.cursor,
      before: q.before,
      limit: q.limit,
    });
    const candles = rows.map(toCandleDto);
    // Para "cargar más historial": si la página llegó llena, la vela más antigua marca
    // desde dónde seguir hacia atrás (el front pasa before = oldestOpenTime).
    const full = candles.length === q.limit && candles.length > 0;
    const oldestOpenTime = candles.length > 0 ? candles[0].openTime : null;
    const newestOpenTime = candles.length > 0 ? candles[candles.length - 1].openTime : null;
    return {
      symbol: q.symbol,
      tf: q.tf,
      count: candles.length,
      oldestOpenTime,
      newestOpenTime,
      hasMoreOlder: full,
      candles,
    };
  }
}
