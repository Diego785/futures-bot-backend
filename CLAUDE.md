# Futures AI Bot — Backend Guide

## Project Overview
Backend NestJS del bot de trading de **Binance USDT-M Futures** con Smart Money Concepts (SMC).
Desplegado en producción en `38.242.145.246:3300` (Docker).

## Stack
- **Framework**: NestJS 11, TypeScript
- **DB**: TypeORM + PostgreSQL (`38.242.145.246:5432`, user: postgres, db: futures-bot)
- **Queue**: BullMQ + Redis (`futures-ai-redis:6379`)
- **WebSocket**: Socket.IO (namespace `/ws`)
- **Exchange**: Binance USDT-M Futures (API real, no demo)

## Trading Configuration (.env)
```
STRATEGY_MODE=pullback-ob          # 'pullback-ob' (active) or 'hybrid' (legacy)
DEFAULT_TIMEFRAME=15m
DEFAULT_SYMBOL=BTCUSDT
MAX_LEVERAGE=5
MAX_POSITION_NOTIONAL_USDT=100
MAX_DAILY_LOSS_USDT=20
SL_SAFETY_ATR_MULT=0               # DISABLED for pullback-ob (zone provides natural SL)
SL_SAFETY_MIN_PCT=0                # DISABLED for pullback-ob
TRAIL_FIXED=50                     # Trailing SL follows price at $50 distance
TRAILING_BE_PCT=0.5                # Legacy (unused with fixed-amount mode)
GATE_MIN_SCORE=30

# Added 2026-05-13: IOC fallback when LIMIT entry doesn't fill in 180s.
# Previously the bot aborted the trade (captured only 10% of backtest signals).
# IOC tries to fill at signal.entryPrice +/- IOC_FALLBACK_MAX_SLIP_USD.
# If liquidity exists within cap -> fills as taker. If price drifted -> IOC cancels itself.
IOC_FALLBACK_ENABLED=true          # set to "false" to revert to old "no fallback" behavior
IOC_FALLBACK_MAX_SLIP_USD=50       # max USD slippage tolerated when filling IOC fallback

# Added 2026-05-13: proactive fixes for 68% live-vs-backtest gap (17 days no-operation).
# All flag-OFF until backtest validates each. Activate ONE at a time.
HTF_4H_TIEBREAKER_ENABLED=false    # use 4H structure when 1H EMA+structure contradict
HTF_4H_TIEBREAKER_SOFT_ENABLED=false  # (added 2026-05-14) also accept 4H RANGING as soft confirmation
PULLBACK_HTF_FLIP_TOLERANT=false   # (added 2026-05-15) don't invalidate setup if structure still aligns
PULLBACK_SLOPE_SOFT=false          # (added 2026-05-15) skip slope-against filter at entry trigger
PULLBACK_MAX_WAIT_CYCLES=12        # candles to wait for pullback (bump to 20 = 5h)
PULLBACK_MIN_ATR_PCT=0.15          # min ATR% to create setup (was hardcoded)

# Added 2026-05-21: safety brakes for canary mode (live with capital).
MAX_CONSECUTIVE_LOSSES=3           # pause entries after N losses in a row (Bybit truth)
CONSECUTIVE_LOSS_PAUSE_HOURS=24    # hours to stay paused once brake triggers
```

## Daily Telemetry (added 2026-05-14)

Persistent diagnostic table `daily_telemetry` that records cycle/signal lifecycle per UTC day.
Required for diagnosing live-vs-backtest gap empirically (without grepping docker logs).

**Schema** (`src/trading/entities/daily-telemetry.entity.ts`):
- `date` (PK), `totalCycles`, `setupsCreated`, `entriesAttempted`
- `signalsGenerated`, `signalsExecuted`, `signalsRejected`
- `blockedReasons` JSONB — category → count (low_volatility, htf_unclear, no_zones, etc)
- `rejectionReasons` JSONB — risk-manager rejection category → count
- `latestCycleAt` — heartbeat timestamp, used by 5min cron to detect bot offline

