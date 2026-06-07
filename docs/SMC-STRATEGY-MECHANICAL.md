# SMC Strategy Mechanical — Especificación mecánica unificada (V1 + V2 + V3)

> **Estado:** 🔴 provisional en los valores numéricos; **fuente de verdad** para el motor de
> señales y el backtest a partir de aquí. Síntesis propia derivada de las transcripciones de los
> 3 videos de *Trading Sin Edición* (OB / entradas / Breaker) + los análisis de apoyo.
> Última actualización: 2026-06-06.

## 0. Propósito y alcance — y relación con la Regla Cero

Este documento convierte la estrategia SMC discrecional de los 3 videos en una **especificación
100 % mecánica, causal y backtesteable**. Es el contrato del que se derivan los detectores y el
motor de backtest.

**No viola la Regla Cero.** Backtestear = simular sobre histórico; **no coloca, modifica ni
cancela ninguna orden real**. La eventual "autonomía" (que el bot decida/ejecute en vivo) es una
**decisión futura y separada**, NO autorizada por este documento, que exigiría su propia revisión
de seguridad (kill-switch, límites, IP whitelist, forward-test en papel). Aquí solo definimos la
lógica y cómo medir si esa lógica tiene edge.

Decisión del usuario (2026-06-06): **mecánica + backtest primero; la forma de ejecución se decide
después, con la curva de equity out-of-sample delante.**

## 1. Principio rector

> **Zona ≠ entrada. El edge vive en el GATILLO, no en el dibujo del OB.**
> Entrar *al toque* de la zona (entrada por riesgo) es *adverse selection* — es exactamente lo que
> hundió al v1 (PF 7.37 in-sample → −68 % en vivo). El edge está en **esperar** a que el precio
> confirme (confirmación en LTF) o **barra liquidez y reclame** la zona (sweep + reclaim).

## 2. Causalidad (no-repaint, lookahead = 0)

Regla absoluta (ver `NO-REPAINT-RULES.md`): **todo evento se confirma al CIERRE de la vela**, nunca
intrabar. Nada se dibuja/dispara con información futura.

- Un **swing** se confirma solo `lookback` velas después de formarse (pivote estricto).
- Un **BOS** se confirma cuando una vela **cierra con cuerpo** más allá del swing.
- Un **OB** se ancla en su vela de origen pero se **publica** solo tras el BOS que lo valida.
- Una **invalidación**, un **sweep+reclaim** y una **confirmación LTF** se evalúan **al cierre**.
- La entrada se ejecuta (en el backtest) en la vela **siguiente** al evento confirmado.

## 3. La estrategia en capas

### Capa 0 — Datos
Solo velas cerradas. **HTF** (1D / 4H / 1H) para sesgo y POI; **LTF** (15m / 5m) para el gatillo.
Persistidas desde el día uno.

### Capa 1 — Sesgo estructural (HTF)
Swings por pivotes estrictos (`swingLookback` = 10) → **BOS por cierre de cuerpo** sobre el último
swing confirmado define el sesgo. Sesgo alcista → POIs de demanda (abajo); bajista → oferta (arriba).

