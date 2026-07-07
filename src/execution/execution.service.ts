// ExecutionService — el orquestador de la EJECUCIÓN REAL acotada (P.5.3, EXECUTION-SPEC). Conecta el
// "cerebro" (PaperTradingService: emite los intents del candidato congelado) con las "manos"
// (OrderExecutorService: coloca/cancela órdenes reales), bajo el arnés del RiskGuard, y persiste el
// ciclo de vida en execution_orders. Todo gateado por EXECUTION_ENABLED (default false) — TEST de
// medición, no payday. Vive en su MÓDULO APARTE: la Regla Cero del paper queda intacta.
//
// El loop es dirigido por la REALIDAD: el paper da la DECISIÓN (intent + cancelación); el fill, el
// SL/TP y el BE se manejan con eventos reales del exchange (user-data WS) + el cierre de vela (15m).

import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execSync } from 'child_process';
import { Subscription } from 'rxjs';
import {
  IUserDataPort,
  IMarketDataPort,
  OrderStatus,
  ConditionalStatus,
  type OrderUpdate,
  type ConditionalUpdate,
  type Candle,
} from '../exchange/interfaces/exchange.interfaces';
import { roundToTickSize } from '../common/utils/precision.util';
import type { TradeIntent, TradeDirection } from '../backtest/trade-simulator';
import { FROZEN_SIM } from '../paper-trading/frozen-candidate';
import { PaperTradingService } from '../paper-trading/paper-trading.service';
import { OrderExecutorService } from './order-executor.service';
import { ExecutionOrderRepository, type ExecutionOrderRow } from './execution-order.repository';
import { ExecutionOrderEntity } from './entities/execution-order.entity';
import { RiskGuard } from './risk-guard';
import { planBracket } from './order-plan';
import { reachedBreakeven, computeRealizedR, computeRealizedRPartial, estimateFeesUsd } from './execution-logic';
import type { BracketPlan, PlannedOrder, RiskLimits } from './execution.types';

type ExecState = 'PENDING' | 'FILLED' | 'CLOSED' | 'CANCELED'; // PENDING = límite resting

