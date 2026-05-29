-- Migration: daily_telemetry table for cycle/signal lifecycle tracking
-- Created: 2026-05-14
-- Purpose: persist per-day stats (cycles processed, signals generated/executed/rejected,
--          block reasons, rejection categories, heartbeat timestamp) to diagnose
--          live-vs-backtest gap and detect bot offline scenarios.
--
-- Run BEFORE deploying the matching backend release. Without this table, the
-- TelemetryService catches the "table not found" error and logs it without
-- blocking the cycle, but no diagnostic data is captured.
--
-- Execute with:
--   docker exec -i postgres-db psql -U postgres -d futures-bot \
--     < migrations/2026-05-14_daily_telemetry.sql

CREATE TABLE IF NOT EXISTS daily_telemetry (
  date DATE PRIMARY KEY,
  "totalCycles" INTEGER NOT NULL DEFAULT 0,
  "setupsCreated" INTEGER NOT NULL DEFAULT 0,
  "entriesAttempted" INTEGER NOT NULL DEFAULT 0,
  "signalsGenerated" INTEGER NOT NULL DEFAULT 0,
  "signalsExecuted" INTEGER NOT NULL DEFAULT 0,
  "signalsRejected" INTEGER NOT NULL DEFAULT 0,
  "blockedReasons" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "rejectionReasons" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "latestCycleAt" TIMESTAMP WITH TIME ZONE,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Verification query (run after creation to confirm structure):
-- \d daily_telemetry
