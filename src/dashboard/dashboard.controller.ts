import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Signal } from '../trading/entities/signal.entity';
import { Trade } from '../trading/entities/trade.entity';
import { DailyPnl } from '../trading/entities/daily-pnl.entity';
import { BinanceRestService } from '../binance/binance-rest.service';
import { StartBotDto } from './dto/bot-control.dto';
import { PaginatedQueryDto } from './dto/paginated-query.dto';
import { BotStateService } from '../bot/bot-state.service';
import { KillSwitchService } from '../bot/kill-switch.service';
import { PreFilterGateService } from '../strategy/pre-filter-gate.service';
import { DashboardGateway } from './dashboard.gateway';
import { FcmService } from '../notifications/fcm.service';

@Controller('api')
export class DashboardController {
  private readonly logger = new Logger(DashboardController.name);

  constructor(
    private readonly botState: BotStateService,
    private readonly killSwitch: KillSwitchService,
    private readonly binanceRest: BinanceRestService,
    private readonly preFilterGate: PreFilterGateService,
    private readonly dashboardGateway: DashboardGateway,
    private readonly fcmService: FcmService,
    @InjectRepository(Signal)
    private readonly signalRepo: Repository<Signal>,
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    @InjectRepository(DailyPnl)
    private readonly dailyPnlRepo: Repository<DailyPnl>,
  ) {}

  @Get('status')
  async getStatus() {
    const state = this.botState.getState();
    let balance: import('../common/interfaces/binance.interfaces').BinanceAccountBalance | null = null;
    let position: import('../common/interfaces/binance.interfaces').BinancePositionRisk | null = null;

    try {
      const balances = await this.binanceRest.getAccountBalance();
      balance = balances.find((b) => b.asset === 'USDT') ?? null;
    } catch (err) {
      console.error('Balance fetch failed:', err?.response?.data || err?.message || err);
    }

    try {
      const positions = await this.binanceRest.getPositionRisk(
        state.symbol,
      );
      position = positions.find(
        (p) => parseFloat(p.positionAmt) !== 0,
      ) ?? null;
    } catch (err) {
      console.error('Position fetch failed:', err?.response?.data || err?.message || err);
    }

    const today = new Date().toISOString().split('T')[0];
    const dailyPnl = await this.dailyPnlRepo.findOne({
      where: { date: today },
    });

    return {
      bot: state,
      balance: balance
        ? {
            total: balance.balance,
            available: balance.availableBalance,
            unrealizedPnl: balance.crossUnPnl,
          }
        : null,
      position,
      dailyPnl: dailyPnl
        ? {
            pnl: dailyPnl.realizedPnl,
            trades: dailyPnl.tradesCount,
            wins: dailyPnl.winsCount,
            losses: dailyPnl.lossesCount,
          }
        : null,
      rateLimit: this.binanceRest.getUsedWeight(),
      gate: this.preFilterGate.getStats(),
    };
  }

  @Post('bot/start')
  async startBot(@Body() dto: StartBotDto) {
    this.botState.start(dto.symbol, dto.timeframe);
    this.logger.log(
      `Bot started: ${this.botState.symbol} ${this.botState.timeframe}`,
    );
    return { success: true, state: this.botState.getState() };
  }

  @Post('bot/stop')
  stopBot() {
    this.botState.stop();
    this.logger.log('Bot stopped');
    return { success: true, state: this.botState.getState() };
  }

  @Post('bot/kill')
  async killBot() {
    await this.killSwitch.activate('Manual kill switch via API');
    return { success: true, message: 'Kill switch activated' };
  }

  @Get('trades')
  async getTrades(@Query() query: PaginatedQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [trades, total] = await this.tradeRepo.findAndCount({
      order: { openedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
      relations: ['orders'],
    });

    return { data: trades, total, page, limit };
  }

  @Get('trades/:id')
  async getTradeById(@Param('id') id: string) {
    return this.tradeRepo.findOne({
      where: { id },
      relations: ['orders', 'signal'],
    });
  }

  @Get('signals')
  async getSignals(@Query() query: PaginatedQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [signals, total] = await this.signalRepo.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data: signals, total, page, limit };
  }

  @Get('positions')
  async getPositions() {
    try {
      const positions = await this.binanceRest.getPositionRisk();
      return positions.filter((p) => parseFloat(p.positionAmt) !== 0);
    } catch {
      return [];
    }
  }

  @Get('balance')
  async getBalance() {
    try {
      const balances = await this.binanceRest.getAccountBalance();
      return balances.find((b) => b.asset === 'USDT') ?? null;
    } catch {
      return null;
    }
  }

  @Post('fcm-token')
  registerFcmToken(@Body() body: { token: string }) {
    if (body.token) {
      this.fcmService.registerToken(body.token);
      return { success: true };
    }
    return { success: false, error: 'No token provided' };
  }

  @Get('last-analysis')
  getLastAnalysis() {
    return this.dashboardGateway.getLastAnalysis();
  }

  @Get('analysis-history')
  getAnalysisHistory() {
    return this.dashboardGateway.getAnalysisHistory();
  }

  @Get('last-gate')
  getLastGate() {
    return this.dashboardGateway.getLastGateResult();
  }

  @Get('daily-pnl')
  async getDailyPnl(@Query('days') days = 30) {
    const records = await this.dailyPnlRepo.find({
      order: { date: 'DESC' },
      take: days,
    });
    return records;
  }

}