interface ExecPosition {
  intent: TradeIntent;
  plan: BracketPlan;
  state: ExecState;
  entryFillPrice: number | null;
  entryFillTime: number | null;
  movedToBE: boolean;
  slClientId: string; // cambia al id de BE tras mover el stop
  slAlgoId: string | null;
  tpClientId: string;
  tpAlgoId: string | null;
  // v2 (partial-runner): pierna TP1 (LIMIT reduceOnly). null/false si el modo es full o degradó.
  tp1ClientId: string | null;
  tp1Filled: boolean;
  tp1FillPrice: number | null;
  tp1FillTime: number | null;
  createdAt: number;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

@Injectable()
export class ExecutionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionService.name);
  private readonly positions = new Map<string, ExecPosition>();
  private readonly subs: Subscription[] = [];
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  private readonly enabled: boolean;
  private readonly testnet: boolean;
  private readonly riskUsd: number;
  private readonly leverage: number;
  private readonly maxNotionalUsd: number;
  private readonly symbols: string[];
  private readonly engineVersion: string;
  private readonly beFraction = FROZEN_SIM.breakevenAtTpFraction;
  private readonly makerFee = FROZEN_SIM.makerFee ?? 0.0002;
  private readonly takerFee = FROZEN_SIM.takerFee ?? 0.0005;
  // v2 (Ciclo 4): modo partial-runner del candidato congelado. En full, el lifecycle es el v1.
  private readonly partialMode = FROZEN_SIM.exitMode === 'partial-runner';
  private readonly tp1AtR = FROZEN_SIM.tp1AtR ?? 1;
  private readonly partialFrac = FROZEN_SIM.partialFrac ?? 0.5;
  private readonly riskGuard: RiskGuard;

  constructor(
    private readonly executor: OrderExecutorService,
    private readonly config: ConfigService,
    @Optional() @Inject(PaperTradingService) private readonly paper: PaperTradingService | null,
    @Optional() @Inject(IUserDataPort) private readonly userData: IUserDataPort | null,
    @Optional() @Inject(IMarketDataPort) private readonly market: IMarketDataPort | null,
    @Optional() @Inject(ExecutionOrderRepository) private readonly repo: ExecutionOrderRepository | null,
  ) {
    this.enabled = this.config.get<string>('EXECUTION_ENABLED', 'false') === 'true';
    this.testnet = this.config.get<string>('EXECUTION_TESTNET', 'true') === 'true';
    const capital = Number(this.config.get('EXECUTION_TEST_CAPITAL', 100));
    const riskPct = Number(this.config.get('EXECUTION_RISK_PCT', 0.005));
    this.riskUsd = capital * riskPct;
    this.leverage = Number(this.config.get('EXECUTION_LEVERAGE', 5));
    this.maxNotionalUsd = Number(this.config.get('EXECUTION_MAX_NOTIONAL_USD', 400));
    const raw = this.config.get<string>('MARKET_DATA_SYMBOLS') ?? this.config.get<string>('DEFAULT_SYMBOL', 'BTCUSDT');
    this.symbols = raw.split(',').map((s) => s.trim()).filter(Boolean);

    let version = this.config.get<string>('BUILD_VERSION', '');
    if (!version) {
      try {
        version = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      } catch {
        version = 'unknown';
      }
    }
    this.engineVersion = version;

    const limits: RiskLimits = {
      maxConcurrentPositions: Number(this.config.get('EXECUTION_MAX_POSITIONS', 3)),
      maxNotionalPerOrderUsd: this.maxNotionalUsd,
      maxMarginUsedUsd: Number(this.config.get('EXECUTION_MAX_MARGIN_USD', 80)),
      maxDailyLossR: Number(this.config.get('EXECUTION_MAX_DAILY_LOSS_R', 3)),
      circuitBreakerLossR: Number(this.config.get('EXECUTION_CIRCUIT_BREAKER_R', 10)),
      leverage: this.leverage,
      symbols: this.symbols,
      priceSanityFrac: 0.05,
    };
    this.riskGuard = new RiskGuard(limits, Date.now());
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('EXECUTION_ENABLED != true — ejecución real NO arranca (Regla Cero acotada en reposo).');
      return;
    }
    if (!this.paper || !this.userData || !this.market) {
      this.logger.error(
        `Faltan dependencias — paper=${!!this.paper} userData=${!!this.userData} market=${!!this.market} — ejecución NO arranca.`,
      );
      return;
    }
    this.logger.warn(
      `⚠️ EJECUCIÓN REAL ACOTADA ACTIVA — testnet=${this.testnet} · riesgo $${this.riskUsd}/trade · ` +
        `leverage ${this.leverage}x · ${this.symbols.length} símbolos · salida ${this.partialMode ? `PARCIAL+RUNNER (TP1 ${this.partialFrac * 100}% @ +${this.tp1AtR}R → BE → runner 2R)` : 'full (v1)'}. TEST de medición.`,
    );

    for (const s of this.symbols) {
      try {
        await this.executor.ensureLeverage(s, this.leverage);
      } catch (e) {
        this.logger.warn(`leverage ${s}: ${msg(e)}`);
      }
    }

    await this.reconcile();

    try {
      await this.userData.start();
    } catch (e) {
      this.logger.error(`user-data WS start: ${msg(e)} — sin detección de fills, ejecución INSEGURA, abortando.`);
      return;
    }
    this.keepaliveTimer = setInterval(() => void this.userData?.keepalive().catch(() => undefined), 30 * 60_000);

    this.subs.push(
      this.paper.onLiveIntent$.subscribe((i) => void this.handleIntent(i)),
      this.paper.onLiveCancel$.subscribe((id) => void this.handleCancel(id)),
      this.userData.onOrderUpdate$.subscribe((u) => void this.onOrderUpdate(u)),
      this.userData.onConditionalUpdate$.subscribe((u) => void this.onConditionalUpdate(u)),
      this.market.onCandleClose$.subscribe(({ symbol, tf, candle }) => {
        if (tf === '15m') void this.onCandleClose(symbol, candle);
      }),
    );
    // SWEEP periódico (REST): red de seguridad contra eventos PERDIDOS del user-data WS (testnet lo
    // demostró: fill de entrada sin evento → posición sin bracket). Cada 60 s verifica contra el
    // exchange: PENDING con posición real → adoptar+bracket · FILLED con TP1 sin ver → BE ·
    // FILLED sin posición real → liquidar con el income REAL. Idempotente con los handlers del WS.
    this.sweepTimer = setInterval(() => void this.sweep(), 60_000);
    this.logger.log('Ejecución suscrita: intents/cancelaciones del paper + fills (user-data WS) + cierres 15m + sweep 60s.');
  }

  // ── Intent nuevo → colocar la LÍMITE en el CE ──────────────────────────────
  private async handleIntent(intent: TradeIntent): Promise<void> {
    if (this.riskGuard.isKilled()) return;
    if (this.positions.has(intent.id)) return; // idempotente
    // Un intent activo por símbolo (one-way mode + closePosition = una posición por símbolo).
    if ([...this.positions.values()].some((p) => p.intent.symbol === intent.symbol && (p.state === 'PENDING' || p.state === 'FILLED'))) {
      this.logger.warn(`${intent.symbol}: ya hay un intent activo — se salta ${intent.id}`);
      return;
    }

    const filters = this.executor.filtersFor(intent.symbol);
    const planRes = planBracket(
      intent,
      this.riskUsd,
      filters,
      this.maxNotionalUsd,
      this.partialMode ? { tp1AtR: this.tp1AtR, partialFrac: this.partialFrac } : undefined,
    );
    if (!planRes.ok) {
      this.logger.warn(`plan rechazado ${intent.id}: ${planRes.reason} (${planRes.detail})`);
      return;
    }
    const plan = planRes.plan;
    if (this.partialMode && !plan.takeProfitPartial) {
      // qty parcial redondeó a 0 (posición de 1 step) → degrada a full-exit para ESTE trade.
      this.logger.warn(`${intent.symbol}: qty parcial = 0 (posición mínima) — este trade corre SIN TP1 (full).`);
    }

    let price = 0;
    try {
      price = await this.executor.getLastPrice(intent.symbol);
    } catch {
      /* sigue 0 → el sanity de precio se omite */
    }

    const decision = this.riskGuard.tryReserve(plan, price, Date.now());
    if (!decision.allow) {
      this.logger.warn(`risk-guard bloqueó ${intent.id}: ${decision.reason}`);
      return;
    }

    try {
      const res = await this.executor.placeEntryLimit(plan.entry);
      const pos: ExecPosition = {
        intent,
        plan,
        state: 'PENDING',
        entryFillPrice: null,
        entryFillTime: null,
        movedToBE: false,
        slClientId: plan.stopLoss.clientOrderId,
        slAlgoId: null,
        tpClientId: plan.takeProfit.clientOrderId,
        tpAlgoId: null,
        tp1ClientId: plan.takeProfitPartial?.clientOrderId ?? null,
        tp1Filled: false,
        tp1FillPrice: null,
        tp1FillTime: null,
        createdAt: Date.now(),
      };
      this.positions.set(intent.id, pos);
      await this.persist(pos, { entryOrderId: res.orderId });
      this.logger.log(`LÍMITE ${intent.symbol} ${intent.direction} @ ${plan.entry.price} (qty ${plan.quantity}, $${plan.notionalUsd.toFixed(0)})`);
    } catch (e) {
      this.riskGuard.release(plan); // liberar la reserva si no se colocó
      this.logger.error(`fallo al colocar la límite ${intent.id}: ${msg(e)}`);
    }
  }

  // ── Paper canceló (ranAway) → retirar la límite si sigue resting ───────────
  private async handleCancel(intentId: string): Promise<void> {
    const pos = this.positions.get(intentId);
    if (!pos || pos.state !== 'PENDING') return; // si ya llenó, el real manda (no se cancela)
    try {
      await this.executor.cancelOrder(pos.plan.symbol, pos.plan.entry.clientOrderId);
    } catch (e) {
      // No se pudo cancelar → quizá llenó en el ínterin; el WS de fill lo resolverá.
      this.logger.warn(`cancel límite ${intentId}: ${msg(e)} (¿ya llenó?)`);
      return;
    }
    pos.state = 'CANCELED';
    this.riskGuard.release(pos.plan);
    await this.persist(pos, { cancelReason: 'ranAway' });
    this.logger.log(`LÍMITE cancelada (ranAway) ${pos.plan.symbol} ${intentId}`);
  }

  // ── Fill de la entrada o del TP1 (user-data WS) ────────────────────────────
  private async onOrderUpdate(u: OrderUpdate): Promise<void> {
    if (u.status !== OrderStatus.FILLED) return;
    // ¿Es el fill de una ENTRADA pendiente?
    const pending = [...this.positions.values()].find(
      (p) => p.state === 'PENDING' && p.plan.entry.clientOrderId === u.clientOrderId,
    );
    if (pending) {
      pending.state = 'FILLED';
      pending.entryFillPrice = parseFloat(u.avgPrice) || pending.intent.entry;
      pending.entryFillTime = u.eventTime;
      this.logger.log(`FILL ${pending.plan.symbol} @ ${pending.entryFillPrice}`);
      await this.placeBracket(pending);
      return;
    }
    // ¿Es el fill del TP1 (parcial)? → asegurado; el SL del resto va a BE (anclado al fill, como el sim).
    const withTp1 = [...this.positions.values()].find(
      (p) => p.state === 'FILLED' && !p.tp1Filled && p.tp1ClientId != null && p.tp1ClientId === u.clientOrderId,
    );
    if (withTp1) {
      withTp1.tp1Filled = true;
      withTp1.tp1FillPrice = parseFloat(u.avgPrice) || parseFloat(withTp1.plan.takeProfitPartial?.price ?? '0');
      withTp1.tp1FillTime = u.eventTime;
      this.logger.log(`TP1 ${withTp1.plan.symbol}: parcial asegurado @ ${withTp1.tp1FillPrice} → SL a BE`);
      await this.moveToBreakeven(withTp1);
      await this.persist(withTp1, {});
    }
  }

  // Coloca el bracket SL + TP (closePosition) + TP1 (LIMIT reduceOnly, v2). Si el SL/TP falla →
  // APLANA (no dejar posición sin protección). Si solo falla el TP1 → sigue como full (degrada, loggea).
  private async placeBracket(pos: ExecPosition): Promise<void> {
    try {
      const sl = await this.executor.placeStop(pos.plan.stopLoss);
      pos.slAlgoId = sl.conditionalId;
      const tp = await this.executor.placeTakeProfit(pos.plan.takeProfit);
      pos.tpAlgoId = tp.conditionalId;
    } catch (e) {
      this.logger.error(`fallo al montar bracket ${pos.intent.id}: ${msg(e)} — APLANANDO por seguridad.`);
      await this.executor.flatten(pos.plan.symbol).catch(() => undefined);
      pos.state = 'CLOSED';
      this.riskGuard.release(pos.plan);
      await this.persist(pos, { cancelReason: 'reconcile', exitReason: 'KILL' });
      return;
    }
    if (pos.plan.takeProfitPartial) {
      try {
        await this.executor.placeLimitReduceOnly(pos.plan.takeProfitPartial);
      } catch (e) {
        pos.tp1ClientId = null; // degrada a full-exit: SL/TP (closePosition) ya protegen todo
        this.logger.error(`fallo al colocar TP1 ${pos.intent.id}: ${msg(e)} — el trade sigue SIN parcial (full).`);
      }
    }
    await this.persist(pos, { entryFillPrice: pos.entryFillPrice, entryFillTime: pos.entryFillTime });
    this.logger.log(
      `BRACKET ${pos.plan.symbol}: SL ${pos.plan.stopLoss.stopPrice} / TP ${pos.plan.takeProfit.stopPrice}` +
        (pos.plan.takeProfitPartial && pos.tp1ClientId
          ? ` / TP1 ${pos.plan.takeProfitPartial.quantity} @ ${pos.plan.takeProfitPartial.price}`
          : ''),
    );
  }

  // ── Salida (SL/TP/BE disparó, user-data WS algo FINISHED) → settle + cierre ─
  private async onConditionalUpdate(u: ConditionalUpdate): Promise<void> {
    if (u.status !== ConditionalStatus.FINISHED) return;
    const pos = [...this.positions.values()].find(
      (p) => p.state === 'FILLED' && (u.clientOrderId === p.slClientId || u.clientOrderId === p.tpClientId),
    );
    if (!pos) return;
    const isTp = u.clientOrderId === pos.tpClientId;
    const reason = isTp ? 'TP' : pos.movedToBE ? 'BE' : 'SL';
    const exitPrice = u.avgPrice ? parseFloat(u.avgPrice) : isTp ? pos.intent.takeProfit : pos.intent.stopLoss;
    await this.closePosition(pos, reason, exitPrice, u.eventTime);
  }

  private async closePosition(pos: ExecPosition, reason: string, exitPrice: number, exitTime: number): Promise<void> {
    if (pos.state !== 'FILLED') return; // re-entrada (WS + sweep): solo el primero liquida
    pos.state = 'CLOSED'; // marcar ANTES de los awaits — cierra la ventana de carrera
    // Cancelar la hermana (la que disparó ya terminó; la otra sigue viva) + el TP1 si quedó resting.
    for (const algoId of [pos.slAlgoId, pos.tpAlgoId]) {
      if (algoId) await this.executor.cancelConditional(pos.plan.symbol, algoId).catch(() => undefined);
    }
    if (pos.tp1ClientId && !pos.tp1Filled) {
      await this.executor.cancelOrder(pos.plan.symbol, pos.tp1ClientId).catch(() => undefined);
    }
    const totalQty = parseFloat(pos.plan.quantity);
    const entryFill = pos.entryFillPrice ?? pos.intent.entry;
    const entryFeeUsd = entryFill * totalQty * this.makerFee;
    let r: number;
    let fees: number;
    if (pos.tp1Filled && pos.tp1FillPrice != null && pos.plan.takeProfitPartial) {
      // v2: R combinada por piernas — TP1 (maker) + resto (taker: SL/BE/TP-market).
      const tp1Qty = parseFloat(pos.plan.takeProfitPartial.quantity);
      const restQty = parseFloat(pos.plan.runnerQuantity ?? '0') || Math.max(totalQty - tp1Qty, 0);
      const legs = [
        { price: pos.tp1FillPrice, qty: tp1Qty, feeUsd: pos.tp1FillPrice * tp1Qty * this.makerFee },
        { price: exitPrice, qty: restQty, feeUsd: exitPrice * restQty * this.takerFee },
      ];
      fees = entryFeeUsd + legs[0].feeUsd + legs[1].feeUsd;
      r = computeRealizedRPartial(pos.intent, entryFill, legs, entryFeeUsd);
    } else {
      fees = estimateFeesUsd(entryFill, exitPrice, totalQty, this.makerFee, this.takerFee);
      r = computeRealizedR(pos.intent, entryFill, exitPrice, fees, totalQty);
    }
    this.riskGuard.settle(pos.plan, r, exitTime);
    await this.persist(pos, {
      exitReason: reason,
      exitPrice,
      exitTime,
      exitFeeUsd: fees,
      realizedR: r,
      realizedUsd: r * pos.plan.riskUsd,
    });
    this.logger.log(`CLOSE ${pos.plan.symbol} ${reason} @ ${exitPrice} = ${r >= 0 ? '+' : ''}${r.toFixed(3)}R`);
    if (this.riskGuard.isKilled()) {
      this.logger.error(`⛔ CIRCUIT BREAKER disparado: ${this.riskGuard.snapshot().killReason} — aplanando todo.`);
      await this.killAll(this.riskGuard.snapshot().killReason ?? 'circuit breaker');
    }
  }

  // ── Cierre de vela 15m → mover a break-even si corresponde (SOLO modo full/v1) ──
  // En partial-runner el BE se ancla al FILL del TP1 (onOrderUpdate), no al progreso por vela.
  private async onCandleClose(symbol: string, candle: Candle): Promise<void> {
    if (this.partialMode) return;
    for (const pos of this.positions.values()) {
      if (pos.plan.symbol !== symbol || pos.state !== 'FILLED' || pos.movedToBE) continue;
      if (reachedBreakeven(pos.intent, candle.high, candle.low, this.beFraction)) {
        await this.moveToBreakeven(pos);
      }
    }
  }

  private async moveToBreakeven(pos: ExecPosition): Promise<void> {
    if (pos.movedToBE) return; // idempotente (WS + sweep pueden coincidir)
    const filters = this.executor.filtersFor(pos.plan.symbol);
    if (!filters) return;
    const entryFill = pos.entryFillPrice ?? pos.intent.entry;
    const isLong = pos.intent.direction === 'LONG';
    const buffer = entryFill * 0.0008; // cubre el coste round-trip → un stop en BE rinde ≈ 0R
    const bePrice = roundToTickSize(isLong ? entryFill + buffer : entryFill - buffer, filters.tickSize);
    const beClientId = pos.plan.stopLoss.clientOrderId.replace('FAB_S', 'FAB_B');
    const beOrder: PlannedOrder = {
      leg: 'SL',
      clientOrderId: beClientId,
      symbol: pos.plan.symbol,
      side: isLong ? 'SELL' : 'BUY',
      type: 'STOP_MARKET',
      quantity: pos.plan.quantity,
      stopPrice: bePrice,
      reduceOnly: true,
    };
    try {
      if (pos.slAlgoId) await this.executor.cancelConditional(pos.plan.symbol, pos.slAlgoId).catch(() => undefined);
      const sl = await this.executor.placeStop(beOrder);
      pos.slAlgoId = sl.conditionalId;
      pos.slClientId = beClientId;
      pos.movedToBE = true;
      await this.persist(pos, { movedToBE: true });
      this.logger.log(`BE ${pos.plan.symbol}: SL → ${bePrice}`);
    } catch (e) {
      this.logger.error(`fallo al mover BE ${pos.intent.id}: ${msg(e)}`);
    }
  }

  // ── Reconciliación al arrancar: re-adoptar lo vivo, PROTEGER fills sin bracket ──
  private async reconcile(): Promise<void> {
    if (!this.repo) return;
    let openRows: ExecutionOrderEntity[] = [];
    try {
      openRows = await this.repo.findOpen();
    } catch (e) {
      this.logger.error(`reconcile: no se pudo leer execution_orders: ${msg(e)}`);
      return;
    }
    if (openRows.length === 0) return;
    this.logger.log(`reconciliando ${openRows.length} intents abiertos contra el exchange...`);

    for (const row of openRows) {
      const intent = rowToIntent(row);
      const filters = this.executor.filtersFor(row.symbol);
      const planRes = planBracket(
        intent,
        row.riskUsd ?? this.riskUsd,
        filters,
        this.maxNotionalUsd,
        this.partialMode ? { tp1AtR: this.tp1AtR, partialFrac: this.partialFrac } : undefined,
      );
      if (!planRes.ok) {
        this.logger.warn(`reconcile: no se pudo reconstruir el plan de ${row.intentId} (${planRes.reason}) — REVISAR A MANO.`);
        continue;
      }
      const pos: ExecPosition = {
        intent,
        plan: planRes.plan,
        state: (row.state as ExecState) ?? 'PENDING',
        entryFillPrice: row.entryFillPrice ?? null,
        entryFillTime: row.entryFillTime ?? null,
        movedToBE: row.movedToBE ?? false,
        slClientId: row.slClientId ?? planRes.plan.stopLoss.clientOrderId,
        slAlgoId: row.slAlgoId ?? null,
        tpClientId: row.tpClientId ?? planRes.plan.takeProfit.clientOrderId,
        tpAlgoId: row.tpAlgoId ?? null,
        tp1ClientId: row.tp1ClientId ?? planRes.plan.takeProfitPartial?.clientOrderId ?? null,
        tp1Filled: row.tp1Filled ?? false,
        tp1FillPrice: row.tp1FillPrice ?? null,
        tp1FillTime: row.tp1FillTime ?? null,
        createdAt: row.createdAt ?? Date.now(),
      };
      this.positions.set(intent.id, pos);
      this.riskGuard.adopt(pos.plan);

      const realPos = await this.executor.getOpenPosition(row.symbol).catch(() => null);
      if (pos.state === 'FILLED') {
        if (realPos) {
          await this.ensureBracket(pos);
          // v2: si el TP1 no llenó y sigue faltando, re-colocarlo (id determinista: un duplicado
          // resting es RECHAZADO por Binance y se ignora — idempotente).
          if (this.partialMode && pos.tp1ClientId && !pos.tp1Filled && pos.plan.takeProfitPartial) {
            await this.executor.placeLimitReduceOnly(pos.plan.takeProfitPartial).catch(() => undefined);
          }
          this.logger.log(`reconcile ${row.symbol}: posición viva re-adoptada (bracket verificado).`);
        } else {
          this.riskGuard.release(pos.plan);
          pos.state = 'CLOSED';
          await this.persist(pos, { cancelReason: 'reconcile' });
          this.logger.warn(`reconcile ${row.symbol}: cerró mientras estábamos caídos (R no recuperada).`);
        }
      } else {
        // PENDING
        if (realPos) {
          pos.state = 'FILLED';
          pos.entryFillPrice = parseFloat(realPos.entryPrice) || intent.entry;
          pos.entryFillTime = Date.now();
          await this.placeBracket(pos);
          this.logger.warn(`reconcile ${row.symbol}: LLENÓ mientras caídos → bracket colocado (protegida).`);
        } else {
          await this.executor.cancelOrder(row.symbol, pos.plan.entry.clientOrderId).catch(() => undefined);
          this.riskGuard.release(pos.plan);
          pos.state = 'CANCELED';
          await this.persist(pos, { cancelReason: 'reconcile' });
          this.logger.log(`reconcile ${row.symbol}: límite no resumida (cancelada por seguridad).`);
        }
      }
    }
  }

  // Verifica que SL y TP estén presentes en el exchange; re-coloca los que falten.
  private async ensureBracket(pos: ExecPosition): Promise<void> {
    const open = await this.executor.getOpenConditionals(pos.plan.symbol).catch(() => []);
    const ids = new Set(open.map((c) => c.clientOrderId));
    if (!ids.has(pos.slClientId)) {
      const sl = await this.executor.placeStop(pos.plan.stopLoss).catch((e) => {
        this.logger.error(`reconcile: no se pudo re-colocar SL de ${pos.intent.id}: ${msg(e)}`);
        return null;
      });
      if (sl) pos.slAlgoId = sl.conditionalId;
    }
    if (!ids.has(pos.tpClientId)) {
      const tp = await this.executor.placeTakeProfit(pos.plan.takeProfit).catch((e) => {
        this.logger.error(`reconcile: no se pudo re-colocar TP de ${pos.intent.id}: ${msg(e)}`);
        return null;
      });
      if (tp) pos.tpAlgoId = tp.conditionalId;
    }
    await this.persist(pos, {});
  }

  // ── SWEEP (REST, 60 s): repara lo que el user-data WS se haya perdido ──────
  private async sweep(): Promise<void> {
    if (this.sweeping || this.riskGuard.isKilled()) return;
    this.sweeping = true;
    try {
      for (const pos of this.positions.values()) {
        if (pos.state === 'PENDING') {
          // ¿La límite llenó sin que llegara el evento? → adoptar el fill y proteger.
          const real = await this.executor.getOpenPosition(pos.plan.symbol).catch(() => undefined);
          if (real === undefined) continue; // REST falló: no concluir nada
          if (real && Math.abs(parseFloat(real.positionAmt)) > 0) {
            pos.state = 'FILLED';
            pos.entryFillPrice = parseFloat(real.entryPrice) || pos.intent.entry;
            pos.entryFillTime = Date.now();
            this.logger.warn(`sweep ${pos.plan.symbol}: FILL detectado por REST (el WS lo perdió) → bracket.`);
            await this.placeBracket(pos);
          }
        } else if (pos.state === 'FILLED') {
          const real = await this.executor.getOpenPosition(pos.plan.symbol).catch(() => undefined);
          if (real === undefined) continue;
          if (real == null) {
            // La posición YA NO existe: salió sin que viéramos el evento. Liquidar con el income
            // REAL del exchange (PnL + comisiones + funding desde el fill) — la fuente de verdad.
            const since = pos.entryFillTime ?? pos.createdAt;
            const netUsd = await this.executor.getNetIncomeSince(pos.plan.symbol, since).catch(() => null);
            if (netUsd == null) continue; // sin dato fiable, reintenta el próximo sweep
            const r = pos.plan.riskUsd > 0 ? netUsd / pos.plan.riskUsd : 0;
            this.logger.warn(
              `sweep ${pos.plan.symbol}: cierre detectado por REST (el WS lo perdió) → income $${netUsd.toFixed(4)} = ${r >= 0 ? '+' : ''}${r.toFixed(3)}R`,
            );
            pos.state = 'CLOSED';
            await this.executor.flatten(pos.plan.symbol).catch(() => undefined); // cancela TP1/hermanas resting
            this.riskGuard.settle(pos.plan, r, Date.now());
            await this.persist(pos, {
              exitReason: 'SWEEP',
              exitTime: Date.now(),
              realizedR: r,
              realizedUsd: netUsd,
            });
            if (this.riskGuard.isKilled()) {
              await this.killAll(this.riskGuard.snapshot().killReason ?? 'circuit breaker');
            }
          } else if (pos.tp1ClientId && !pos.tp1Filled && pos.plan.takeProfitPartial) {
            // ¿El TP1 llenó sin evento? La posición real quedó reducida ≈ runnerQuantity.
            const amtAbs = Math.abs(parseFloat(real.positionAmt));
            const totalQty = parseFloat(pos.plan.quantity);
            const tp1Qty = parseFloat(pos.plan.takeProfitPartial.quantity);
            if (amtAbs > 0 && amtAbs <= totalQty - tp1Qty / 2) {
              pos.tp1Filled = true;
              pos.tp1FillPrice = parseFloat(pos.plan.takeProfitPartial.price ?? '0') || null;
              pos.tp1FillTime = Date.now();
              this.logger.warn(`sweep ${pos.plan.symbol}: TP1 llenó (detectado por REST) → SL a BE.`);
              await this.moveToBreakeven(pos);
              await this.persist(pos, {});
            }
          }
        }
      }
    } catch (e) {
      this.logger.warn(`sweep falló: ${msg(e)}`);
    } finally {
      this.sweeping = false;
    }
  }

  // ── Kill-switch: cancela todo + cierra posiciones + detiene ────────────────
  async killAll(reason: string): Promise<void> {
    this.riskGuard.kill(reason);
    const symbols = new Set(
      [...this.positions.values()].filter((p) => p.state === 'PENDING' || p.state === 'FILLED').map((p) => p.plan.symbol),
    );
    for (const symbol of symbols) {
      await this.executor.flatten(symbol).catch((e) => this.logger.error(`kill flatten ${symbol}: ${msg(e)}`));
    }
    for (const pos of this.positions.values()) {
      if (pos.state === 'PENDING' || pos.state === 'FILLED') {
        pos.state = 'CLOSED';
        await this.persist(pos, { cancelReason: 'killed' });
      }
    }
    this.logger.error(`⛔ KILL-SWITCH: ${reason} — órdenes canceladas, posiciones aplanadas, ejecución detenida.`);
  }

  // Inyector de prueba (TESTNET-ONLY): dispara un intent sintético que LLENA de inmediato (entrada
  // cruzando el mercado) para validar TODO el lifecycle en minutos, sin esperar una señal natural del
  // candidato. Rechaza si no es testnet — JAMÁS debe inyectar en real.
  async injectTestIntent(
    symbol: string,
    direction: TradeDirection = 'LONG',
    stopPct = 0.003,
    rMultiple = 2,
  ): Promise<{ ok: boolean; intentId?: string; entry?: number; stopLoss?: number; takeProfit?: number; reason?: string }> {
    if (!this.testnet) return { ok: false, reason: 'INYECTOR DESHABILITADO fuera de testnet (EXECUTION_TESTNET=false)' };
    if (!this.enabled) return { ok: false, reason: 'EXECUTION_ENABLED=false' };
    const price = await this.executor.getLastPrice(symbol).catch(() => 0);
    if (price <= 0) return { ok: false, reason: `sin precio para ${symbol}` };
    const isLong = direction === 'LONG';
    const entry = isLong ? price * 1.0008 : price * 0.9992; // cruza el mercado → fill inmediato
    const risk = entry * stopPct;
    const stopLoss = isLong ? entry - risk : entry + risk;
    const takeProfit = isLong ? entry + rMultiple * risk : entry - rMultiple * risk;
    const intent: TradeIntent = {
      id: `TEST_${symbol}_${Date.now().toString(36)}_${isLong ? 'u' : 'd'}`,
      symbol,
      tf: '15m',
      direction,
      signalBarTime: Date.now(),
      entry,
      stopLoss,
      takeProfit,
      cancelBeyond: isLong ? entry * 1.05 : entry * 0.95,
    };
    this.logger.warn(`🧪 INTENT DE PRUEBA: ${symbol} ${direction} entry≈${entry.toFixed(4)} SL≈${stopLoss.toFixed(4)} TP≈${takeProfit.toFixed(4)}`);
    await this.handleIntent(intent);
    return { ok: true, intentId: intent.id, entry, stopLoss, takeProfit };
  }

  status(): unknown {
    return {
      enabled: this.enabled,
      testnet: this.testnet,
      riskUsd: this.riskUsd,
      engineVersion: this.engineVersion,
      risk: this.riskGuard.snapshot(),
      positions: [...this.positions.values()].map((p) => ({
        intentId: p.intent.id,
        symbol: p.plan.symbol,
        direction: p.intent.direction,
        state: p.state,
        entryFillPrice: p.entryFillPrice,
        movedToBE: p.movedToBE,
        tp1Filled: p.tp1Filled,
        tp1FillPrice: p.tp1FillPrice,
      })),
    };
  }

  private async persist(pos: ExecPosition, extra: Partial<ExecutionOrderRow>): Promise<void> {
    if (!this.repo) return;
    const row: ExecutionOrderRow = {
      intentId: pos.intent.id,
      symbol: pos.plan.symbol,
      direction: pos.intent.direction,
      signalBarTime: pos.intent.signalBarTime,
      state: pos.state,
      testnet: this.testnet,
      entry: pos.intent.entry,
      stopLoss: pos.intent.stopLoss,
      takeProfit: pos.intent.takeProfit,
      cancelBeyond: pos.intent.cancelBeyond ?? null,
      quantity: parseFloat(pos.plan.quantity),
      notionalUsd: pos.plan.notionalUsd,
      riskUsd: pos.plan.riskUsd,
      entryClientId: pos.plan.entry.clientOrderId,
      slClientId: pos.slClientId,
      tpClientId: pos.tpClientId,
      slAlgoId: pos.slAlgoId,
      tpAlgoId: pos.tpAlgoId,
      entryFillPrice: pos.entryFillPrice,
      entryFillTime: pos.entryFillTime,
      movedToBE: pos.movedToBE,
      tp1ClientId: pos.tp1ClientId,
      tp1Filled: pos.tp1Filled,
      tp1FillPrice: pos.tp1FillPrice,
      tp1FillTime: pos.tp1FillTime,
      engineVersion: this.engineVersion,
      createdAt: pos.createdAt,
      updatedAt: Date.now(),
      ...extra,
    };
    try {
      await this.repo.upsert(row);
    } catch (e) {
      this.logger.error(`persist ${pos.intent.id}: ${msg(e)}`);
    }
  }

  onModuleDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }
}

function rowToIntent(row: ExecutionOrderEntity): TradeIntent {
  return {
    id: row.intentId,
    symbol: row.symbol,
    tf: '15m',
    direction: row.direction as TradeDirection,
    signalBarTime: row.signalBarTime,
    entry: row.entry,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    cancelBeyond: row.cancelBeyond ?? undefined,
  };
}
