import { Controller, Get, Query } from '@nestjs/common';
import { CandleRepository } from '../market-data/candle.repository';
import { GetBotQueryDto } from './dto/get-bot-query.dto';
import { detectStrictFvgs } from './fvg.detector';
import { detectOrderBlocks } from './ob.detector';

/**
 * Lectura automática del bot (Fase 5A/5B). Read-only sobre las velas locales: NO llama al
 * exchange, NO usa credenciales, NO genera señales ni entradas. Las capas StrictFVG y OB son
 * solo visuales/comparativas: el usuario contrasta su análisis contra lo que "ve" el bot.
 */
@Controller('api/bot')
export class BotAnalysisController {
  constructor(private readonly candles: CandleRepository) {}

  private async closedCandles(symbol: string, tf: string, limit: number) {
    const rows = await this.candles.findCandles({ symbol, tf, limit });
    // Solo velas CERRADAS (sin repaint): la vela en formación nunca crea/altera una zona.
    return rows.filter((c) => c.isClosed);
  }

  @Get('fvg')
  async fvg(@Query() q: GetBotQueryDto) {
    const closed = (await this.closedCandles(q.symbol, q.tf, q.limit)).map((c) => ({
      openTime: c.openTime,
      high: c.high,
      low: c.low,
    }));
    const fvgs = detectStrictFvgs(q.symbol, q.tf, closed);
    return { symbol: q.symbol, tf: q.tf, count: fvgs.length, fvgs };
  }

  @Get('ob')
  async ob(@Query() q: GetBotQueryDto) {
    const closed = (await this.closedCandles(q.symbol, q.tf, q.limit)).map((c) => ({
      openTime: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    const obs = detectOrderBlocks(q.symbol, q.tf, closed);
    return { symbol: q.symbol, tf: q.tf, count: obs.length, obs };
  }
}