**Migration**: `migrations/2026-05-14_daily_telemetry.sql` (run manually before deploy):
```bash
docker exec -i postgres-db psql -U postgres -d futures-bot \
  < migrations/2026-05-14_daily_telemetry.sql
```

**Diagnostic query** (run after 24h+ of data collection):
```sql
SELECT date, "totalCycles", "setupsCreated", "entriesAttempted",
       "signalsGenerated", "signalsExecuted", "signalsRejected",
       "blockedReasons", "rejectionReasons", "latestCycleAt"
FROM daily_telemetry ORDER BY date DESC LIMIT 7;
```

**What to look for**:
- `totalCycles ~ 96` per day = healthy uptime (1 cycle per 15m candle)
- `totalCycles < 60` = bot offline part of day (WS or container issue)
- Dominant `blockedReasons` key = next strategy lever to relax
- Dominant `rejectionReasons` key = risk-manager filter to investigate

## Heartbeat Alert (added 2026-05-14)

`MaintenanceCronService.heartbeatCheck()` runs every 5 min. If `latestCycleAt` is > 18 min old
(i.e. 1 full 15m candle missed), logs ERROR + sends FCM notification "Heartbeat stale: Nmin
sin cycles". De-duplicated to once every 30 min.

Resolves detectability of bot-offline scenarios that caused the 2026-04-21/04-23 incident
(memoria: project_ws_staleness_incident).

## Zombie Trade Auto-Cleanup (added 2026-05-14)

`RiskManagerService.checkExistingPosition()` now queries exchange FIRST. If exchange has no
position but DB has trade marked OPEN, force-closes the trade as `CLOSED_ORPHAN` and approves
the new signal. Prevents future scenarios where a reconcile failure leaves a zombie OPEN trade
that blocks all subsequent signals.

If exchange query fails (API timeout), falls back to conservative DB check (reject signal).

## Signal Flow
1. Binance WS sends candle close event every 15m
2. BullMQ job queued -> `StrategyCycleProcessor`
3. Calculate indicators (EMA9/21, RSI14, ATR14, Bollinger Bands)
4. Calculate SMC (OBs, FVGs, structure, premium/discount)
5. Compute HTF context (1H EMA + structure)
6. **Strategy routing** (based on `STRATEGY_MODE`):
   - `pullback-ob`: State machine waits for pullback to OB/FVG zone
   - `hybrid`: EMA Crossover + Breakout (legacy)
7. If confidence >= 0.55 -> Risk Manager validates (6 checks)
8. Execution: LIMIT entry GTC (180s timeout) -> if not filled, LIMIT IOC fallback at signal price +/- IOC_FALLBACK_MAX_SLIP_USD cap (2026-05-13) -> if also not filled, abort. SL/TP placed as STOP_MARKET / TAKE_PROFIT_MARKET conditionals.
9. If MARKET fill differs >$50 from signal entry -> recalculates SL/TP from actual fill
10. Trailing SL: Fixed-$50 mode (TRAIL_FIXED env var). SL follows price at $50 distance. Min $5 movement.
11. PnL captured via /fapi/v1/income API (commissions + funding fees)

## Pullback-OB Strategy (ACTIVE)
State machine: IDLE -> WAITING_PULLBACK -> ENTRY
1. **Bias**: HTF (1H) EMA crossover + market structure must both agree
2. **Low-vol filter**: ATR% > 0.25% required
3. **Zone detection**: Unmitigated OBs + unfilled FVGs in pullback direction (0.05%-1.5%)
4. **Wait**: Max 12 candles (3h on 15m) for pullback to zone
5. **Entry filter**: EMA slope must NOT be against bias
6. **Entry trigger**: Candle low/high touches zone -> enter at zone boundary price (suggestedEntryPrice)
7. **Invalidation**: CHoCH against, timeout, HTF flip, zone blown through
- SL: Below/above zone + 0.3x ATR buffer | TP: 1.5x SL distance
- SL safety net: DISABLED (SL_SAFETY_ATR_MULT=0)
- Trailing: Fixed-$50 (PF 7.37 vs 1.54 without)
- Backtested 3Y: 2,221 trades, 72% WR, +$1,694 PnL, PF 7.37
- Multi-year: Profitable every year 2020-2025

