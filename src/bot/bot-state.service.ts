import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';

export interface BotState {
  enabled: boolean;
  symbol: string;
  timeframe: string;
  startedAt: Date | null;
}

@Injectable()
export class BotStateService {
  private readonly logger = new Logger(BotStateService.name);
  private _enabled = false;
  private _symbol: string;
  private _timeframe: string;
  private _startedAt: Date | null = null;

  private readonly stateChangeSubject = new Subject<BotState>();
  readonly onStateChange$ = this.stateChangeSubject.asObservable();

  constructor(private readonly config: ConfigService) {
    this._symbol = this.config.get<string>('DEFAULT_SYMBOL', 'BTCUSDT');
    this._timeframe = this.config.get<string>('DEFAULT_TIMEFRAME', '5m');
  }

  getState(): BotState {
    return {
      enabled: this._enabled,
      symbol: this._symbol,
      timeframe: this._timeframe,
      startedAt: this._startedAt,
    };
  }

  start(symbol?: string, timeframe?: string): void {
    if (symbol) this._symbol = symbol;
    if (timeframe) this._timeframe = timeframe;
    this._enabled = true;
    this._startedAt = new Date();
    this.logger.log(
      `Bot started: ${this._symbol} @ ${this._timeframe}`,
    );
    this.stateChangeSubject.next(this.getState());
  }

  stop(): void {
    this._enabled = false;
    this._startedAt = null;
    this.logger.log('Bot stopped');
    this.stateChangeSubject.next(this.getState());
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get symbol(): string {
    return this._symbol;
  }

  get timeframe(): string {
    return this._timeframe;
  }
}
