import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../common/constants/binance.constants';
import { BotStateService } from './bot-state.service';
import { SignalGeneratorService } from '../strategy/signal-generator.service';
import { RiskManagerService } from '../trading/risk-manager.service';
import { ExecutionService } from '../trading/execution.service';
import { Signal } from '../trading/entities/signal.entity';
import { TelemetryService } from '../trading/telemetry.service';
import { DashboardGateway } from '../dashboard/dashboard.gateway';
import { FcmService } from '../notifications/fcm.service';

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
    private readonly fcmService: FcmService,
    private readonly config: ConfigService,
    private readonly telemetry: TelemetryService,
    @InjectRepository(Signal)
    private readonly signalRepo: Repository<Signal>,
  ) {
    super();
  }

  private isShadowMode(): boolean {
    const mode = (this.config.get<string>('EXECUTION_MODE') ?? 'live')
      .toLowerCase()
      .trim();
    return mode === 'shadow';
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
    this.telemetry.recordSignalLifecycle('generated').catch(() => {});

    // 5. Emit signal to dashboard
    this.dashboardGateway.emitSignal(signalEntity as unknown as Record<string, unknown>);

    // 6. Risk check
    const riskDecision = await this.riskManager.evaluateSignal(signal);
    if (!riskDecision.approved) {
      signalEntity.status = 'REJECTED';
      signalEntity.rejectionReason = riskDecision.reason ?? 'Risk check failed';
      await this.signalRepo.save(signalEntity);
      this.logger.warn(`Signal REJECTED: ${riskDecision.reason}`);
      this.fcmService.notifySignalRejected(
        signal.action,
        signal.confidence,
        riskDecision.reason ?? 'Risk check failed',
      ).catch(() => {});
      return;
    }

    // 7. Approve
    signalEntity.status = 'APPROVED';
    await this.signalRepo.save(signalEntity);

    // 8. Shadow mode short-circuit — Phase 2.2 validation.
    // EXECUTION_MODE=shadow records what would have happened in DB and logs,
    // but does not place any real order. Used to validate 24h in vivo before
    // exposing capital. Switch to EXECUTION_MODE=live to resume real trading.
    if (this.isShadowMode()) {
      signalEntity.status = 'SHADOW_EXECUTED';
      signalEntity.rejectionReason = `[SHADOW] would execute ${signal.action} ${signal.symbol} entry=${signal.entryPrice.toFixed(2)} SL=${signal.stopLoss.toFixed(2)} TP=${signal.takeProfit.toFixed(2)} conf=${signal.confidence.toFixed(2)}`;
      await this.signalRepo.save(signalEntity);
      this.logger.warn(
        `[SHADOW] Would execute ${signal.action} ${signal.symbol} ` +
          `entry=${signal.entryPrice.toFixed(2)} SL=${signal.stopLoss.toFixed(2)} TP=${signal.takeProfit.toFixed(2)} ` +
          `conf=${signal.confidence.toFixed(2)} reasoning="${signal.reasoning.slice(0, 120)}"`,
      );
      return;
    }

    // 9. Execute (live mode)
    const trade = await this.execution.executeSignal(
      signal,
      signalEntity,
    );

    if (trade) {
      signalEntity.status = 'EXECUTED';
      await this.signalRepo.save(signalEntity);
      this.telemetry.recordSignalLifecycle('executed').catch(() => {});
      this.dashboardGateway.emitOrderUpdate(trade as unknown as Record<string, unknown>);
      this.logger.log(`Signal EXECUTED -> Trade ${trade.id}`);
      this.fcmService.notifyTradeOpened(
        trade.direction,
        trade.symbol,
        Number(trade.entryPrice),
        Number(trade.stopLoss),
        Number(trade.takeProfit),
      ).catch(() => {});
    } else {
      this.logger.warn('Execution returned null — signal not executed');
      // Execution returned null = LIMIT timeout abort OR IOC fallback abort.
      // Treat as rejected for telemetry so capture rate analysis stays accurate.
      this.telemetry
        .recordSignalLifecycle('rejected', 'Execution returned null (LIMIT/IOC abort)')
        .catch(() => {});
    }
  }
}
