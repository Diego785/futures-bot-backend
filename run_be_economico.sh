#!/bin/bash
COMMON_15M="--days=365 --timeframe=15m --mode=pullback-ob --trail-mode=fixed-amount --trail-fixed=50 --trail-activation=50 --loose-htf --min-atr-pct=0.15 --trail-breakeven-at=200"
OUT=./backtest_outputs

run_t() {
  local name=$1
  shift
  echo "=== $name === $(date)"
  npm run backtest -- "$@" --output=$OUT/be_${name}.json --export-trades-csv=$OUT/be_${name}_trades.csv > $OUT/be_${name}.log 2>&1
  echo "Done: $name $(date)"
}

# BTC filtered: con y sin economic BE
run_t "BTC_legacy" --symbol=BTCUSDT $COMMON_15M --block-session=ASIA --block-delta24h-bucket=CONSOLIDATION
run_t "BTC_economic" --symbol=BTCUSDT $COMMON_15M --block-session=ASIA --block-delta24h-bucket=CONSOLIDATION --economic-be

# SOL baseline: con y sin
run_t "SOL_legacy" --symbol=SOLUSDT $COMMON_15M
run_t "SOL_economic" --symbol=SOLUSDT $COMMON_15M --economic-be

# ETH baseline
run_t "ETH_legacy" --symbol=ETHUSDT $COMMON_15M
run_t "ETH_economic" --symbol=ETHUSDT $COMMON_15M --economic-be

# XRP baseline
run_t "XRP_legacy" --symbol=XRPUSDT $COMMON_15M
run_t "XRP_economic" --symbol=XRPUSDT $COMMON_15M --economic-be

echo "BE ECONOMICO BATCH COMPLETE: $(date)"
