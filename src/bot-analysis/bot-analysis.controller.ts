import { Controller, Get, Query } from '@nestjs/common';
import { CandleRepository } from '../market-data/candle.repository';
import { GetBotQueryDto } from './dto/get-bot-query.dto';
import { detectStrictFvgs } from './fvg.detector';
import { detectOrderBlocks } from './ob.detector';
import { detectLiquidity } from './liquidity.detector';
import { scoreConfluence } from './confluence.scorer';
import { detectSetups } from './setup.detector';
import { generateTradePlans } from './trade-plan.generator';

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

  @Get('liquidity')
  async liquidity(@Query() q: GetBotQueryDto) {
    const closed = (await this.closedCandles(q.symbol, q.tf, q.limit)).map((c) => ({
      openTime: c.openTime,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    const levels = detectLiquidity(q.symbol, q.tf, closed);
    return { symbol: q.symbol, tf: q.tf, count: levels.length, levels };
  }

  @Get('confluence')
  async confluence(@Query() q: GetBotQueryDto) {
    const rows = await this.closedCandles(q.symbol, q.tf, q.limit);
    const lastClose = rows.length ? rows[rows.length - 1].close : 0;
    const fvgs = detectStrictFvgs(q.symbol, q.tf, rows.map((c) => ({ openTime: c.openTime, high: c.high, low: c.low })));
    const obs = detectOrderBlocks(q.symbol, q.tf, rows.map((c) => ({ openTime: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close })));
    const liqs = detectLiquidity(q.symbol, q.tf, rows.map((c) => ({ openTime: c.openTime, high: c.high, low: c.low, close: c.close })));
    const zones = scoreConfluence(q.symbol, q.tf, fvgs, obs, liqs, lastClose);
    return { symbol: q.symbol, tf: q.tf, count: zones.length, zones };
  }

  @Get('setups')
  async setups(@Query() q: GetBotQueryDto) {
    const rows = await this.closedCandles(q.symbol, q.tf, q.limit);
    const lastClose = rows.length ? rows[rows.length - 1].close : 0;
    const fvgs = detectStrictFvgs(q.symbol, q.tf, rows.map((c) => ({ openTime: c.openTime, high: c.high, low: c.low })));
    const obs = detectOrderBlocks(q.symbol, q.tf, rows.map((c) => ({ openTime: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close })));
    const liqs = detectLiquidity(q.symbol, q.tf, rows.map((c) => ({ openTime: c.openTime, high: c.high, low: c.low, close: c.close })));
    const zones = scoreConfluence(q.symbol, q.tf, fvgs, obs, liqs, lastClose);
    const candles = rows.map((c) => ({ openTime: c.openTime, high: c.high, low: c.low, close: c.close }));
    const setups = detectSetups(q.symbol, q.tf, zones, obs, candles, lastClose);
    return { symbol: q.symbol, tf: q.tf, count: setups.length, setups };
  }

  // Trade Plans candidatos (Fase 5F-A): solo desde setups ARMED. SUGERENCIA, no orden (Regla Cero).
  @Get('plans')
  async plans(@Query() q: GetBotQueryDto) {
    const rows = await this.closedCandles(q.symbol, q.tf, q.limit);
    const lastClose = rows.length ? rows[rows.length - 1].close : 0;
    const fvgs = detectStrictFvgs(q.symbol, q.tf, rows.map((c) => ({ openTime: c.openTime, high: c.high, low: c.low })));
    const obs = detectOrderBlocks(q.symbol, q.tf, rows.map((c) => ({ openTime: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close })));
    const liqs = detectLiquidity(q.symbol, q.tf, rows.map((c) => ({ openTime: c.openTime, high: c.high, low: c.low, close: c.close })));
    const zones = scoreConfluence(q.symbol, q.tf, fvgs, obs, liqs, lastClose);
    const candles = rows.map((c) => ({ openTime: c.openTime, high: c.high, low: c.low, close: c.close }));
    const setups = detectSetups(q.symbol, q.tf, zones, obs, candles, lastClose);
    const mode = q.mode ?? 'confirmation';
    const plans = generateTradePlans(q.symbol, q.tf, setups, obs, liqs, lastClose, mode);
    return {
      symbol: q.symbol,
      tf: q.tf,
      mode,
      count: plans.length,
      confirmationCount: plans.filter((p) => p.mode === 'confirmation').length,
      riskCount: plans.filter((p) => p.mode === 'risk').length,
      plans,
    };
  }
}

