#!/usr/bin/env bash
# #3 Replay Framework helper (2026-05-23)
# Exports a snapshot from strategy_state_snapshots as a JSON file ready for replay.
#
# Usage on VPS:
#   ./export-snapshot-for-replay.sh "2026-05-21 22:00:00" BTCUSDT > /tmp/snapshot_pre_loss.json
#
# Then download the file to local and run:
#   npx ts-node src/backtest/run.ts --replay-snapshot=/tmp/snapshot_pre_loss.json \
#       --symbol=BTCUSDT --timeframe=1h --start-date=2026-05-21 --end-date=2026-05-23 \
#       --mode=pullback-ob --trail-mode=fixed-amount --trail-fixed=50 --trail-activation=50 \
#       --loose-htf --min-atr-pct=0.15

set -euo pipefail

BEFORE_TIME="${1:-}"
SYMBOL="${2:-BTCUSDT}"

if [ -z "$BEFORE_TIME" ]; then
  echo "Usage: $0 '<ISO timestamp>' [symbol]" >&2
  echo "  Example: $0 '2026-05-21 22:00:00' BTCUSDT" >&2
  exit 1
fi

docker exec -i postgres-db psql -U postgres -d futures-bot -At -c "
SELECT json_build_object(
  'cycleAt', \"cycleAt\",
  'symbol', symbol,
  'timeframe', timeframe,
  'state', state,
  'bias', bias,
  'activeZones', \"activeZones\",
  'waitCycles', \"waitCycles\",
  'createdAtBreakTime', \"createdAtBreakTime\"
)::text
FROM strategy_state_snapshots
WHERE symbol = '$SYMBOL'
  AND \"cycleAt\" <= '$BEFORE_TIME'::timestamptz
ORDER BY \"cycleAt\" DESC
LIMIT 1;
"
