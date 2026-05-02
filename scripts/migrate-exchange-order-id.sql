-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: rename `binanceOrderId` (bigint) → `exchangeOrderId` (varchar)
-- Run ONCE on the production DB BEFORE deploying the new code.
--
-- Why:
--   - Bybit V5 returns string orderIds that can exceed JS Number safe integer
--     (e.g. "1850123456789012345"), so storing them as bigint is fragile.
--   - Renaming makes the field exchange-agnostic for the multi-exchange
--     architecture introduced in Phase 1 of the Bybit migration.
--
-- How:
--   docker exec -i postgres-db psql -U postgres -d futures-bot < migrate-exchange-order-id.sql
--
-- Idempotency:
--   Safe to run multiple times. First run does the migration, subsequent
--   runs are no-ops because the IF EXISTS / IF NOT EXISTS guards short-circuit.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Add new column if missing.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "exchangeOrderId" varchar;

-- 2. Copy data from old column when present, only into rows that don't have
--    the new value yet (idempotent, won't clobber on re-run).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'binanceOrderId'
  ) THEN
    UPDATE orders
    SET "exchangeOrderId" = "binanceOrderId"::text
    WHERE "exchangeOrderId" IS NULL AND "binanceOrderId" IS NOT NULL;
  END IF;
END $$;

-- 3. Drop the old column.
ALTER TABLE orders DROP COLUMN IF EXISTS "binanceOrderId";

COMMIT;

-- Verification query (run manually after the migration):
--   SELECT id, "clientOrderId", "exchangeOrderId", purpose, status
--   FROM orders ORDER BY "createdAt" DESC LIMIT 10;
