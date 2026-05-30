# Contrato de API backend ↔ dashboard (v0.2 — borrador)

> Estado: v0.2 · 2026-05-29 · Transporte: REST (histórico/CRUD) + Socket.IO (tiempo real).
> Backend agnóstico al front. Cambios v0.2: modelo canónico de vela, tipo `Setup` con máquina de
> estados (ver `ENTRY-EDGE-SPEC.md`), `symbol` en todos los tipos, `breakEven` como sugerencia.

## Convenciones
- Tiempos en **epoch ms UTC**. Velas alineadas a UTC (1D cierra 00:00 UTC).
- **La causalidad se ancla al CIERRE de vela** (`closeTime`), no a la apertura. Solo velas con
  `isClosed=true` alimentan la detección (ver `NO-REPAINT-RULES.md`).
- Toda zona/setup/señal incluye `engineVersion` y `paramsHash` (reproducibilidad).
- El **visor consume las MISMAS velas del backend** (Binance/Bybit), NO las de TradingView.
  `LuxAlgoReference` es capa de referencia visual, no ground-truth.
- **Persistir velas desde el día uno** (Postgres). Razón: reproducibilidad del dataset + que visor,
  marcas manuales, motor y backtests causales vean exactamente la misma data + auditar `paramsHash`
  contra data exacta + no depender de respuestas cambiantes del exchange. *(El límite de ~6 meses
  del exchange aplica a `userTrades` privados — eso urge para el journal, no para velas públicas,
  que sí van años atrás vía `startTime/endTime`.)*

## Modelo canónico de vela
```ts
type Timeframe = '15m' | '1h' | '4h' | '1d';
type Side = 'LONG' | 'SHORT';

type Candle = {
  symbol: string;
  tf: Timeframe;
  openTime: number;     // epoch ms UTC
  closeTime: number;    // epoch ms UTC — la causalidad se ancla aquí
  o: number; h: number; l: number; c: number; v: number;
  quoteVolume?: number; // Bybit: turnover
  trades?: number;      // Binance only; Bybit no lo reporta
  isClosed: boolean;    // solo velas cerradas alimentan detección
};
```
> Este es el modelo **canónico persistido**. El shape interno de `src/exchange/interfaces`
> (`{openTime,...,closeTime,quoteVolume,trades}`) se normaliza a éste; el contrato es la proyección
> hacia el front. PK de persistencia: `(symbol, tf, openTime)`; índice por `(symbol, tf, closeTime)`.

## Capas y tipos de zona
```ts
type Layer = 'MyManualMarks' | 'VideoSMC' | 'StrictFVG' | 'LuxAlgoReference';
type MitigationStatus = 'UNTOUCHED' | 'TOUCHED' | 'PARTIALLY_MITIGATED' | 'MITIGATED' | 'INVALIDATED';
type LiquidityType = 'equalHighs' | 'equalLows' | 'swingHigh' | 'swingLow' | 'unfilledImbalance' | 'oppositePOI';

type Zone = {
  id: string; symbol: string;
  kind: 'OB' | 'VideoImbalance' | 'StrictFVG' | 'Liquidity';
  sourceLayer: Layer; side: Side; tf: Timeframe;
  high: number; low: number;          // para Liquidity puede ser nivel: low == high
  liquidityType?: LiquidityType;      // solo kind='Liquidity'
  // causalidad (NO-REPAINT)
  originCandleTime: number; confirmedAtTime: number; detectedAtTime: number; validFromTime: number;
  // ciclo de vida
  mitigationStatus: MitigationStatus; mitigatedPct?: number; mitigatedAtTime?: number;
  sweptAtTime?: number; invalidatedAt?: number;
  // confluencia (SMC-SPEC §7 — score 0-100, no booleano)
  confluenceScore?: number; confluenceBreakdown?: Record<string, number>;
  impulseId?: string;
  engineVersion: string; paramsHash: string;
};
```

