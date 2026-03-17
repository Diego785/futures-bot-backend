import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../common/constants/binance.constants';
import { BotStateService } from './bot-state.service';
import { SignalGeneratorService } from '../strategy/signal-generator.service';
import { RiskManagerService } from '../trading/risk-manager.service';
import { ExecutionService } from '../trading/execution.service';
import { Signal } from '../trading/entities/signal.entity';
import { DashboardGateway } from '../dashboard/dashboard.gateway';

interface StrategyCycleJobData {
  symbol: string;
  interval: string;
  candleCloseTime: number;
}

@Processor(QUEUE_NAMES.STRATEGY_CYCLE, { concurrency: 1 })
export class StrategyCycleProcessor extends WorkerHost {
  private readonly logger = new Logger(StrategyCycleProcessor.name);

  constructor(
    private readonly botState: BotStateService,
    private readonly signalGenerator: SignalGeneratorService,
    private readonly riskManager: RiskManagerService,
    private readonly execution: ExecutionService,
    private readonly dashboardGateway: DashboardGateway,
    @InjectRepository(Signal)
    private readonly signalRepo: Repository<Signal>,
  ) {
    super();
  }

  async process(job: Job<StrategyCycleJobData>): Promise<void> {
    const { symbol, interval, candleCloseTime } = job.data;

    this.logger.log(
      `Strategy cycle: ${symbol} ${interval} candle=${new Date(candleCloseTime).toISOString()}`,
    );

    // 1. Check bot is still enabled
    if (!this.botState.enabled) {
      this.logger.log('Bot is disabled, skipping');
      return;
    }

    // 2. Generate signal (indicators + SMC + gate + cache + DeepSeek)
    const result = await this.signalGenerator.generateSignal(
      symbol,
      interval,
    );

    // 3. Emit gate result and analysis to dashboard
    if (result.gateResult) {
      this.dashboardGateway.emitGateResult(
        result.gateResult as unknown as Record<string, unknown>,
      );
    }
    if (result.analysis) {
      this.dashboardGateway.emitAnalysisComplete(
        result.analysis as unknown as Record<string, unknown>,
      );
    }

    if (!result.signal) {
      if (result.gateResult && !result.gateResult.passed) {
        this.logger.log(
          `Gate SKIP: ${result.gateResult.reason} (score: ${result.gateResult.score})`,
        );
      } else if (result.cacheHit) {
        this.logger.log('Cache HIT: conditions unchanged, skipping DeepSeek');
      } else {
        this.logger.log('No actionable signal (HOLD or validation failed)');
      }
      return;
    }

    const signal = result.signal;

    // 4. Save signal to DB (status: PENDING)
    const signalEntity = this.signalRepo.create({
      symbol: signal.symbol,
      action: signal.action,
      confidence: signal.confidence,
      reasoning: signal.reasoning,
      entryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      atr: signal.atr,
      rsi: signal.rsi,
      status: 'PENDING',
    });
    await this.signalRepo.save(signalEntity);

    // 5. Emit signal to dashboard
    this.dashboardGateway.emitSignal(signalEntity as unknown as Record<string, unknown>);

    // 6. Risk check
    const riskDecision = await this.riskManager.evaluateSignal(signal);
    if (!riskDecision.approved) {
      signalEntity.status = 'REJECTED';
      signalEntity.rejectionReason = riskDecision.reason ?? 'Risk check failed';
      await this.signalRepo.save(signalEntity);
      this.logger.warn(`Signal REJECTED: ${riskDecision.reason}`);
      return;
    }

    // 7. Approve and execute
    signalEntity.status = 'APPROVED';
    await this.signalRepo.save(signalEntity);

    const trade = await this.execution.executeSignal(
      signal,
      signalEntity,
    );

    if (trade) {
      signalEntity.status = 'EXECUTED';
      await this.signalRepo.save(signalEntity);
      this.dashboardGateway.emitOrderUpdate(trade as unknown as Record<string, unknown>);
      this.logger.log(`Signal EXECUTED -> Trade ${trade.id}`);
    } else {
      this.logger.warn('Execution returned null — signal not executed');
    }
  }
}
