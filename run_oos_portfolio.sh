#!/bin/bash
COMMON="--days=365 --timeframe=15m --mode=pullback-ob --trail-mode=fixed-amount --trail-fixed=50 --trail-activation=50 --loose-htf --min-atr-pct=0.15"
OUT=./backtest_outputs

run_oos() {
  local symbol=$1
  local window=$2
  local start=$3
  local end=$4
  local extra=$5
  local name=$6
  echo "=== $window | $name === $(date)"
  npm run backtest -- --symbol=$symbol $COMMON --start-date=$start --end-date=$end $extra \
    --output=$OUT/oos_pf_${window}_${name}.json \
    --export-trades-csv=$OUT/oos_pf_${window}_${name}_trades.csv \
    > $OUT/oos_pf_${window}_${name}.log 2>&1
  echo "Done: $window/$name $(date)"
}

# W1 = 2021-06 to 2022-06 (Bear inicial post-pico)
# W2 = 2022-06 to 2023-06 (Bear deep + accumulation)
# W3 = 2023-06 to 2024-06 (Recovery + early bull)

# BTC filtered (con block ASIA + CONSOL)
run_oos BTCUSDT W1 2021-06-01 2022-06-01 "--block-session=ASIA --block-delta24h-bucket=CONSOLIDATION" "BTC_filtered"
run_oos BTCUSDT W2 2022-06-01 2023-06-01 "--block-session=ASIA --block-delta24h-bucket=CONSOLIDATION" "BTC_filtered"
run_oos BTCUSDT W3 2023-06-01 2024-06-01 "--block-session=ASIA --block-delta24h-bucket=CONSOLIDATION" "BTC_filtered"

# ETH baseline (sin filtros)
run_oos ETHUSDT W1 2021-06-01 2022-06-01 "" "ETH_baseline"
run_oos ETHUSDT W2 2022-06-01 2023-06-01 "" "ETH_baseline"
run_oos ETHUSDT W3 2023-06-01 2024-06-01 "" "ETH_baseline"

# XRP baseline
run_oos XRPUSDT W1 2021-06-01 2022-06-01 "" "XRP_baseline"
run_oos XRPUSDT W2 2022-06-01 2023-06-01 "" "XRP_baseline"
run_oos XRPUSDT W3 2023-06-01 2024-06-01 "" "XRP_baseline"

# SOL baseline
run_oos SOLUSDT W1 2021-06-01 2022-06-01 "" "SOL_baseline"
run_oos SOLUSDT W2 2022-06-01 2023-06-01 "" "SOL_baseline"
run_oos SOLUSDT W3 2023-06-01 2024-06-01 "" "SOL_baseline"

echo "OOS PORTFOLIO COMPLETE: $(date)"
