# Especificación SMC — Video 1 (Trading Sin Edición)

> Estado: **BORRADOR PROVISIONAL para co-validación** · 2026-05-27
> Regla: nada marcado 🔴 se implementa con valores fijos hasta validarlo con casos reales en el visor.
> Nada de números mágicos. Toda regla con parámetros configurables.
> Fuente: transcripción del directo "Curso Smart Money Gratis (Parte 1)".

## Capas (no mezclar — ver `API-CONTRACT.md`)
- `MyManualMarks` — lo que marca el usuario (sobre **nuestras** velas, en el visor).
- `VideoSMC` — réplica algorítmica de las reglas de este documento.
- `StrictFVG` — FVG clásico de 3 velas (definición algorítmica estándar).
- `LuxAlgoReference` — referencia visual; **NO se clona**. Se puebla **manualmente** (igual que
  `MyManualMarks`): capturando lo que LuxAlgo marca en TradingView (rangos/timestamps), no por
  algoritmo, salvo que algún día tengamos el Pine Script fuente.

> `MyManualMarks`, `VideoSMC` y `StrictFVG` corren todos sobre las **mismas velas del backend**.
> `LuxAlgoReference` es referencia visual; sus diferencias con `VideoSMC` no son errores del bot,
> son distintas interpretaciones.

---

## 1. Fuerza / Impulso
**Video:** repite "movimiento con fuerza" = institución operando; mercado "aburrido/lateral" = sin fuerza.
**Regla provisional `VideoSMC`:** una vela/tramo es `Impulse` si su rango y/o cuerpo supera la media
reciente por un multiplicador, y/o cierra cerca del extremo, y/o (si hay) volumen elevado. La fuerza
puede medirse por rango, cuerpo, cierre cerca del extremo, secuencia de velas o volumen.

**Parámetros (por timeframe, NO hardcodeados):**
```ts
strengthRangeMultiplier: number       // rango supera N x media reciente
strengthBodyMultiplier: number        // cuerpo supera N x media reciente
averageWindow: number                 // velas para la media de referencia
closeNearExtremeThreshold: number     // 0..1, qué tan cerca del extremo cierra
minDisplacementCandles: number        // mínimo de velas para considerar "impulso"
```

**Nota (latencia vs confianza):** más velas de confirmación = más fiable pero detección más
tardía (peor para operar la entrada). Trade-off medido con los casos `timing` del dataset.
🔴 Defaults por TF; pesos relativos de rango/cuerpo/cierre/volumen.

## 2. Estructura
**Video:** alcista mientras no rompa el punto bajo clave; bajista al romperlo. **Análisis top-down**
(mensual → semanal → diario → 4H → 1H → 15m → 5m); una zona de 15m existe **dentro del contexto** 1H/4H.
**Regla provisional `VideoSMC`:** swings por pivotes de `swingLookback` velas; tendencia por secuencia
HH/HL vs LH/LL; ruptura del último mínimo/máximo estructural = cambio.

**Parámetros:**
```ts
swingLookback: number                  // velas a cada lado para detectar pivote
structureBreakMode: 'wick' | 'close'   // ruptura por mecha o por cierre (default sugerido: 'close')
biasTimeframes: Timeframe[]            // top-down: contexto a considerar
```

🔴 Defaults; ¿BOS/CHoCH formal o ruptura simple? ¿qué es "el punto clave" en cada TF?

## 3. Order Block — ESENCIA ESTRUCTURAL (revisado 2026-06-02)

> **Corrección de fondo tras releer el Video 1 + calibrar contra "Order Blocks & Breaker Blocks
> [LuxAlgo]" (Swing Lookback 10 · 3+3 · rango completo, sobre BTCUSDT Binance).** La versión
> anterior anclaba el OB al **impulso local** (cualquier vela contraria + una vela fuerte que rompe
> el extremo de esa vela) → marcaba **66 OBs en 4h** sin jerarquía, con fósiles de meses. El video
> ancla a la **ESTRUCTURA**: *primero la estructura, después el OB*. El impulso/fuerza **CONFIRMA**;
> no es el ancla. Este es el cambio que captura la esencia y, de paso, alinea con LuxAlgo (que es
> swing-based). Decisión del usuario (2026-06-02): el modo estructural es el **principal**.

**Video (los 5 pasos en orden):** (1) define estructura (alcista/bajista); (2) busca el POI en el
**swing más cercano** del lado correcto (*"la parte baja más cercana pero la más baja"* = swing
low si alcista; swing high si bajista); (3) marca **la última vela contraria** en ese origen,
**con mechas**; (4) **descarta si la vela vecina la "equipara"** (no hubo fuerza); (5) se enfoca en
**POCOS**, los más cercanos, **gráfico limpio** (*"cuando opero, solo marco SL y profit"*).

