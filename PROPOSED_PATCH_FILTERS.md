# Patch propuesto — Filtros ASIA + CONSOLIDATION en bot live

**Estado**: Backtested 2026-05-10. Validado vs matriz 2×2 1Y BTCUSDT.
**Resultado**: PF baseline 4.11 → con filtros 6.95 (+69%). Max DD prácticamente igual (-$3.82 → -$3.97).
**No aplicado todavía**. Requiere aprobación del usuario antes de tocar código de producción.

## Cambios propuestos

### Archivo 1: `src/strategy/pullback-ob-signal.service.ts`

#### Cambio 1.1 — Agregar imports (top of file, after existing imports)

No requiere imports nuevos (toda la lógica usa primitivos).

#### Cambio 1.2 — Agregar config properties al constructor

**Línea ~47, después de `volumeMultiplier`**, agregar:

```typescript
// Phase 2 context filters — ASIA + CONSOLIDATION block (validated via 2x2 matrix backtest)
private readonly blockSessions: string[];
private readonly blockDelta24hBuckets: string[];
private readonly DELTA24H_LOOKBACK_BARS_15M = 96; // 24h en 15m
```

**Línea ~57 dentro del constructor**, agregar:

```typescript
this.blockSessions = (this.config.get<string>('PULLBACK_BLOCK_SESSIONS', '') || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
this.blockDelta24hBuckets = (this.config.get<string>('PULLBACK_BLOCK_DELTA24H', '') || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
```

#### Cambio 1.3 — Agregar helpers privados (cerca del final de la clase)

```typescript
private getSessionLabel(timestampMs: number): 'ASIA' | 'EU' | 'OVERLAP' | 'US' {
  const hour = new Date(timestampMs).getUTCHours();
  if (hour < 7) return 'ASIA';
  if (hour < 12) return 'EU';
  if (hour < 16) return 'OVERLAP';
  return 'US';
}

private computeDelta24hBucket(
  recentCandles: Array<{ close: number }>,
): 'CONSOLIDATION' | 'NORMAL' | 'MOMENTUM_EXTREME' | null {
  if (recentCandles.length < this.DELTA24H_LOOKBACK_BARS_15M) return null;
  const idx = recentCandles.length - 1;
  const lookbackIdx = idx - this.DELTA24H_LOOKBACK_BARS_15M;
  const priceNow = recentCandles[idx].close;
  const priceThen = recentCandles[lookbackIdx].close;
  if (priceThen <= 0) return null;
  const abs = Math.abs((priceNow - priceThen) / priceThen) * 100;
  if (abs < 1.0) return 'CONSOLIDATION';
  if (abs < 3.0) return 'NORMAL';
  return 'MOMENTUM_EXTREME';
}

private isBlockedByContext(lastCandleTimeMs: number, recentCandles: Array<{ close: number }>): string | null {
  if (this.blockSessions.length > 0) {
    const session = this.getSessionLabel(lastCandleTimeMs);
    if (this.blockSessions.includes(session)) return `Filtro sesión: ${session} bloqueada`;
  }
  if (this.blockDelta24hBuckets.length > 0) {
    const bucket = this.computeDelta24hBucket(recentCandles);
    if (bucket && this.blockDelta24hBuckets.includes(bucket)) {
      return `Filtro Δ24h: ${bucket} bloqueado`;
    }
  }
  return null;
}
```

#### Cambio 1.4 — Aplicar filtros JUSTO ANTES de cada return action

**Antes de la línea 218** (`this.resetSetup(symbol);` para LONG):

```typescript
// Phase 2 context filter — block entry by session/delta24h
const blockReason = this.isBlockedByContext(lastCandle.closeTime, features.recentCandles);
if (blockReason) {
  this.logger.log(`ENTRY LONG SKIPPED: ${blockReason}`);
  this.resetSetup(symbol);
  return { ...hold, reasoning: blockReason };
}
```

**Antes de la línea 253** (`this.resetSetup(symbol);` para SHORT):

```typescript
// Phase 2 context filter — block entry by session/delta24h
const blockReason = this.isBlockedByContext(lastCandle.closeTime, features.recentCandles);
if (blockReason) {
  this.logger.log(`ENTRY SHORT SKIPPED: ${blockReason}`);
  this.resetSetup(symbol);
  return { ...hold, reasoning: blockReason };
}
```

✅ Campo timestamp confirmado: `closeTime` en interface `Candle` (ver `src/exchange/interfaces/exchange.interfaces.ts:76`).

### Archivo 2: `.env` en producción (VPS)

Agregar al final:

```bash
# Phase 2 context filters — validated 2026-05-10 via 2x2 matrix backtest
# PF improvement 4.11 → 6.95 (+69%) on 1Y BTCUSDT 15m
PULLBACK_BLOCK_SESSIONS=ASIA
PULLBACK_BLOCK_DELTA24H=CONSOLIDATION
```

### Archivo 3: `CLAUDE.md` actualización

En sección "Pullback-OB Strategy", agregar nota sobre filtros activos.

## Plan de deploy

1. Aplicar cambios al código local
2. Build local + tests unitarios pasan
3. Commit con mensaje claro
4. SSH al VPS o git pull
5. Update `.env` en VPS con las nuevas variables
6. `docker compose down && docker compose up -d --build`
7. Verificar logs: cuando aparezca "ENTRY ... SKIPPED: Filtro sesión: ASIA bloqueada" en sesión ASIA, confirma que está activo
8. Monitorear 5-10 trades live

## Métricas a vigilar post-deploy

- Tasa de SKIP por filtro (debería ser ~50% de los setups que hubieran disparado)
- WR live debería tender hacia 68% (vs ~63% baseline)
- AvgWin debería subir y AvgLoss bajar levemente

## Rollback

Si en 10+ trades se ven anomalías inesperadas:
- Comentar las dos env vars en `.env`
- `docker compose restart`
- El código revierte automáticamente al comportamiento sin filtros (lista vacía → no bloquea nada)

## Tests sugeridos (antes de deploy)

```typescript
// pullback-ob-signal.service.spec.ts
describe('context filters', () => {
  it('blocks ASIA session when PULLBACK_BLOCK_SESSIONS=ASIA', () => { ... });
  it('blocks CONSOLIDATION when PULLBACK_BLOCK_DELTA24H=CONSOLIDATION', () => { ... });
  it('allows entry when filters not configured', () => { ... });
  it('allows MOMENTUM_EXTREME when CONSOLIDATION blocked', () => { ... });
});
```
