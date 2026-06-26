// Smoke test del adapter de órdenes contra Binance Futures TESTNET (P.5.2). Ejercita TODO el ciclo:
// exchangeInfo, precio, leverage, LIMIT place+cancel, MARKET fill, lectura de posición, STOP_MARKET,
// TAKE_PROFIT_MARKET, lectura de condicionales y flatten (cierre + cancelaciones).
//
// SALVAGUARDA DURA: aborta si BINANCE_FUTURES_BASE_URL no apunta a testnet (coloca órdenes MARKET —
// jamás debe tocar real). Pasos:
//   1) crear API key en https://testnet.binancefuture.com  (red de pruebas, plata falsa)
//   2) .env: EXCHANGE_PROVIDER=binance · BINANCE_FUTURES_BASE_URL=https://testnet.binancefuture.com
//            · BINANCE_API_KEY/BINANCE_API_SECRET = los de testnet
//   3) npm run build  4) node dist/execution/testnet-smoke.js [SYMBOL=ETHUSDT] [RISK_USD=0.5]

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { validate } from '../common/config/env.validation';
import { ExchangeModule } from '../exchange/exchange.module';
import { OrderExecutorService } from './order-executor.service';
import { planBracket } from './order-plan';
import type { TradeIntent } from '../backtest/trade-simulator';

// Módulo auto-contenido DB-free: el smoke solo necesita el executor sobre el exchange (no el
// ExecutionModule completo, que ahora arrastra DB + paper).
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate }), ExchangeModule],
  providers: [OrderExecutorService],
})
class SmokeModule {}

