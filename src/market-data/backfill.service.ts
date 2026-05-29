import { Inject, Injectable, Logger } from '@nestjs/common';
import { IExchangeRest } from '../exchange/interfaces/exchange.interfaces';
import type { Candle } from '../exchange/interfaces/exchange.interfaces';
import { CandleRepository } from './candle.repository';
import { toCandleRow, type CandleRow } from './candle.mapper';

/**
 * Planifica una página de backfill (función PURA — sin red ni DB, testeable):
 * - filtra velas aún en formación (closeTime >= now) para no guardar abiertas como cerradas;
 * - mapea las cerradas a filas canónicas con isClosed=true;
 * - calcula el siguiente cursor (openTime de la última + 1) o null si es la última página
 *   o si el cursor no avanzaría (guard anti-bucle).
 */
export function planBackfillPage(
  symbol: string,
  tf: string,
  klines: Candle[],
  now: number,
  pageLimit: number,
  cursor: number,
): { rows: CandleRow[]; nextCursor: number | null } {
  const closed = klines.filter((k) => k.closeTime < now);
  const rows = closed.map((k) => toCandleRow(symbol, tf, k, true));

  if (klines.length === 0 || klines.length < pageLimit) {
    return { rows, nextCursor: null }; // última página
  }
  const last = klines[klines.length - 1];
  const next = last.openTime + 1;
  return { rows, nextCursor: next > cursor ? next : null };
}

/**
 * Backfill histórico de velas — causal y reproducible. Trae velas cerradas del exchange,
 * las normaliza y las persiste vía upsert idempotente. NO interpreta nada (sin SMC, sin señales).
 */
@Injectable()
export class BackfillService {
  private readonly logger = new Logger(BackfillService.name);
  private readonly PAGE_LIMIT = 1500; // máx klines por request (Binance)
  private readonly MAX_PAGES = 1000; // backstop anti-bucle
  private readonly WEIGHT_PAUSE_THRESHOLD = 1000; // used-weight 1m

  constructor(
    @Inject(IExchangeRest) private readonly exchange: IExchangeRest,
    private readonly repo: CandleRepository,
  ) {}

  /** Trae las últimas `limit` velas CERRADAS de (symbol, tf) y las persiste. */
  async backfillRecent(
    symbol: string,
    tf: string,
    limit = 100,
  ): Promise<{ fetched: number; persisted: number }> {
    const now = await this.now();
    const klines = await this.exchange.getKlines(symbol, tf, limit);
    const { rows } = planBackfillPage(symbol, tf, klines, now, limit, 0);
    await this.repo.upsertMany(rows);
    this.logger.log(
      `Backfill ${symbol} ${tf}: fetched ${klines.length}, persisted ${rows.length} (cerradas)`,
    );
    return { fetched: klines.length, persisted: rows.length };
  }

  /** Backfill por rango [startTime, endTime) con paginación causal. */
  async backfillRange(
    symbol: string,
    tf: string,
    startTime: number,
    endTime?: number,
  ): Promise<{ persisted: number; pages: number }> {
    const now = endTime ?? (await this.now());
    let cursor = startTime;
    let persisted = 0;
    let pages = 0;

    while (cursor < now && pages < this.MAX_PAGES) {
      const klines = await this.exchange.getKlines(
        symbol,
        tf,
        this.PAGE_LIMIT,
        cursor,
        now,
      );
      const { rows, nextCursor } = planBackfillPage(
        symbol,
        tf,
        klines,
        now,
        this.PAGE_LIMIT,
        cursor,
      );
      if (rows.length > 0) {
        await this.repo.upsertMany(rows);
        persisted += rows.length;
      }
      pages++;

      if (nextCursor === null) break;
      cursor = nextCursor;

      if (this.exchange.getUsedWeight() > this.WEIGHT_PAUSE_THRESHOLD) {
        this.logger.warn(
          `Used weight ${this.exchange.getUsedWeight()} alto — deteniendo backfill por rate-limit`,
        );
        break;
      }
    }

    this.logger.log(
      `Backfill range ${symbol} ${tf}: ${persisted} velas en ${pages} página(s)`,
    );
    return { persisted, pages };
  }

  private async now(): Promise<number> {
    try {
      return await this.exchange.getServerTime();
    } catch {
      return Date.now();
    }
  }
}