## Key Files
### Strategy
- `src/strategy/pullback-ob-signal.service.ts` — Pullback state machine + entry logic
- `src/strategy/signal-generator.service.ts` — Routes to pullback or hybrid
- `src/strategy/hybrid-signal.service.ts` — Legacy EMA Crossover + Breakout
- `src/strategy/indicators.service.ts` — EMA, RSI, ATR, Bollinger Bands
- `src/strategy/smc.service.ts` — OBs, FVGs, structure (BOS/CHoCH)
- `src/strategy/pre-filter-gate.service.ts` — Gate scoring (skipped in pullback mode)
- `src/strategy/deepseek.service.ts` — AI prompt + DeepSeek API

### Trading
- `src/trading/execution.service.ts` — Order placement, trailing SL, reconciliation
- `src/trading/risk-manager.service.ts` — 7 risk checks, cooldown (30 min hardcoded)

### Bot
- `src/bot/strategy-cycle.processor.ts` — BullMQ job processor (main loop)
- `src/bot/maintenance-cron.service.ts` — ListenKey keepalive, reconcile cron

### Binance
- `src/binance/binance-market-ws.service.ts` — Market data WS (candles)
- `src/binance/binance-user-ws.service.ts` — User data stream (order/algo updates)

### Dashboard API
- `src/dashboard/dashboard.controller.ts` — REST API endpoints
- `src/dashboard/dashboard.gateway.ts` — Socket.IO gateway

### Backtest
- `src/backtest/backtest.service.ts` — Backtest engine (hybrid + pullback-ob modes)
- `src/backtest/run.ts` — CLI runner
- `src/backtest/interfaces.ts` — Config + trade interfaces

## Design Decisions (DO NOT revert without clear reason)

### Timeframe: 15m
5m produced too many false CHoCH/OB, whipsaw. 15m gives cleaner signals.

### SL safety net (configurable)
`execution.service.ts` expands any SL smaller than max(SL_SAFETY_ATR_MULT * ATR, SL_SAFETY_MIN_PCT * entry). Set to 0.5x ATR for pullback (zone-based SLs are already tight).

### Trailing SL
+0.3% -> breakeven, +0.5% -> trail 50%, +0.8% -> trail 70%. Runs in reconcilePositions() every 1 min.

### Race condition prevention
`closingTrades` Set in execution.service.ts prevents double-count PnL when SL/TP fires multiple WS events (ORDER_TRADE_UPDATE + ALGO_UPDATE). Only ALGO_UPDATE FINISHED is processed.

### Entry price sync
When ENTRY order FILLED via ORDER_TRADE_UPDATE, trade.entryPrice is updated to actual fill price (not signal price).

### Entry LIMIT (not MARKET)
LIMIT at mark price +/- $15, timeout 10s, fallback to MARKET. Saves 0.03% per trade in commissions.

### Cooldown: 30 min
Hardcoded in risk-manager.service.ts. Prevents opening multiple trades in same direction.

### Software SL/TP backup
Reconcile checks position every 1 min. If Binance algo order fails, closes with MARKET. Keep active.

### Never use demo API
demo-fapi.binance.com has isolated fake orderbook. OBs/FVGs calculated on fake data are meaningless.

## Backtest CLI
```bash
# Pullback-OB (recommended)
npx ts-node src/backtest/run.ts --mode=pullback-ob --timeframe=15m --days=180 --symbol=BTCUSDT --balance=100 --leverage=5

# Legacy hybrid
npx ts-node src/backtest/run.ts --mode=hybrid --timeframe=1h --days=180

# Pullback params
--max-wait=12 --ob-sl-buffer=0.3 --zone-type=both --max-distance=1.5 --min-distance=0.05 --rr=1.5
```

## Deployment
```bash
# On VPS (38.242.145.246)
cd /root/futures-ai-bot  # or wherever deployed
docker compose down && docker compose up -d --build
docker compose logs -f bot
```
