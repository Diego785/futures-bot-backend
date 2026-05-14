#!/bin/bash
COMMON_BASE="--symbol=BTCUSDT --mode=pullback-ob --trail-mode=fixed-amount --trail-fixed=50 --trail-activation=50 --loose-htf --min-atr-pct=0.15"
OUT=./backtest_outputs

run_oos() {
  local window=$1
  local start=$2
  local end=$3
  local name=$4
  shift 4
  echo "=== $window | $name | $start to $end ==="
  date
  npm run backtest -- $COMMON_BASE --start-date=$start --end-date=$end "$@" \
    --output=$OUT/oos_${window}_${name}.json \
    --export-trades-csv=$OUT/oos_${window}_${name}_trades.csv \
    > $OUT/oos_${window}_${name}.log 2>&1
  echo "Done: $window/$name at $(date)"
}

# W1: 2021-06 to 2022-06 (Bear inicial)
run_oos "W1" "2021-06-01" "2022-06-01" "baseline"
run_oos "W1" "2021-06-01" "2022-06-01" "noASIA" --block-session=ASIA
run_oos "W1" "2021-06-01" "2022-06-01" "noCONSOL" --block-delta24h-bucket=CONSOLIDATION
run_oos "W1" "2021-06-01" "2022-06-01" "noASIA_noCONSOL" --block-session=ASIA --block-delta24h-bucket=CONSOLIDATION

# W2: 2022-06 to 2023-06 (Bear deep + accumulation)
run_oos "W2" "2022-06-01" "2023-06-01" "baseline"
run_oos "W2" "2022-06-01" "2023-06-01" "noASIA" --block-session=ASIA
run_oos "W2" "2022-06-01" "2023-06-01" "noCONSOL" --block-delta24h-bucket=CONSOLIDATION
run_oos "W2" "2022-06-01" "2023-06-01" "noASIA_noCONSOL" --block-session=ASIA --block-delta24h-bucket=CONSOLIDATION

# W3: 2023-06 to 2024-06 (Recovery + early bull)
run_oos "W3" "2023-06-01" "2024-06-01" "baseline"
run_oos "W3" "2023-06-01" "2024-06-01" "noASIA" --block-session=ASIA
run_oos "W3" "2023-06-01" "2024-06-01" "noCONSOL" --block-delta24h-bucket=CONSOLIDATION
run_oos "W3" "2023-06-01" "2024-06-01" "noASIA_noCONSOL" --block-session=ASIA --block-delta24h-bucket=CONSOLIDATION

echo "ALL OOS WINDOWS COMPLETE"