const SYMBOL = process.argv[2] ?? 'ETHUSDT';
let RISK = parseFloat(process.argv[3] ?? '0.5');
const NOW = Date.now();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SmokeModule, { logger: ['error', 'warn'] });
  const config = app.get(ConfigService);
  const baseUrl = config.get<string>('BINANCE_FUTURES_BASE_URL') ?? '';

  // ── SALVAGUARDA: solo testnet ──
  if (!/testnet/i.test(baseUrl)) {
    console.error(`\n✗ ABORT: BINANCE_FUTURES_BASE_URL no es testnet ("${baseUrl}").`);
    console.error('  El smoke coloca órdenes MARKET reales — jamás debe correr contra producción.');
    console.error('  Apuntá a https://testnet.binancefuture.com con tu key de testnet y reintenta.');
    await app.close();
    process.exit(1);
  }

  console.log(`\n=== SMOKE testnet · ${SYMBOL} · ${baseUrl} ===\n`);
  const exec = app.get(OrderExecutorService);
  let pass = 0;
  let fail = 0;
  const check = (ok: boolean, msg: string): void => {
    console.log(`${ok ? '✓' : '✗'} ${msg}`);
    ok ? pass++ : fail++;
  };

  const buildPlan = (entry: number, sl: number, tp: number, risk: number) => {
    const intent: TradeIntent = {
      id: `SMOKE_${SYMBOL}_${NOW}`,
      symbol: SYMBOL,
      tf: '15m',
      direction: 'LONG',
      signalBarTime: NOW,
      entry,
      stopLoss: sl,
      takeProfit: tp,
    };
    return planBracket(intent, risk, exec.filtersFor(SYMBOL), 1_000_000);
  };

  try {
    // 0) Filtros + precio + leverage
    const filters = exec.filtersFor(SYMBOL);
    check(
      !!filters,
      `exchangeInfo: ${SYMBOL} ${filters ? `(tick ${filters.tickSize}, step ${filters.stepSize}, min $${filters.minNotional})` : 'SIN FILTROS — ¿símbolo en testnet?'}`,
    );
    if (!filters) throw new Error('sin filtros de símbolo');

    const price = await exec.getLastPrice(SYMBOL);
    check(price > 0, `precio actual = ${price}`);
    if (price <= 0) throw new Error('precio no disponible');

    await exec.ensureLeverage(SYMBOL, 5);
    check(true, 'leverage 5x configurado');

    // El smoke prueba MECÁNICA, no fidelidad de sizing: si no llega al minNotional, sube el riesgo.
    const ensurePlaceable = (entry: number, sl: number, tp: number) => {
      let p = buildPlan(entry, sl, tp, RISK);
      let bumps = 0;
      while (!p.ok && p.reason === 'minNotional' && bumps < 8) {
        RISK *= 2;
        p = buildPlan(entry, sl, tp, RISK);
        bumps++;
      }
      return p;
    };

    // ── Test A: LIMIT en reposo (no llena) + cancelar ──
    const aEntry = price * 0.95; // 5 % debajo → no llena
    const planA = ensurePlaceable(aEntry, aEntry * 0.996, aEntry * 1.02);
    check(
      planA.ok,
      `plan A (LIMIT) ${planA.ok ? `qty ${planA.plan.quantity} · notional $${planA.plan.notionalUsd.toFixed(2)} · riesgo $${RISK}` : `RECHAZADO ${planA.reason}: ${planA.detail}`}`,
    );
    if (planA.ok) {
      const r = await exec.placeEntryLimit(planA.plan.entry);
      check(!!r.orderId, `LIMIT colocada (status ${r.status}, coid ${r.clientOrderId})`);
      await exec.cancelOrder(SYMBOL, planA.plan.entry.clientOrderId);
      check(true, 'LIMIT cancelada');
    }

    // ── Test B: bracket completo vía MARKET (abre, pone SL+TP, lee, aplana) ──
    const planB = ensurePlaceable(price, price * 0.996, price * 1.008);
    check(planB.ok, `plan B (bracket) ${planB.ok ? `qty ${planB.plan.quantity}` : `RECHAZADO ${planB.reason}: ${planB.detail}`}`);
    if (planB.ok) {
      const p = planB.plan;
      const mk = await exec.placeMarket(SYMBOL, 'BUY', p.quantity, false);
      check(!!mk.orderId, `MARKET BUY ejecutada (qty ${p.quantity})`);
      await sleep(1500);

      const pos = await exec.getOpenPosition(SYMBOL);
      check(!!pos && Math.abs(parseFloat(pos.positionAmt)) > 0, `posición abierta (amt ${pos?.positionAmt ?? '0'})`);

      const sl = await exec.placeStop(p.stopLoss);
      check(!!sl.conditionalId, `STOP_MARKET en ${p.stopLoss.stopPrice} (id ${sl.conditionalId})`);
      const tp = await exec.placeTakeProfit(p.takeProfit);
      check(!!tp.conditionalId, `TAKE_PROFIT_MARKET en ${p.takeProfit.stopPrice} (id ${tp.conditionalId})`);
      await sleep(1000);

      const conds = await exec.getOpenConditionals(SYMBOL);
      check(conds.length >= 2, `condicionales abiertos: ${conds.length} (esperado ≥2)`);

      await exec.flatten(SYMBOL);
      await sleep(1500);
      const posAfter = await exec.getOpenPosition(SYMBOL);
      check(!posAfter, `flatten → posición plana (${posAfter ? posAfter.positionAmt : '0'})`);
      const condsAfter = await exec.getOpenConditionals(SYMBOL);
      check(condsAfter.length === 0, `flatten → condicionales cancelados (${condsAfter.length})`);
    }
  } catch (e) {
    fail++;
    console.error('\n✗ EXCEPCIÓN:', e instanceof Error ? e.message : e);
    // Intento de limpieza por las dudas (no dejar posición abierta en testnet).
    try {
      await exec.flatten(SYMBOL);
    } catch {
      /* best-effort */
    }
  } finally {
    console.log(`\n=== RESULTADO: ${pass} PASS / ${fail} FAIL ===\n`);
    await app.close();
    process.exit(fail === 0 ? 0 : 1);
  }
}

void main();
