import { Controller, Get, Query } from '@nestjs/common';
import { PaperTradeRepository } from './paper-trade.repository';
import { PaperTradingService } from './paper-trading.service';

/**
 * Lectura mínima del paper-test (P.2; el dashboard completo es P.3). READ-ONLY.
 */
@Controller('api/paper')
export class PaperTradingController {
  constructor(
    private readonly trades: PaperTradeRepository,
    private readonly service: PaperTradingService,
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
}
