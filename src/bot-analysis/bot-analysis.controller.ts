import { Controller, Get, Query } from '@nestjs/common';
import { CandleRepository } from '../market-data/candle.repository';
import { GetFvgQueryDto } from './dto/get-fvg-query.dto';
import { detectStrictFvgs } from './fvg.detector';

/**
 * Lectura automática del bot (Fase 5A). Read-only sobre las velas locales: NO llama al
 * exchange, NO usa credenciales, NO genera señales ni entradas. La capa StrictFVG es solo
 * visual/comparativa: el usuario contrasta su análisis contra lo que "ve" el bot.
 */
@Controller('api/bot')
export class BotAnalysisController {
  constructor(private readonly candles: CandleRepository) {}

  @Get('fvg')
  async fvg(@Query() q: GetFvgQueryDto) {
    const rows = await this.candles.findCandles({ symbol: q.symbol, tf: q.tf, limit: q.limit });
    // Solo velas CERRADAS (sin repaint): la vela en formación nunca crea/altera un FVG.
    const closed = rows
      .filter((c) => c.isClosed)
      .map((c) => ({ openTime: c.openTime, high: c.high, low: c.low }));
    const fvgs = detectStrictFvgs(q.symbol, q.tf, closed);
    return { symbol: q.symbol, tf: q.tf, count: fvgs.length, fvgs };
  }
}
