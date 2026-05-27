# Reglas de no-repaint (causalidad)

> Estado: v1.0 · 2026-05-27
> Por qué: en histórico, las zonas SMC "se ven obvias"; en vivo solo se confirman tras cierta
> acción. Si el motor pinta hacia atrás como si lo hubiera sabido antes, recreamos un backtest
> mentiroso. Esto es **regla de arquitectura**, no una sugerencia.

## Regla de oro
`lookaheadBarsUsed = 0`. Ningún detector usa información de velas **posteriores** a la que procesa.

## Procesamiento
El motor avanza **vela por vela**. "Offline" también: **simula el tiempo real sobre histórico**,
nunca opera sobre el dataset completo de golpe.

## Campos obligatorios por zona
```ts
originCandleTime    // vela donde nace visualmente el OB/FVG
confirmedAtTime     // vela donde el motor pudo confirmarlo (tras el impulso)
detectedAtTime      // momento exacto en que el sistema lo emitió
validFromTime       // desde cuándo la zona puede usarse para señales
lookaheadBarsUsed = 0
```

## En el dashboard
Distinguir SIEMPRE dos cosas:
- **Origen** de la zona (dónde nació en el gráfico).
- **Detección** (cuándo el bot realmente pudo saberlo).

Así nunca creemos que el bot "sabía" una zona desde antes de poder saberla.

## Test
Una zona es válida solo si `confirmedAtTime >= originCandleTime` y toda la evidencia usada para
detectarla tiene `t <= detectedAtTime`. Un test automatizado debe **fallar** si un detector
referencia velas futuras.
