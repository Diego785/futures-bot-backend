# Ciclo 5 — Pre-registro: «La caza del pool» (barrido de liquidez multi-día dentro de POI 4H)

> **Estado: PRE-REGISTRADO (2026-08-02). NO ejecutado.** Ni el código ni las corridas arrancan hasta
> cerrar la **evaluación de 20 fills** del test real P.5.4 (trato sellado 2026-07-23). Este documento
> congela la hipótesis ANTES de mirar cualquier dato, siguiendo `DATASET-PROTOCOL.md`.

## §0 Origen y motivación

Semilla: **la trade MANUAL del usuario en BTCUSDT (2026-07-31)** — short a 65.325 DENTRO de la vela que
barrió los equal highs multi-día del 07-27 (~65.300-65.391), dentro del stack de supply/OB 4H
(65.0-65.655), con sesgo 4H bearish (volteado el 07-28), SL 65.600 (sobre la mecha + buffer), salida
63.303 = **+7.3R**. Entrada, SL y gestión validados en el audit del 2026-08-02.

Pregunta del ciclo: ¿ese patrón —cazar el barrido de un pool GRANDE dentro de zona 4H, dejándolo correr
lejos— tiene **edge mecánico**, o solo funciona con el filtro discrecional del ojo entrenado?

Prior honesto declarado: las 4 mecanizaciones anteriores de conceptos «de libro» (C2 targets/pools, C3
CHoCH+FVG, htf2, runner-al-pool V1-V4) **fallaron**. Lo genuinamente nuevo aquí: (a) clase de liquidez
distinta (pools multi-día vs swings de horas), (b) entrada maker EN el pool antes del barrido (nunca
probada; el fill-stress probó otra cosa: mercado tras confirmación del gatillo C = −0.188R), (c) el
runner lejano se reabre SOLO porque las trades nacen de contexto mayor (fue refutado 2× sobre trades del
gatillo C — eso no se olvida, se declara).

## §1 La regla (spec causal, vela a vela — lookahead 0)

**Pool de liquidez (nivel L):**
- ≥2 extremos del mismo lado (highs para short / lows para long) dentro de tolerancia **ε** del nivel,
  separados ≥ **P** velas 15m entre sí, con antigüedad del más viejo ≥ **D** días.
- NO barrido desde su formación: ninguna mecha posterior superó L+ε (short) / L−ε (long).

**POI 4H:** order block estructural 4H (detector swing-first existente) **vigente** (no mitigado por
cierre) que contenga L dentro de su rango [low, high] (margen β).

**Sesgo 4H:** `computeHtfBias` congelado (swing 10, BOS por cuerpo). Solo short con bearish / long con
bullish — idéntico al candidato.

**Armado y entrada (variante A — «límite en el pool»):**
- Cuando pool + POI + sesgo coinciden al cierre de una vela 15m → colocar **límite en L** (maker; la
  mecha del sweep nos llena — somos la liquidez).
- SL = L ± **buffer** (% fijo sobre L). Piso fee-aware `minStopPct 0.003` idéntico al candidato.
- Fill simulado pesimista igual que el simulador actual (same-bar SL-first).

**Entrada (variante B — «mercado tras reclaim»):**
- Sin límite anticipada. Vela 15m que barre L Y cierra de vuelta del lado correcto → entrada a MERCADO
  al open de la siguiente vela (fee taker).

**Cancelación de la límite (variante A):** se retira si (a) el sesgo 4H voltea, (b) el POI se mitiga
por cierre, o (c) pasan **T** días sin fill.

**Salidas (3 variantes):** TP1 50% @ +1R → SL a BE (EN ganancia) **siempre** (el mecanismo validado del
C4 no se toca). El runner varía:
1. **2R fijo** (el candidato actual — control);
2. **POI 4H opuesto** más cercano vigente al momento del fill (causal; si no existe → 2R);
3. **Trailing estructural 4H**: el SL sigue al último swing 4H confirmado (lookback 10).

## §2 Grid pre-declarado (TODO lo que se probará — nada más)

- **Grid principal: entrada {A, B} × runner {2R, POI-4H, trailing} = 6 combos.**
- Parámetros FIJOS (no se tunean): ε = 0.10% de L · P = 16 velas · D = 2 días · β = 0 (contener
  estricto) · buffer = 0.35% · T = 10 días · minStopPct 0.003 · fees maker 0.02%/taker 0.05%.
- Tras el veredicto, UNA pasada de sensibilidad en vecindad (ε ±0.05, D {2,4}, buffer {0.3, 0.5}) solo
  para verificar meseta — NO para elegir el mejor (anti cherry-pick).

## §3 Datos y protocolo

- 15 símbolos del universo vigente, histórico local 2022-2026 (mismas velas de las corridas canónicas).
- Calibración / held-out / walk-forward 12 ventanas — mismo protocolo que C4.
- Benchmark: **candidato congelado v2** sobre el mismo período/universo.

## §4 Criterios de veredicto (pre-fijados)

1. **Piso de N:** si el held-out da **N < 60 trades** (pooled), el ciclo es **NO CONCLUYENTE** por
   diseño → la regla queda como herramienta de estudio, jamás como reemplazo. (Los pools multi-día son
   raros; se declara antes de saber cuántos hay.)
2. **Reemplazo del candidato** solo si cumple TODOS los criterios del C4 §5 (expectancy held-out
   superior, no-peor en la mayoría de símbolos, maxDD no peor, WF no peor, mecanismo explicable).
3. **Resultado «COMPLEMENTO» (nuevo, posible):** si C5 es positivo, de baja frecuencia y sus trades NO
   se solapan con las del gatillo C → puede proponerse como SEGUNDO gatillo en cartera. Eso exigiría su
   propio mini-gate (paper shadow primero) — nunca directo al dinero real.
4. Cualquier otro resultado → negativo-informativo, se documenta y se archiva (como C2/C3).

## §5 Riesgos declarados por adelantado

- **N bajo** → bandas anchas → fácil autoengaño (mitigado por el piso del §4.1).
- **La variante A come rupturas reales**: sin confirmación, la límite se llena también cuando el
  «barrido» es una ruptura genuina. El experimento mide exactamente si los +7R de las buenas pagan esos
  SL. El ojo del usuario filtraba esto; la regla no puede.
- **El runner lejano ya falló 2 veces** en trades del gatillo C — si vuelve a fallar aquí, es la 3ª
  confirmación y se cierra el tema targets-por-niveles para siempre.

## §6 Timing y disciplina

- **La construcción y las corridas pueden ejecutarse desde ya** (investigación offline, DB local
  read-only — igual que C2/C3/C4, que corrieron con el gate vivo). *(Corregido 2026-08-02: la versión
  original congelaba también las corridas; esa restricción protegía lo incorrecto.)*
- **Lo que SÍ espera a la evaluación de 20 fills es ACTUAR sobre los resultados**: pase lo que pase en
  este ciclo, el candidato congelado v2, el capital, el universo y el trato sellado del 2026-07-23 no se
  tocan hasta cerrar esa evaluación (prep a 15 fills; hoy vamos 12).
- Registrado por pedido explícito del usuario («yes» al plan, 2026-08-02), con su trade como semilla.
  La hipótesis y el grid del §1-§2 quedaron congelados ANTES de cualquier corrida — eso no cambia.
