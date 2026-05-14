#!/bin/bash
COMMON_15M="--days=365 --timeframe=15m --mode=pullback-ob --trail-mode=fixed-amount --trail-fixed=50 --trail-activation=50 --loose-htf --min-atr-pct=0.15"
OUT=./backtest_outputs

run_t() {
  local name=$1
  shift
  echo "=== $name === $(date)"
  npm run backtest -- "$@" --output=$OUT/triage_${name}.json --export-trades-csv=$OUT/triage_${name}_trades.csv > $OUT/triage_${name}.log 2>&1
  echo "Done: $name $(date)"
}

# 1-2: ETH baseline + filtered
run_t "ETH_baseline" --symbol=ETHUSDT $COMMON_15M
run_t "ETH_filtered" --symbol=ETHUSDT $COMMON_15M --block-session=ASIA --block-delta24h-bucket=CONSOLIDATION

# 3-4: XRP baseline + filtered
run_t "XRP_baseline" --symbol=XRPUSDT $COMMON_15M
run_t "XRP_filtered" --symbol=XRPUSDT $COMMON_15M --block-session=ASIA --block-delta24h-bucket=CONSOLIDATION

# 5-6: SOL baseline + filtered
run_t "SOL_baseline" --symbol=SOLUSDT $COMMON_15M
run_t "SOL_filtered" --symbol=SOLUSDT $COMMON_15M --block-session=ASIA --block-delta24h-bucket=CONSOLIDATION

# 7-8: Session breakout 15m (BTC + ETH)
run_t "BTC_SB_15m" --symbol=BTCUSDT --days=365 --timeframe=15m --mode=session-breakout --sb-range-bars=4 --sb-rr=1.5 --sb-sessions=EU,OVERLAP,US
run_t "ETH_SB_15m" --symbol=ETHUSDT --days=365 --timeframe=15m --mode=session-breakout --sb-range-bars=4 --sb-rr=1.5 --sb-sessions=EU,OVERLAP,US

# 9: ETH 5m mean reversion
run_t "ETH_MR_5m" --symbol=ETHUSDT --days=365 --timeframe=5m --mode=mean-reversion --mr-rsi-long=25 --mr-rsi-short=75 --mr-sl-atr=1.0 --mr-tp-atr=1.5 --mr-cooldown-bars=6 --mr-sessions=EU,OVERLAP,US

echo "TRIAGE COMPLETE: $(date)"
