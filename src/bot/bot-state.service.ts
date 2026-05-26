import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';

export interface BotState {
  enabled: boolean;
  symbol: string;        // primary symbol (backward compat)
  symbols: string[];     // all active symbols (added 2026-05-24 multi-symbol)
  timeframe: string;
  startedAt: Date | null;
}

@Injectable()
export class BotStateService {
  private readonly logger = new Logger(BotStateService.name);
  private _enabled = false;
  private _symbols: string[];  // multi-symbol (2026-05-24); _symbol is alias to first
  private _timeframe: string;
  private _startedAt: Date | null = null;

  private readonly stateChangeSubject = new Subject<BotState>();
  readonly onStateChange$ = this.stateChangeSubject.asObservable();

  constructor(private readonly config: ConfigService) {
    // SYMBOLS env var takes precedence (comma-separated). Falls back to DEFAULT_SYMBOL.
    const symbolsRaw = this.config.get<string>('SYMBOLS', '');
    const defaultSymbol = this.config.get<string>('DEFAULT_SYMBOL', 'BTCUSDT');
    this._symbols = symbolsRaw
      ? symbolsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [defaultSymbol];
    this._timeframe = this.config.get<string>('DEFAULT_TIMEFRAME', '5m');
  }

  getState(): BotState {
    return {
      enabled: this._enabled,
      symbol: this._symbols[0],
      symbols: [...this._symbols],
      timeframe: this._timeframe,
      startedAt: this._startedAt,
    };
  }

  start(symbol?: string, timeframe?: string): void {
    if (symbol) {
      // API-level start can pass a single symbol — replace the array.
      this._symbols = [symbol];
    }
    if (timeframe) this._timeframe = timeframe;
    this._enabled = true;
    this._startedAt = new Date();
    this.logger.log(
      `Bot started: ${this._symbols.join('+')} @ ${this._timeframe}`,
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

  /** Primary symbol — backward compat. Use `symbols` for multi-symbol checks. */
  get symbol(): string {
    return this._symbols[0];
  }

  /** All active symbols (multi-symbol support added 2026-05-24). */
  get symbols(): string[] {
    return [...this._symbols];
  }

  get timeframe(): string {
    return this._timeframe;
  }
}