### Capa 2 — POI / zona madre
OB **estructural** (swing-first; ya implementado en `ob.detector.ts`): última vela contraria antes
del impulso que produjo el BOS; rango = high-low **con mechas**.
- **Gate de fuerza:** el impulso debe **superar** (no *igualar*) el rango del OB (V1: "si equipara,
  no hay fuerza").
- **Confluencia con FVG/imbalance** adyacente → sube el ranking (no es requisito).
- **Invalidación por CUERPO, no por mecha** (V3): el OB vive mientras ningún **cuerpo** cierre fuera
  del borde distal. *Una mecha que perfora pero cuyo cuerpo vuelve adentro = **sweep que REFUERZA**
  la zona, no la invalida.* ← ajuste pendiente en `computeState`.

### Capa 3 — Ranking de POIs
`score = cercanía al precio + fuerza del impulso + confluencia FVG + alineación con sesgo +
no-invalidado`. Operar solo el **top-N** (`maxPois` = 3 por dirección, estilo "Show Last 3").
El bot marca todos; opera los importantes (V1/V3).

### Capa 4 — Gatillo de entrada (EL EDGE) — tres modos
| Modo | Definición causal | Rol |
|---|---|---|
| **A · Riesgo** | Orden límite en CE del POI, sin esperar reacción. | **Control / baseline** (= adverse selection) |
| **B · Confirmación** (V2) | Tras mitigar el POI (precio entra), un **BOS en LTF** (cierre de cuerpo) forma un **OB interno** → entrada en ese OB interno. | Edge medio |
| **C · Sweep + Reclaim** (V3) | Una vela cuya **mecha** excede el extremo del POI/swing (barre liquidez) pero cuyo **cuerpo cierra de vuelta dentro** → entrada en la reacción. | **Mayor edge en cripto** (antídoto del adverse selection) |

**Hipótesis comprobable:** `C ≥ B > A` en expectancy. Si el backtest no lo muestra, la mecanización
del gatillo está mal (no es que la estrategia falle). El modo C captura los "movimientos bruscos"
que el usuario quiere aprovechar (un movimiento brusco suele ser un barrido de liquidez).

### Capa 5 — Gestión (FIJADA por lógica; NO se optimiza)
- **Entrada:** CE (50 %) del OB usado (madre en A, interno en B, reacción en C).
- **SL:** borde distal del OB usado + `slBuffer`, medido por cuerpo; en C, bajo la mecha del sweep.
- **Break-even:** mover SL → entrada al alcanzar el **50 %** del recorrido a TP (V1).
- **Sizing:** riesgo fijo **0.5–1 %** por trade. Apalancamiento informativo (5x alta vol / 10x baja
  vol, V2); no afecta la señal, sí la curva.

### Capa 6 — Filtros de régimen
- Evitar laterales aburridos con filtro de **volatilidad** (ATR/rango). **NO killzone horaria** — V2
  lo desmiente; lo único temporal del método es "fines de semana = menos volatilidad".
- **Cancelación** de orden pendiente: si el precio se aleja > `cancelDistance` sin fill, o si el POI
  se invalida por cuerpo → cancelar; **no cuenta como trade** (V2: "ni ganaste ni perdiste").

### Capa 7 — Breaker Block
**Solo capa de estudio en cripto** (ya visible, commit `b134056`). **Fuera del motor de señales del
backtest BTC**: el propio creador dice que en cripto se respeta *"uno cada 2-3 meses"* → muestra
insuficiente para concluir nada. Reconsiderar solo si algún día se backtestea en mercados
tradicionales (forex/índices).

## 4. Definiciones causales precisas (para el implementador)

- **Swing high (low):** vela `i` cuyo high (low) es estrictamente mayor (menor) que el de todas las
  velas en `[i − lookback, i + lookback]`. Confirmado en `i + lookback`.
- **BOS:** cierre de cuerpo de una vela por encima del último swing high (alcista) / por debajo del
  último swing low (bajista).
- **OB origen:** última vela de dirección contraria al impulso, inmediatamente antes del tramo que
  produce el BOS. Rango = `[low, high]` con mechas.
- **Mitigación:** el precio entra en el rango del OB (toque del borde proximal).
- **Invalidación:** **cierre de cuerpo** más allá del borde distal del OB.
- **Sweep + reclaim:** `high_mecha > extremo` (o `low_mecha < extremo`) **y** `close_cuerpo` dentro
  del rango del POI/swing, en la misma vela, confirmado al cierre.
- **Confirmación LTF:** tras mitigación del POI en HTF, primer BOS en LTF (cierre de cuerpo) en la
  dirección del sesgo dentro de `maxWaitConfirmBars`; el OB que lo origina es el OB interno.

## 5. Parámetros: fijos vs libres

**Fijos por lógica del método (NO se tunean):**
| Parámetro | Valor | Origen |
|---|---|---|
| Entrada dentro del OB | CE = 50 % | V1/V2 (default del mentor) |
| Break-even | 50 % del recorrido a TP | V1 |
| Rango del OB | high-low con mechas | V1 |
| Invalidación | por cierre de cuerpo | V3 |
| Sesgo / BOS | por cierre de cuerpo sobre swing | V1 |

**Provisionales 🔴 (calibrables SOLO dentro de `DATASET-PROTOCOL.md`: en calibración, validados en
held-out; jamás a ojo sobre todo el histórico):**
| Parámetro | Default 🔴 |
|---|---|
| `swingLookback` | 10 |
| gate de fuerza (`impulso.range / OB.range`) | ≥ 1.5 |
| `slBuffer` | 0.05–0.10 % |
| `maxPois` por dirección | 3 |
| `maxWaitConfirmBars` (LTF) | 10–20 velas |
| `cancelDistance` | 1× rango del OB |
| TP R-fijo (modo) | 2R |
| filtro volatilidad | ATR(14) > su mediana de N velas |

**Libres del backtest (los 3 ejes — ver §6).**

## 6. Diseño del backtest

**Ejes libres = SOLO 3** (todo lo demás fijado por lógica, para no sobreajustar):
1. **Gatillo:** A | B | C
2. **TF del gatillo (refinamiento):** 1H | 15m | 5m
3. **TP:** R-fijo (2R) | liquidez opuesta / nivel estructural

→ **3 × 3 × 2 = 18 variantes.** (Cada perilla extra multiplica el riesgo de overfitting; el v1 murió
de eso.)

**Métricas (no solo PF):** expectancy en **R** (neta), winrate, **fill-rate** (% de señales que
activan — el trade-off central de V2), profit factor, max drawdown, **nº de trades (muestra)**,
distribución de R.

**Costes realistas (obligatorio):** fees taker Binance/Bitget futures (~0.04–0.05 % por lado) +
slippage conservador (1–2 ticks). Si solo es rentable con costes cero, **no es rentable**.

**Validación anti-overfitting** (`DATASET-PROTOCOL.md`): split temporal calibración / held-out /
**out-of-time**; **walk-forward**; cuarentena de datos recientes.

## 7. Criterio de Autonomía (PRE-REGISTRADO)

Se fija **antes** de mirar resultados. Una variante solo es candidata a autonomía si cumple **todos**
los umbrales en **out-of-sample / out-of-time** (no in-sample):

| # | Criterio | Umbral propuesto 🔴 |
|---|---|---|
| 1 | Muestra | **N ≥ 100** trades OOS (ideal ≥ 200) |
| 2 | Expectancy neta | **≥ +0.20 R / trade** (después de costes) |
| 3 | Profit factor | **≥ 1.3** |
| 4 | Max drawdown | **≤ 25 % de la cuenta** (con riesgo 0.5–1 %/trade) — **ajustar a tu estómago** |
| 5 | Estabilidad | **≥ 70 %** de las ventanas walk-forward rentables |
| 6 | Degradación IS→OOS | expectancy OOS **≥ 50 %** de la in-sample |
| 7 | Forward-test papel | **≥ 1–3 meses** en vivo (sin dinero real) consistente, antes de cualquier euro real |
| 8 | Costes | resultados con fees + slippage realistas incluidos |

> El umbral #4 (drawdown) lo decides tú: es tu capital y tu tolerancia. El resto son mínimos de
> rigor estadístico. Si **ninguna** variante los cumple, ese es un resultado **válido** que nos
> ahorra perder dinero — no un fracaso.

## 8. Plan de fases

- **A.** Esta especificación + criterio de autonomía. *(este documento)* ✅
- **B.** Detectores: invalidación **por cuerpo**, detector **sweep/reclaim**, gatillo **confirmación LTF**.
- **C.** Motor de backtest (reescrito desde `legacy/`, causal, simula límite/SL/TP/BE/cancelación + costes).
- **D.** Correr las 18 variantes in-sample → medir.
- **E.** Validar las mejores out-of-sample / walk-forward.
- **F.** Decisión de autonomía con la curva out-of-time delante.

## 9. Honestidad / qué esperar

- El **modo A (riesgo)** probablemente pierda — es el control del experimento.
- La apuesta es **C (sweep/reclaim)** para cripto.
- La rentabilidad real depende de la **ejecución** (slippage, fills, latencia) que el backtest
  aproxima, no replica → de ahí el forward-test en papel (criterio #7).
- Un backtest que "no da" es **información**, no fracaso. El peor resultado posible sería un backtest
  bonito por sobreajuste que vuelva a perder en vivo (la trampa del v1).

## 10. Glosario rápido
- **OB:** Order Block. **FVG:** Fair Value Gap / imbalance. **BOS:** Break of Structure.
- **CE:** Consequent Encroachment = 50 % del rango (equilibrium).
- **Sweep:** barrido de liquidez (mecha que toma stops). **Reclaim:** el cuerpo cierra de vuelta dentro.
- **POI:** Point of Interest. **Breaker:** OB roto (función invertida; solo estudio en cripto).
- **R:** múltiplo de riesgo (1R = distancia entrada→SL). **OOS:** out-of-sample.
