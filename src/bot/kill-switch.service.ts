import { Injectable, Logger } from '@nestjs/common';
import { BotStateService } from './bot-state.service';
import { ExecutionService } from '../trading/execution.service';
import { BinanceMarketWsService } from '../binance/binance-market-ws.service';
import { BinanceUserWsService } from '../binance/binance-user-ws.service';
import { DashboardGateway } from '../dashboard/dashboard.gateway';

@Injectable()
export class KillSwitchService {
  private readonly logger = new Logger(KillSwitchService.name);

  constructor(
    private readonly botState: BotStateService,
    private readonly execution: ExecutionService,
    private readonly binanceMarketWs: BinanceMarketWsService,
    private readonly binanceUserWs: BinanceUserWsService,
    private readonly dashboardGateway: DashboardGateway,
  ) {}

  async activate(reason: string): Promise<void> {
    this.logger.error(`KILL SWITCH ACTIVATED: ${reason}`);

    // 1. Disable bot immediately
    this.botState.stop();

    // 2. Close all positions for the active symbol
    await this.execution.closeAllPositions(this.botState.symbol);

    // 3. Disconnect WebSockets
    this.binanceMarketWs.unsubscribe();
    await this.binanceUserWs.stop();

    // 4. Notify dashboard
    this.dashboardGateway.emitError(`Kill switch activated: ${reason}`);
    this.dashboardGateway.emitBotStatus(
      this.botState.getState() as unknown as Record<string, unknown>,
    );
  }
}
