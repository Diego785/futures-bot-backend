-- Migration: add Bybit-sourced PnL reconciliation columns to trades table
-- Created: 2026-05-20
-- Purpose: separate "bot calculated PnL" (existing trade.realizedPnl) from
--          "Bybit truth PnL". DB has been reporting incorrect PnL (gross instead
--          of net, or wrong sign for commission). Bybit is source of truth.
--
-- New columns:
--   bybitRealizedPnl: gross realized PnL from Bybit (positive=win, negative=loss)
--   bybitFees:        total fees (entry + exit) from Bybit, as absolute positive
--   bybitFunding:     funding fee from Bybit (zero in most short trades)
--   bybitNetPnl:      bybitRealizedPnl - bybitFees + bybitFunding (true PnL)
--   pnlSource:        'BYBIT_FILLS' | 'BYBIT_INCOME' | 'ESTIMATED'
--   pnlDiffFromDb:    bybitNetPnl - realizedPnl (signal of bug, target zero)
--   pnlReconciledAt:  timestamp when columns were populated
--
-- Run BEFORE deploying release with reconciliation code:
--   docker exec -i postgres-db psql -U postgres -d futures-bot \
--     < migrations/2026-05-20_bybit_pnl_reconciliation.sql

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS "bybitRealizedPnl" DECIMAL(18, 8),
  ADD COLUMN IF NOT EXISTS "bybitFees"        DECIMAL(18, 8),
  ADD COLUMN IF NOT EXISTS "bybitFunding"     DECIMAL(18, 8) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "bybitNetPnl"      DECIMAL(18, 8),
  ADD COLUMN IF NOT EXISTS "pnlSource"        VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "pnlDiffFromDb"    DECIMAL(18, 8),
  ADD COLUMN IF NOT EXISTS "pnlReconciledAt"  TIMESTAMP WITH TIME ZONE;

-- Verification:
-- \d trades
