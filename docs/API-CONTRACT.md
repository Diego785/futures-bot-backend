# Contrato de API backend ↔ dashboard (v0.1 — borrador)

> Estado: v0.1 (a refinar) · 2026-05-27
> Transporte: REST (histórico/CRUD) + Socket.IO (tiempo real). Backend agnóstico al front.

## Convenciones
- Tiempos en **epoch ms UTC**. Velas alineadas a UTC (1D cierra 00:00 UTC).
- Toda zona incluye campos de causalidad (ver `NO-REPAINT-RULES.md`).
- Toda zona/señal incluye `engineVersion` y `paramsHash` (reproducibilidad).
- El **visor consume las MISMAS velas del backend** (Binance/Bybit), NO las de TradingView. El
  golden dataset se marca sobre nuestras velas para ser comparable con el motor; LuxAlgo/TradingView
  entran solo como capa de referencia (`LuxAlgoReference`).

## Tipos núcleo (borrador)
```ts
type Timeframe = '15m' | '1h' | '4h' | '1d';
type Side = 'LONG' | 'SHORT';
type Layer = 'MyManualMarks' | 'VideoSMC' | 'StrictFVG' | 'LuxAlgoReference';
type MitigationStatus = 'UNTOUCHED' | 'TOUCHED' | 'PARTIALLY_MITIGATED' | 'MITIGATED' | 'INVALIDATED';

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number; tf: Timeframe };

type Zone = {
  id: string;
  kind: 'OB' | 'VideoImbalance' | 'StrictFVG' | 'Liquidity';
  sourceLayer: Layer; side: Side; tf: Timeframe;
  high: number; low: number;
  // causalidad (NO-REPAINT)
  originCandleTime: number; confirmedAtTime: number; detectedAtTime: number; validFromTime: number;
  // ciclo de vida
  mitigationStatus: MitigationStatus; mitigatedAtTime?: number; invalidatedAt?: number;
  impulseId?: string;
  engineVersion: string; paramsHash: string;
};

type SignalCandidate = {
  id: string; side: Side; tf: Timeframe; sourceZoneId: string;
  entries: { level: 'HIGH' | 'MID' | 'LOW'; price: number }[];
  stopLoss: number;
  takeProfits: { kind: 'CONSERVADOR' | 'PRINCIPAL' | 'EXTENDIDO'; price: number; rr: number }[];
  breakEvenAt: number;
  state: 'NEW' | 'ACCEPTED' | 'REJECTED' | 'EDITED' | 'TAKEN' | 'INVALIDATED';
  createdAt: number; engineVersion: string; paramsHash: string;
};

type ManualMark = {            // marcas que el usuario dibuja en el visor
  id: string; sourceLayer: 'MyManualMarks';
  kind: 'OB' | 'Imbalance' | 'Liquidity' | 'Entry' | 'SL' | 'TP';
  side?: Side; tf: Timeframe; high: number; low: number;
  timeStart: number; timeEnd: number; notes?: string;
};

type JournalEntry = {          // broker (read-only) + anotaciones del usuario
  id: string; symbol: string; side: Side;
  entryPrice: number; exitPrice?: number; qty: number;
  pnl?: number; fees?: number; openedAt: number; closedAt?: number;
  signalCandidateId?: string;  // vínculo con la señal sugerida, si la hubo
  obUsed?: string; reason?: string; emotion?: string; followedRules?: boolean; screenshotUrl?: string;
};
```

## REST (borrador)
- `GET  /candles?symbol&tf&from&to` → `Candle[]`
- `GET  /zones?symbol&tf&sourceLayer` → `Zone[]`
- `GET  /signals?symbol&state` → `SignalCandidate[]`
- `PATCH /signals/:id` → cambiar estado (`ACCEPTED`/`REJECTED`/…)
- `GET/POST /marks` → marcas manuales del usuario
- `GET  /journal` · `POST /journal/:id/notes` → journal

## Socket.IO (borrador, namespace `/ws`)
- `snapshot` (al conectar): `{ candles, zones, signals }` del símbolo/TF activos.
- `candle:closed`: `{ candle, newZones, updatedZones, newSignals }`.
- `candle:live` (opcional): vela en formación (NO genera señales).
- `signal:update`: cambio de estado de una señal.

🔴 A refinar: paginación, multi-símbolo, autenticación, formato de errores.
