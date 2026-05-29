-- Migration: strategy_state_snapshots table for replay validation
-- Created: 2026-05-21
-- Purpose: persist the internal state of the strategy (PullbackObSignalService)
--          at the end of every cycle. Enables "replay from real live state"
--          backtests — eliminating the divergence between backtest state-machine
--          (fresh start) and live state-machine (continuous history).
--
-- Without snapshots, backtest cannot reproduce live trades exactly because
-- the PullbackObSignalService state evolves over time (active setups, zones,
-- waitCycles, bias). The 19/05 replay validation showed this gap clearly.
--
-- One row per cycle. With 24 cycles/day (1h timeframe) → 720 rows/month.
-- Negligible storage. Auto-cleanup of rows >90 days TBD later.
--
-- Run BEFORE deploying release with state-snapshot persistence code:
--   docker exec -i postgres-db psql -U postgres -d futures-bot \
--     < migrations/2026-05-21_strategy_state_snapshots.sql

CREATE TABLE IF NOT EXISTS strategy_state_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "cycleAt"       TIMESTAMP WITH TIME ZONE NOT NULL,
  "candleCloseTime" BIGINT,                     -- ms epoch of the candle that was processed
  symbol          VARCHAR(20) NOT NULL,
  timeframe       VARCHAR(10) NOT NULL,
  state           VARCHAR(20) NOT NULL,         -- IDLE | WAITING_PULLBACK
  bias            VARCHAR(10),                  -- LONG | SHORT | null
  "activeZones"   JSONB DEFAULT '[]'::jsonb,    -- [{type, high, low, confluence}, ...]
  "waitCycles"    INTEGER DEFAULT 0,
  "createdAtBreakTime" BIGINT,                  -- setup creation lastStructureBreak time
  "htfContext"    JSONB,                        -- {emaCrossover, marketStructure, marketStructure4h, rsi, atrPct, zone}
  "smcContext"    JSONB,                        -- {structure, premiumDiscount, obs, fvgs}
  "indicators"    JSONB,                        -- {price, ema9, ema21, rsi14, atr14, emaSlope}
  "lastSignalAction" VARCHAR(10),               -- HOLD | LONG | SHORT
  "lastSignalReason" VARCHAR(255),
  "createdAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index for replay queries: load all snapshots in a time range, ordered.
CREATE INDEX IF NOT EXISTS idx_state_snapshots_cycleAt
  ON strategy_state_snapshots ("cycleAt" DESC);

-- Index for symbol+timeframe queries: replay a specific bot config.
CREATE INDEX IF NOT EXISTS idx_state_snapshots_symbol_tf
  ON strategy_state_snapshots (symbol, timeframe, "cycleAt" DESC);

-- Verification:
-- \d strategy_state_snapshots
