# Especificación SMC — Video 1 (Trading Sin Edición)

> Estado: **BORRADOR para co-validación** · 2026-05-27
> Regla: nada marcado 🔴 se implementa hasta validarlo con el usuario.
> Fuente: transcripción del directo "Curso Smart Money Gratis (Parte 1)".
> Esta spec es **viva**: se cierra marcando casos reales en el visor (Fase 4–5).

## Capas (no mezclar — ver `API-CONTRACT.md`)
- `MyManualMarks` — lo que marca el usuario (sobre **nuestras** velas, en el visor).
- `VideoSMC` — réplica algorítmica de las reglas de este documento.
- `StrictFVG` — FVG clásico de 3 velas (definición algorítmica estándar).
- `LuxAlgoReference` — referencia visual; **NO se clona**. Se puebla **manualmente** (igual que
  `MyManualMarks`): capturando lo que LuxAlgo marca en TradingView (rangos/timestamps), no por
  algoritmo, salvo que algún día tengamos el Pine Script fuente.

---

## 1. Fuerza / Impulso
**Video:** repite "movimiento con fuerza" = institución operando; mercado "aburrido/lateral" = sin fuerza.
**Regla propuesta:** una vela/tramo es `Impulse` si su rango o cuerpo supera `N×` la media reciente
de rango, y/o cierra cerca del extremo, y/o (si hay) volumen elevado.
**Parámetros:** `N` (mult. de fuerza), ventana de media, umbral de cierre-en-extremo.
**Nota (latencia vs confianza):** más velas de confirmación = más fiable pero detección más
tardía (peor para operar la entrada). Este trade-off se mide con los casos `timing` del dataset.
🔴 ¿Una sola vela basta o se requiere secuencia? ¿Cuerpo, rango o ambos? ¿Entra el volumen?

## 2. Estructura
**Video:** alcista mientras no rompa el punto bajo clave; bajista al romperlo. Análisis top-down.
**Regla propuesta:** swings por pivotes de `k` velas; tendencia por secuencia HH/HL vs LH/LL;
ruptura del último mínimo/máximo estructural = cambio.
**Parámetros:** `k` (pivote); definición de "punto clave".
🔴 ¿Qué pivote refleja tu lectura? ¿BOS/CHoCH formal o ruptura simple del punto?

## 3. Order Block
**Video:** estructura alcista → POI en zona baja; se marca **la última vela bajista antes del
impulso alcista**, **incluyendo mechas** ("desde la mecha alta hasta la mecha baja"). Se descarta
si la vela contraria adyacente la "equipara".

**Regla PROVISIONAL `VideoSMC`** (2026-05-27 — punto de partida, a validar con casos reales en el visor):
- OB = última vela de color contrario inmediatamente previa a un `Impulse` válido.
- Rango = `[low, high]` **completo, con mechas** por defecto (el video insiste en incluir mechas).
- **Override manual** permitido (cuerpo + mecha parcial), pero cada override es **señal de que la
  regla necesita ajuste**, NO una muleta permanente: alimenta la calibración.
- `Impulse` (fuerza/desplazamiento) es **requisito**. Romper estructura **NO** es requisito; es un
  **factor de calidad/confluencia** (ver §7). Dejar imbalance o coincidir con liquidez = más calidad.
- La zona se **emite solo cuando el impulso se confirma**, guardando `originCandleTime` (vela del OB)
  y `confirmedAtTime` (cuando se confirmó). Ver `NO-REPAINT-RULES.md`.

**Parámetros (configurables por timeframe, NO hardcodeados):**
```ts
impulseConfirmationBars: 1 | 2 | 3 | 5   // velas para confirmar la fuerza
strengthRangeMultiplier: number
strengthBodyMultiplier: number
closeNearExtremeThreshold: number
requiresStructureBreak: boolean          // default: false (factor de calidad, no requisito)
requiresImbalance: boolean               // default: false
```
🔴 Por validar en el visor: defaults de los multiplicadores por TF; criterio exacto de "equiparar";
si la mecha completa sobre-extiende la zona en 15m.

## 4. VideoImbalance (≠ StrictFVG)
**Video:** desequilibrio / "imbalance" / FVG = zona dejada por el movimiento con fuerza,
"parte de la liquidez"; a menudo entre una línea marcada y el OB. **Más amplio** que un FVG de 3 velas.
El precio "reequilibra" volviendo a rellenarla.
**Regla propuesta:** zona de desplazamiento asociada a un `Impulse`, medida sobre el tramo de
fuerza (no el patrón de 3 velas). `filled` cuando el precio la recorre.
🔴 ¿Cómo defines exactamente sus bordes (desde dónde hasta dónde)?

## 5. StrictFVG
**Definición estándar (no del video):** gap de 3 velas — `low[i+1] > high[i-1]` (alcista) /
`high[i+1] < low[i-1]` (bajista). **Capa separada** para comparar contra `VideoImbalance`.

## 6. Liquidez
**Video:** el precio va hacia donde hay liquidez; busca la **más cercana primero**.
**Regla propuesta:** clusters de máximos/mínimos (buyside arriba / sellside abajo); ordenar por
cercanía al precio; `swept` cuando se barre.
🔴 Tolerancia de cluster; ¿igualdad de máximos/mínimos cuenta como liquidez?

## 7. Confluencia (OB + Imbalance)
**Video:** "order block más imbalance" = mayor interés/fuerza. **NO** implica intersección geométrica.
**Regla propuesta:** `ConfluenceScorer` con señales: `sameImpulseId`, `adjacentToOrderBlock`,
`overlaps`, `distancePctFromOB`, `unfilledImbalanceNearOB`. Salida = **score**, no booleano.
🔴 Peso de cada criterio; umbral para "alta confluencia".

## 8. Mitigación / Invalidación
🔴 ¿Un OB queda inválido al ser tocado una vez, al cerrarse dentro, o al atravesarse del todo?
¿La zona caduca por tiempo? (Estados en `API-CONTRACT.md`: `UNTOUCHED`/`TOUCHED`/`MITIGATED`/`INVALIDATED`.)

## 9. Entradas (3 niveles)
**Video:** entrada alta (más riesgo, más probable), **central (preferida)**, baja (menos riesgo,
rara vez se cumple).
**Regla propuesta:** dentro del OB, ofrecer precios candidatos `HIGH` / `MID` / `LOW`.

## 10. SL / TP / Break-even
**Video:** SL al borde distal del OB (gestión ajustada, ej. ~0.5 %); TP a la siguiente liquidez/POI;
BE a mitad del recorrido.
**Regla propuesta:** SL = borde distal del OB ± buffer; **TPs candidatos** (conservador = primer POI
contrario, principal = liquidez más cercana, extendido = siguiente OB/imbalance mayor);
**R:R calculado** desde entry/SL/TP (nunca fijo); BE sugerido al 50 % del camino.
🔴 Buffer del SL; ¿cuál TP es el "principal" por defecto?