## Setup y señal (ver `ENTRY-EDGE-SPEC.md`)
```ts
type SetupState = 'WATCHING' | 'MITIGATED' | 'ARMED' | 'TRIGGERED' | 'INVALIDATED' | 'EXPIRED';

type Setup = {
  id: string; symbol: string; side: Side; tf: Timeframe;
  zoneId: string;                 // POI base
  state: SetupState;
  // gates de edge (causales; cada uno solo es true si se evaluó con velas t <= su timestamp)
  htfAligned?: boolean; liquiditySwept?: boolean; inducementSwept?: boolean;
  premiumDiscountOk?: boolean; regimeOk?: boolean; inKillzone?: boolean; tradableNews?: boolean;
  // causalidad
  armedAtTime?: number; triggeredAtTime?: number; invalidatedAtTime?: number; invalidationReason?: string;
  engineVersion: string; paramsHash: string;
};

// SignalCandidate SOLO se emite cuando un Setup llega a TRIGGERED.
type SignalCandidate = {
  id: string; setupId: string; symbol: string; side: Side; tf: Timeframe; sourceZoneId: string;
  entries: { level: 'AGGRESSIVE' | 'MID' | 'CONSERVATIVE'; price: number }[];
  stopLoss: number;
  takeProfits: { kind: 'CONSERVADOR' | 'PRINCIPAL' | 'EXTENDIDO'; price: number; rr: number }[];
  minRrMet: boolean;              // ¿algún TP cumple minRiskReward?
  trigger: { mode: 'ltf_choch' | 'rejection_close' | 'displacement' | 'touch'; confirmedAtTime: number };
  breakEven: { mode: 'halfway_to_tp1' | 'at_1R' | 'manual'; price?: number };  // SUGERENCIA, no acción
  // tracking de expectancy (sin ejecutar — el usuario opera manual)
  plannedR: number; resultR?: number; outcome?: 'TP' | 'SL' | 'BE' | 'PARTIAL' | 'OPEN';
  // decisión del usuario (eje aparte del SetupState)
  userState: 'NEW' | 'ACCEPTED' | 'REJECTED' | 'EDITED' | 'TAKEN' | 'INVALIDATED';
  createdAt: number; engineVersion: string; paramsHash: string;
};
```

## Marcas manuales y journal
```ts
type ManualMark = {
  id: string; symbol: string; sourceLayer: 'MyManualMarks';
  kind: 'OB' | 'Imbalance' | 'Liquidity' | 'Entry' | 'SL' | 'TP';
  side?: Side; tf: Timeframe; high: number; low: number;
  timeStart: number; timeEnd: number;
  setupId?: string;               // agrupa Entry/SL/TP del mismo trade dibujado
  notes?: string; createdAt: number; updatedAt?: number;
};

type JournalEntry = {             // broker (read-only) + anotaciones del usuario
  id: string; symbol: string; side: Side;
  entryPrice: number; exitPrice?: number; qty: number;
  pnl?: number; fees?: number; openedAt: number; closedAt?: number;
  signalCandidateId?: string;     // vínculo con la señal sugerida, si la hubo
  obUsed?: string; reason?: string; emotion?: string; followedRules?: boolean; screenshotUrl?: string;
};
```

## REST (borrador)
- `GET  /candles?symbol&tf&limit[&from&to&cursor&before]` →
  `{ symbol, tf, count, oldestOpenTime, newestOpenTime, hasMoreOlder, candles: Candle[] }`
  - sin rango → las `limit` velas **más recientes** (lo que la gráfica abre)
  - `before=<openTime>` → las `limit` velas más recientes **anteriores** (cargar más historial)
  - `from`/`to`/`cursor` → rango explícito ascendente
  - `candles` siempre en orden `openTime` ascendente; proyección `o/h/l/c/v` (paginado por cursor sobre `openTime`)
- `GET  /zones?symbol&tf&sourceLayer` → `Zone[]`
- `GET  /setups?symbol&state` → `Setup[]`
- `GET  /signals?symbol&userState` → `SignalCandidate[]`
- `PATCH /signals/:id` → cambiar `userState` (`ACCEPTED`/`REJECTED`/…)
- `GET/POST /marks` → marcas manuales del usuario
- `GET  /journal` · `POST /journal/:id/notes` → journal

## Socket.IO (borrador, namespace `/ws`)
- `snapshot` (al conectar): `{ candles, zones, setups, signals }` del símbolo/TF activos.
- `candle:closed`: `{ candle, newZones, updatedZones, setupTransitions, newSignals }`.
- `candle:live` (opcional): vela en formación (`isClosed=false`; **NO** genera señales).
- `setup:update`: cambio de `SetupState`.
- `signal:update`: cambio de `userState` o de `outcome`.

## `paramsHash` (reproducibilidad)
`paramsHash` = hash estable (sha256) del JSON canónico ordenado del bloque de parámetros activos del
`engineVersion`. Sin esto la reproducibilidad es nominal. Definir el bloque exacto al construir el motor.

🔴 A refinar: autenticación (token local mínimo antes del live), formato de errores, multi-símbolo
en snapshot.
