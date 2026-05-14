#!/bin/bash
set -e
COMMON="--symbol=BTCUSDT --days=365 --mode=pullback-ob --trail-mode=fixed-amount --trail-fixed=50 --trail-activation=50 --loose-htf"
OUT=./backtest_outputs

run_variant() {
  local name=$1
  shift
  echo "=== Running variant: $name ==="
  date
  npm run backtest -- $COMMON "$@" --output=$OUT/${name}.json --export-trades-csv=$OUT/${name}_trades.csv > $OUT/${name}.log 2>&1
  echo "Done: $name"
  date
}

# Variant 2: ATR=0.20
run_variant "atr020" --min-atr-pct=0.20

# Variant 3: block ASIA
run_variant "noASIA" --min-atr-pct=0.15 --block-session=ASIA

# Variant 4: block CONSOLIDATION
run_variant "noCONSOL" --min-atr-pct=0.15 --block-delta24h-bucket=CONSOLIDATION

# Variant 5: ATR + ASIA
run_variant "atr020_noASIA" --min-atr-pct=0.20 --block-session=ASIA

# Variant 6: ATR + CONSOL
run_variant "atr020_noCONSOL" --min-atr-pct=0.20 --block-delta24h-bucket=CONSOLIDATION

# Variant 7: ASIA + CONSOL
run_variant "noASIA_noCONSOL" --min-atr-pct=0.15 --block-session=ASIA --block-delta24h-bucket=CONSOLIDATION

# Variant 8: ALL THREE
run_variant "atr020_noASIA_noCONSOL" --min-atr-pct=0.20 --block-session=ASIA --block-delta24h-bucket=CONSOLIDATION

echo "ALL VARIANTS COMPLETE"