**Regla provisional `VideoSMC` (swing-first):**
- **Ancla = estructura.** Detectar swings (pivotes de `swingLookback` velas). Un OB nace cuando el
  precio **rompe un swing previo (BOS)** en el sentido de la estructura: el OB es la **última vela
  de color contrario en el origen de esa pierna** — NO cualquier vela-antes-de-impulso.
- **Fuerza = confirmación, no ancla.** La pierna que rompe el swing debe tener fuerza (§1). Si la
  vela vecina **equipara** a la del OB, se descarta.
- **Rango** = `[low, high]` completo (con mechas); opción `useCandleBody` (LuxAlgo la ofrece).
- **Pocos y cercanos.** Mostrar `showLastN` por lado (default **3+3**, como LuxAlgo) + filtro de
  cercanía/recencia → nunca un mapa de 60 ni fósiles. Es la esencia del "gráfico limpio".
- **Causal**: emite al confirmarse la ruptura (`originCandleTime`/`confirmedAtTime`; sin repaint).
- **Roto → Breaker Block** (función invertida; ver `SMC-SPEC-VIDEO-3.md`): NO se descarta.

**Parámetros (calibrados a los settings reales del usuario; provisionales 🔴):**
```ts
obMode: 'structural' | 'impulse'   // default 'structural'; 'impulse' = lente anterior (opcional)
swingLookback: number              // default 10  (= "Swing Lookback" de LuxAlgo)
showLastBullish: number            // default 3
showLastBearish: number            // default 3
useCandleBody: boolean             // default false (rango completo con mechas)
requireBOS: boolean                // default TRUE — romper el swing es ahora REQUISITO (antes: calidad)
// + parámetros de fuerza de §1, ahora usados para CONFIRMAR la pierna que rompe el swing
```
🔴 Definición exacta de swing/BOS (mecha vs cierre); criterio de "equiparar"; cómo combinar
recencia + cercanía para "pocos"; relación entre `swingLookback` y el TF.

> **Default de visualización (decisión del usuario, 2026-06-02): la gráfica abre con SOLO la capa
> OB.** FVG, Liquidez, Confluencia, Setups y Planes quedan **OFF** por defecto; el usuario activa lo
> que quiera y marca el resto a mano. El OB es "de lo más importante" → es el foco del copiloto.

## 4. VideoImbalance (≠ StrictFVG)
**Video:** desequilibrio / "imbalance" / FVG = zona dejada por el movimiento con fuerza,
"parte de la liquidez"; a menudo entre una línea marcada y el OB. **Más amplio** que un FVG de 3 velas.
**Regla provisional `VideoSMC`:** zona de desplazamiento asociada a un `Impulse`, medida sobre el
tramo de fuerza (no el patrón de 3 velas). Se relaciona con el OB que originó el impulso.

**Parámetros:**
```ts
videoImbalanceMode: 'impulse_span' | 'range_to_ob' | 'manual'
imbalanceMinSizePct: number       // tamaño mínimo (relativo al ATR/rango)
linkToOriginOB: boolean           // mantener relación con OB del impulso
```

> `three_candle` queda **exclusivo de `StrictFVG`** (§5). `VideoImbalance` nunca usa ese modo
> para no contaminar las dos definiciones.

🔴 Bordes exactos del imbalance (desde dónde hasta dónde); umbral de `filled` parcial vs total.

## 5. StrictFVG
**Definición estándar (no del video):** gap de 3 velas — `low[i+1] > high[i-1]` (alcista) /
`high[i+1] < low[i-1]` (bajista). **Capa separada** para comparar contra `VideoImbalance`.
**Parámetros:** opcional `minSizePct` para filtrar ruido. **Único** consumidor del patrón
`three_candle`; nunca se mezcla con `VideoImbalance`.

## 6. Liquidez
**Video:** el precio va hacia donde hay liquidez; busca la **más cercana primero**.
**Regla provisional `VideoSMC`:** la liquidez NO es solo "high/low cercano". Contempla múltiples
fuentes y se ordena por cercanía y/o fuerza.

**Tipos contemplados:**
```ts
equalHighs                  // double/triple top — más fuerte
equalLows                   // double/triple bottom — más fuerte
swingHighs                  // swing high único
swingLows                   // swing low único
unfilledImbalance           // imbalance no rellenado = liquidez objetivo
oppositePOI                 // OB/POI contrario alcanzable
nearestLiquidityByDistance  // ordenar por distancia al precio
```

**Parámetros:**
```ts
clusterTolerancePct: number       // tolerancia para considerar highs/lows "iguales"
swingTouchesForLiquidity: number  // toques mínimos para marcar swing como liquidez
liquidityWeighting: 'distance' | 'strength' | 'mixed'
```

🔴 Pesos exactos; caducidad por tiempo; ¿`swept` cuenta cuando la mecha barre y la vela cierra dentro?

