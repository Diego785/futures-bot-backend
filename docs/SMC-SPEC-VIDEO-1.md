# Especificación SMC — Video 1 (Trading Sin Edición)

> Estado: **BORRADOR para co-validación** · 2026-05-27
> Regla: nada marcado 🔴 se implementa hasta validarlo con el usuario.
> Fuente: transcripción del directo "Curso Smart Money Gratis (Parte 1)".
> Esta spec es **viva**: se cierra marcando casos reales en el visor (Fase 4–5).

## Capas (no mezclar — ver `API-CONTRACT.md`)
- `MyManualMarks` — lo que marca el usuario.
- `VideoSMC` — réplica de las reglas de este documento.
- `StrictFVG` — FVG clásico de 3 velas (definición algorítmica estándar).
- `LuxAlgoReference` — referencia visual/manual; **NO se intenta clonar**.

---

## 1. Fuerza / Impulso
**Video:** repite "movimiento con fuerza" = institución operando; mercado "aburrido/lateral" = sin fuerza.
**Regla propuesta:** una vela/tramo es `Impulse` si su rango o cuerpo supera `N×` la media reciente
de rango, y/o cierra cerca del extremo, y/o (si hay) volumen elevado.
**Parámetros:** `N` (mult. de fuerza), ventana de media, umbral de cierre-en-extremo.
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
**Regla propuesta:** última vela de color contrario inmediatamente previa a un `Impulse` válido;
rango = `[low, high]` (con mechas); descartar si la vela contraria siguiente la anula;
`mitigated` cuando el precio regresa a la zona.
**Parámetros:** fuerza del impulso; criterio de "equiparar".
🔴 ¿Siempre toda la mecha o cuerpo+mecha según caso? ¿El impulso debe romper estructura o basta
el desplazamiento? ¿Cuántas velas mira el impulso?

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
¿La zona caduca por tiempo?

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
