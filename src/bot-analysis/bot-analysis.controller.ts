import { Controller, Get, Query } from '@nestjs/common';
import { CandleRepository } from '../market-data/candle.repository';
import { GetBotQueryDto } from './dto/get-bot-query.dto';
import { detectStrictFvgs } from './fvg.detector';
import { detectOrderBlocks } from './ob.detector';
import { detectSweeps } from './sweep.detector';
import { detectLiquidity, DEFAULT_LIQ_PARAMS } from './liquidity.detector';
import { scoreConfluence } from './confluence.scorer';
import { detectSetups } from './setup.detector';
import { generateTradePlans } from './trade-plan.generator';
import { computeHtfBias, biasAt, type Bias } from '../backtest/htf-bias';

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
    const obs = detectOrderBlocks(q.symbol, q.tf, closed, q.obMode ? { obMode: q.obMode } : {});
    return { symbol: q.symbol, tf: q.tf, count: obs.length, obs };
  }

  // Sweep + reclaim (gatillo modo C de SMC-STRATEGY-MECHANICAL.md): barridos de liquidez sobre swings
  // con reclamo POR CUERPO. Read-only, función pura para el motor de backtest. NO es señal (Regla Cero).
  @Get('sweeps')
  async sweeps(@Query() q: GetBotQueryDto) {
    const closed = (await this.closedCandles(q.symbol, q.tf, q.limit)).map((c) => ({
      openTime: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    const sweeps = detectSweeps(q.symbol, q.tf, closed);
    return { symbol: q.symbol, tf: q.tf, count: sweeps.length, sweeps };
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

  // Sesgo HTF (4H por defecto): el MISMO que filtra al candidato congelado (BOS por CUERPO sobre el
  // último swing confirmado, causal). El bot solo busca LONGs con sesgo alcista y SHORTs con bajista.
  // Read-only (Regla Cero). El front lo usa en la vista En vivo para explicar el porqué de cada decisión.
  @Get('bias')
  async bias(@Query() q: GetBotQueryDto) {
    const closed = (await this.closedCandles(q.symbol, q.tf, q.limit)).map((c) => ({
      openTime: c.openTime,
      closeTime: c.closeTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    const points = computeHtfBias(closed);
    const lastTime = closed.length ? (closed[closed.length - 1].closeTime ?? closed[closed.length - 1].openTime) : 0;
    const lastChange = points.length ? points[points.length - 1] : null;
    return {
      symbol: q.symbol,
      tf: q.tf,
      bias: biasAt(points, lastTime),
      changedAt: lastChange?.time ?? null,
      points,
    };
  }

  // Watchlist: resumen por símbolo para monitorear los 10 de un vistazo (sesgo 4H + precio + la
  // próxima liquidez que el bot querría barrer a favor del sesgo). Read-only (Regla Cero).
  @Get('watchlist')
  async watchlist(@Query('symbols') symbols: string) {
    const syms = (symbols ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const items: { symbol: string; bias: Bias; price: number; target: { type: string; level: number; distPct: number } | null }[] = [];
    for (const symbol of syms) {
      const c4h = (await this.closedCandles(symbol, '4h', 600)).map((c) => ({
        openTime: c.openTime,
        closeTime: c.closeTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      const c15 = await this.closedCandles(symbol, '15m', 600);
      const points = computeHtfBias(c4h);
      const lastT = c4h.length ? (c4h[c4h.length - 1].closeTime ?? c4h[c4h.length - 1].openTime) : 0;
      const bias = biasAt(points, lastT);
      const price = c15.length ? c15[c15.length - 1].close : 0;
      const liqs = detectLiquidity(
        symbol,
        '15m',
        c15.map((c) => ({ openTime: c.openTime, high: c.high, low: c.low, close: c.close })),
        { ...DEFAULT_LIQ_PARAMS, swingLookback: 10 },
      );
      let target: { type: string; level: number; distPct: number } | null = null;
      if (bias !== 'neutral' && price > 0) {
        const cands =
          bias === 'bullish'
            ? liqs.filter((l) => (l.type === 'swingLow' || l.type === 'equalLow') && l.level < price).sort((a, b) => b.level - a.level)
            : liqs.filter((l) => (l.type === 'swingHigh' || l.type === 'equalHigh') && l.level > price).sort((a, b) => a.level - b.level);
        const t = cands[0];
        if (t) target = { type: t.type, level: t.level, distPct: Math.round(((t.level - price) / price) * 10000) / 100 };
      }
      items.push({ symbol, bias, price, target });
    }
    return { watchlist: items };
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