## 7. Confluencia (OB + Imbalance + otros)
**Video:** "order block más imbalance" = mayor interés/fuerza. **NO** implica intersección geométrica.
**Regla provisional `VideoSMC`:** `ConfluenceScorer` con señales múltiples; salida = **score 0–100**,
no booleano.

**Criterios del score:**
```ts
sameImpulseId           // OB e imbalance nacen del mismo impulso
adjacentToOrderBlock    // zonas vecinas (aunque no se solapen)
overlaps                // solapamiento geométrico
distancePctFromOB       // proximidad relativa
unfilledImbalanceNearOB // imbalance no rellenado próximo al OB
nearLiquidityCluster    // proximidad a liquidez relevante
inHTFContext            // dentro del contexto de bias en TF mayor
```

🔴 Pesos relativos de cada criterio; umbral de "alta confluencia" para marcado visual.

## 8. Mitigación / Invalidación (ciclo de vida)
**Estados** (en `API-CONTRACT.md` como `MitigationStatus`):
```ts
UNTOUCHED              // el precio no ha tocado la zona
TOUCHED                // entró pero no la consumió
PARTIALLY_MITIGATED    // entró parcialmente sin invalidar la zona
MITIGATED              // el precio recorrió la zona (consumida)
INVALIDATED            // estructura/contexto se rompió contra la zona
```

**Regla provisional `VideoSMC`:**
- `TOUCHED` = la mecha entró pero el precio rebotó sin consumir más allá de `touchedThresholdPct`.
- `PARTIALLY_MITIGATED` = consumo entre `touchedThreshold` y `mitigatedThreshold` en una sola visita.
- `MITIGATED` = se recorrió ≥ `mitigatedThresholdPct` (típicamente extremo distal).
- `INVALIDATED` = cierre más allá del extremo distal o cambio de bias HTF en contra.

**Parámetros:**
```ts
touchedThresholdPct: number                      // p.ej. 25 %
partiallyMitigatedRangePct: [number, number]    // p.ej. [25, 99]
mitigatedThresholdPct: number                    // p.ej. 100 %
invalidationByCloseBeyond: boolean               // requiere cierre, no solo mecha
zoneMaxAgeBars: number | null                    // caducidad por antigüedad; null = sin caducidad
```

**Breaker Block (Video 3 — ver `SMC-SPEC-VIDEO-3.md`):** un OB `INVALIDATED` por ruptura **con
fuerza** NO se descarta — gana una "segunda vida" como **Breaker Block**: un POI con la **función
invertida** (OB de compra roto → POI de venta, y viceversa), con `originObId`. Se invalida (consume)
si el precio lo re-rompe en contra. **Hoy es capa de ESTUDIO, no entrada** (el propio video advierte
bajo edge en cripto). No confundir con `INVALIDATED`-y-descartado: el BB es una zona derivada nueva.

🔴 Defaults de los umbrales; ¿la mitigación parcial reduce el score de confluencia (§7)?
🔴 "Roto con fuerza" para promover OB→BB; vigencia/consumo del BB; cuántos mostrar (anti-ruido).

## 9. Entradas (3 candidatos)
**Video:** entrada alta (más riesgo, más probable), **central (preferida)**, baja (menos riesgo,
rara vez se cumple).
**Regla provisional `VideoSMC`:** dentro del OB, ofrecer 3 candidatos. La preferida por defecto es la central.

**Parámetros:**
```ts
entryAggressive: number     // borde proximal (cerca del precio actual)
entryMid: number            // midpoint del OB
entryConservative: number   // borde distal (más profundo en el OB)
preferredEntry: 'AGGRESSIVE' | 'MID' | 'CONSERVATIVE'  // default 'MID' (alineado al video)
```

## 10. SL / TP / Break-even
**Video:** SL al borde distal del OB (gestión ajustada, ~0.5 %); TP en la siguiente liquidez/POI;
BE a mitad del recorrido.

**Regla provisional `VideoSMC`:**

**Stop-Loss:**
```ts
slMode: 'distal_ob' | 'distal_ob_plus_buffer'
slBufferTicks: number      // buffer en ticks del símbolo
slBufferPct: number        // o buffer en % del precio (elegir uno)
```

**Take-Profit (siempre múltiples candidatos, R:R calculado):**
```ts
tpConservative   // primer POI contrario o primera liquidez
tpMain           // liquidez relevante más cercana — default "principal"
tpExtended       // siguiente OB/imbalance mayor
```
El R:R se **calcula** desde `entry` / `SL` / `TP`. **Nunca se impone.**

**Break-Even:**
```ts
breakEvenTrigger: 'halfway_to_tp1' | 'at_1R' | 'manual'  // default 'halfway_to_tp1' (video)
```

🔴 Defaults del buffer del SL; cuál TP por defecto es "principal"; si BE se mueve automático o se sugiere.
