// CLI de BACKFILL histórico para el backtest (Fase D — datos). Trae velas CERRADAS públicas de
// Binance futures y las persiste (upsert idempotente). Read-only de mercado: NO usa credenciales de
// trading, NO coloca órdenes (Regla Cero). Reutiliza el planificador PURO planBackfillPage.
//
// Uso (tras `npm run build`):
//   node dist/backtest/backfill.js --preset                 (4h/1h/15m/5m con fechas base)
//   node dist/backtest/backfill.js --tf 15m --from 2024-01-01
// Conservador con el rate-limit (pausa al acercarse al límite de peso) para no gatillar soft-ban.

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NestFactory } from '@nestjs/core';
import { CandleEntity } from '../market-data/entities/candle.entity';
import { CandleRepository } from '../market-data/candle.repository';
import { planBackfillPage } from '../market-data/backfill.service';
import { ExchangeModule } from '../exchange/exchange.module';
import { IExchangeRest } from '../exchange/interfaces/exchange.interfaces';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('DB_HOST'),
        port: Number(config.get('DB_PORT') ?? 5432),
        username: config.get<string>('DB_USER'),
        password: config.get<string>('DB_PASS'),
        database: config.get<string>('DB_NAME'),
        entities: [CandleEntity],
        synchronize: false,
        logging: ['error'] as const,
      }),
    }),
    TypeOrmModule.forFeature([CandleEntity]),
    ExchangeModule,
  ],
  providers: [CandleRepository],
})
class BackfillCliModule {}

const PAGE_LIMIT = 1500; // máx klines/request (Binance futures)
const WEIGHT_PAUSE = 1500; // pausa al superar este used-weight-1m (límite real 2400; margen amplio)
const REQ_DELAY_MS = 150; // delay suave entre requests
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const getArg = (name: string, def: string): string => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--')) return args[i + 1];
  return def;
};
const hasFlag = (n: string): boolean => args.includes(`--${n}`);
const toMs = (d: string): number => new Date(d + 'T00:00:00Z').getTime();
const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 16);

// Fechas base del preset: cuánta historia traer por TF (balance datos vs carga de API).
const PRESET: { tf: string; from: string }[] = [
  { tf: '4h', from: '2022-01-01' },
  { tf: '1h', from: '2023-01-01' },
  { tf: '15m', from: '2024-01-01' },
  { tf: '5m', from: '2025-01-01' },
];

async function backfillOne(
  exchange: IExchangeRest,
  repo: CandleRepository,
  symbol: string,
  tf: string,
  startMs: number,
  now: number,
): Promise<void> {
  let cursor = startMs;
  let persisted = 0;
  let pages = 0;
  console.log(`\n→ ${symbol} ${tf} desde ${fmt(startMs)} …`);
  while (cursor < now && pages < 5000) {
    const klines = await exchange.getKlines(symbol, tf, PAGE_LIMIT, cursor, now);
    const { rows, nextCursor } = planBackfillPage(symbol, tf, klines, now, PAGE_LIMIT, cursor);
    if (rows.length > 0) {
      await repo.upsertMany(rows);
      persisted += rows.length;
    }
    pages++;
    if (pages % 20 === 0) console.log(`   … ${fmt(cursor)} (+${persisted} velas, ${pages} págs)`);
    if (nextCursor === null) break;
    cursor = nextCursor;
    await sleep(REQ_DELAY_MS);
    if (exchange.getUsedWeight() > WEIGHT_PAUSE) {
      console.log(`   (peso ${exchange.getUsedWeight()} alto — pausa 60s para reset)`);
      await sleep(60_000);
    }
  }
  const total = await repo.count(symbol, tf);
  console.log(`✓ ${symbol} ${tf}: +${persisted} velas en ${pages} págs → total en DB ${total}`);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(BackfillCliModule, { logger: ['error', 'warn'] });
  try {
    const exchange = app.get<IExchangeRest>(IExchangeRest);
    const repo = app.get(CandleRepository);
    const symbol = getArg('symbol', 'BTCUSDT');
    const now = await exchange.getServerTime().catch(() => Date.now());

    const targets = hasFlag('preset')
      ? PRESET.map((p) => ({ tf: p.tf, startMs: toMs(p.from) }))
      : [{ tf: getArg('tf', '15m'), startMs: toMs(getArg('from', '2024-01-01')) }];

    for (const t of targets) {
      await backfillOne(exchange, repo, symbol, t.tf, t.startMs, now);
    }
    console.log('\nBackfill completo.');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
