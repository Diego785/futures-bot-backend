# Migraciones v1 (archivadas — NO aplicar en v2)

Estas migraciones SQL pertenecen al bot v1 (autopiloto) y referencian tablas que **ya no existen**
en v2 (`daily_telemetry`, `bybit_pnl_reconciliation`, `strategy_state_snapshots`).

Se archivan aquí por trazabilidad histórica. **No las ejecutes contra la DB de v2.**

v2 definirá su propio esquema con migraciones explícitas cuando lleguen sus entidades
(Candle, Zone, Setup, SignalCandidate, ManualMark, JournalEntry — ver `docs/API-CONTRACT.md`).
TypeORM en v2 corre con `synchronize:false`.
