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
  la zona, no la invalida.* **Estado (Fase B.1):** `computeState` YA invalida por cuerpo (el `close`
  debe cruzar el distal); el ajuste real fue en el frontend — un `mitigated` (mecha al distal pero
  cuerpo DENTRO = sweep) ya **no** cuenta como Breaker; **solo `invalidated`** lo es (`isBrokenOb`).

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
- **B.** Detectores: **B.1 ✅** (la invalidación por cuerpo ya estaba en `computeState`; el fix fue `isBrokenOb`: un `mitigated`=sweep ya **no** es Breaker, solo `invalidated`) → **B.2** detector sweep/reclaim → **B.3** gatillo confirmación LTF.
- **C.** Motor de backtest (reescrito limpio desde `legacy/`, en R, causal) ✅. Módulo `src/backtest/`:
  **C.1** simulador (`trade-simulator.ts`) + métricas (`metrics.ts`) — fill de límite, SL/TP, BE,
  cancelación, costes, todo normalizado por riesgo. **C.2** `signal-source.ts` — los 3 gatillos
  (A/B/C) single-TF desde los detectores, TP fixedR | liquidez (causal). **C.3** `runner` + CLI
  (`npm run backtest`, lee la DB read-only). 30 tests.
- **D.** Correr las variantes in-sample → medir ✅ (rejilla 24 celdas: A/B/C × fixedR/liquidez ×
  4h/1h/15m/5m, sobre el dataset grande).
- **E.** Validar las mejores out-of-sample / walk-forward ✅ (`walkforward.ts` + CLI `--wf`; calibración
  vs held-out con disciplina `DATASET-PROTOCOL`).
- **F.** Decisión de autonomía. **Prueba de robustez ✅ → el candidato NO generaliza (overfit a BTC-15m;
  ver abajo). NO pasa a paper-test ni a autonomía.** Decisión: revisar la mecanización (sesgo HTF) o
  aceptar no-edge. La curva bonita de BTC-15m era la trampa del v1, atrapada a tiempo.

### Backfill + filtro fee-aware (CLI `npm run backfill`)
- `src/backtest/backfill.ts`: trae velas públicas de Binance futures (read-only, Regla Cero) con
  paginación causal y pausa por rate-limit. Dataset BTCUSDT: **4h 9.7k (2022) · 1h 30k (2023) ·
  15m 85k (2024) · 5m 150k (2025)**.
- **Filtro fee-aware** (`minStopPct`, default CLI 0.3 %) + **fees maker/taker** (entrada límite maker,
  salida TP maker / SL-BE taker). Saltar stops micro donde el fee domina.

### Hallazgos 2ª corrida (2026-06-07, dataset grande + filtro) — 🔴 prometedor pero N aún bajo
> 1. **El filtro fee-aware FUNCIONÓ.** 15m C fixedR pasó de **−3.94R (maxDD 98R)** a **+0.31R (PF 2.99,
>    maxDD 2.33R, N=37)** — quitó justo los micro-trades dominados por el fee. Validación clara.
> 2. **Mejor candidato: 15m C fixedR** (sweep+reclaim, TP 2R): exp +0.31R, WR 48.6 %, PF 2.99, DD bajo.
>    **Vistazo OOS:** IS 2024–25/09 (N=27) +0.298R PF 3.36 · OOS 25/09–26/06 (N=10) **+0.338R PF 2.45**
>    → **no se cae out-of-sample** (buena señal), pero N es ridículo para concluir.
> 3. **La hipótesis C≥B>A se cumple solo en 15m** (en 1h/4h, C fixedR es negativo). Mode A (control)
>    sale ≈0/negativo como se predijo. **Liquidez como TP casi siempre peor que 2R fijo** (targets
>    lejanos, DD 22–43R, WR bajo) salvo 15m C.
> 4. **Cuello de botella = MUESTRA.** Pese a años de datos, N máx 50 (candidato N=37): `swingLookback
>    10` + `cancelBeyond` + fill ~25 % dan ~15 trades/año. Para N≥100 hace falta **walk-forward sobre
>    todo el histórico** y/o revisar esos parámetros (calibración disciplinada, no a ojo). El perfil es
>    **BE-pesado** (la mayoría raspa break-even) → revisar si el BE al 50 % corta ganadores.
> 5. **Conclusión honesta:** hay un **candidato con pulso** (15m C, sobrevive un OOS naíf) pero **NADA
>    pasa aún el criterio de autonomía** (§7: N≥100, walk-forward, etc.). Es progreso real, no veredicto.

> ⚠️ **CORRECCIÓN DE DATASET (revisión independiente, 2026-06-10).** Todas las corridas desde la
> Fase E hasta el HTF estricto (incluidas) se ejecutaron con el `--limit` por defecto del CLI
> (100 000) → usaron las **últimas 100k velas 15m (2023-08→2026-06)**, NO 2022–2026. La frase
> "incluye el bear de 2022" era incorrecta. Los números siguen siendo válidos *para ese subconjunto*
> (se reprodujeron exactos) y las conclusiones **relativas** (C>B>A, el HTF ayuda, el HTF estricto no)
> se sostienen; los números con el **histórico completo** están en la sección «Revisión independiente»
> de abajo — el candidato MEJORA con 2022 incluido. Regla desde hoy: toda corrida documentada registra
> su **comando completo** (con `--limit/--from/--to` explícitos).

### Hallazgos Fase E (2026-06-07, walk-forward + N con disciplina) — candidato VALIDADO en histórico
**Candidato definido:** `15m · gatillo C (sweep+reclaim) · TP 2R fijo · cancelDist 3 · swingLookback 10 ·
BE 50% · minStopPct 0.3% · fees maker/taker`. El único parámetro movido del default fue `cancelDist`
(1→3), **elegido SOBRE CALIBRACIÓN** (hasta 2025-06; barrido `swingLookback × cancelDist`: `cancelDist`
es la palanca de N, ~triplica fills sin matar expectancy) y **validado en held-out intocado**.
> - **Held-out** (2025-06→2026-06, N=21): **+0.376R**, WR 52.4 %, PF 3.25 → mejor que calibración (+0.224R).
> - **Walk-forward 2022–2026, 12 ventanas (15m extendido a 155k velas, incluye el bear de 2022):**
>   **N=108 · pooled +0.231R · 9/11 ventanas rentables (81.8 %) · mediana +0.276R · peor −0.776R.**
> - **El BE al 50% es el MECANISMO del edge, no un lastre:** desactivarlo derrumba +0.231R→+0.085R y baja
>   a 63.6 % de ventanas. Corta perdedores a ~0R y deja correr los pocos TP a +2R. (Valida la Capa 5.)
> - **Criterios de autonomía (§7) que YA cruza (in-sample/walk-forward):** #1 N≥100 (108) · #2 ≥+0.20R
>   (+0.231) · #4 maxDD (2–5R/ventana ≈ poco con riesgo 0.5–1 %) · #5 ≥70 % ventanas (81.8) · #6 OOS≥50 %
>   de IS (168 %) · #8 costes incluidos. **Falta SOLO #7: forward-test en papel 1–3 meses (no atajable).**
> - **Banderas amarillas (seguir críticos):** edge fino y BE-dependiente; N por ventana aún chico (3–21);
>   el trimestre más reciente fue negativo; un solo símbolo/TF; el sim aproxima fills/slippage (de ahí #7).
> - **Veredicto (provisional):** el pre-registro dice **pasar a forward-test en papel**, NO a dinero real.

### Fase F — prueba de robustez: el candidato NO generaliza → OVERFIT (2026-06-07)
**Antes de comprometer 1–3 meses de paper-test, robustez barata (decisión del usuario). El resultado
mata el candidato — y eso es un ÉXITO de disciplina, no un fracaso.**
> - **Slippage: robusto** ✓ — el edge aguanta hasta $20/lado (+0.246R → +0.162R). No es el problema.
> - **TF: el edge es SOLO de 15m** — el mismo gatillo en BTC 5m/1h/4h **pierde** (−0.20 / −0.17 / −0.09R).
> - **Símbolo: NO generaliza** — **ETH 15m (mismos params, N=211): −0.043R, PF 0.91, 5/12 ventanas (42%).**
> - **Diagnóstico:** BTC-15m es un **positivo aislado** rodeado de break-even/negativo. Un edge real deja
>   rastro en TFs/símbolos vecinos; este no. Es la **firma del overfit**, no del edge. El pase de
>   walk-forward en BTC-15m (4 años, incl. bear) era convincente y **aun así engañoso** — justo la trampa
>   del v1 (PF 7.37 in-sample → −68 % en vivo), atrapada esta vez ANTES de arriesgar tiempo o dinero.
> - **Conclusión:** esta mecanización (sweep+reclaim single-TF, estos params) **NO tiene edge robusto.**
>   NO pasa a paper-test. Es un resultado VÁLIDO (doc §9: "un backtest que no da es información"). Opciones:
>   (a) aceptar no-edge; (b) revisar la mecanización — el sospechoso #1 es que el gatillo C single-TF es
>   demasiado ingenuo: le falta el **sesgo HTF vinculante** (el multi-TF que diferimos) que filtre los
>   sweeps contra-tendencia; (c) barrer más símbolos para confirmar el patrón. NO seguir tuneando BTC-15m.

### Revisión con sesgo HTF (`htf-bias.ts` + CLI `--htf`) — mejora real, NO suficiente (2026-06-07)
Implementado el multi-TF de la Capa 1: el gatillo C solo dispara **a favor de la estructura HTF** (BOS
por cuerpo en 4H). El sesgo se conoce al cierre HTF ≤ señal (causal). Resultado con `--htf 4h`:
> - **BTC 15m:** +0.246R → **+0.279R** (PF 2.01, walk-forward 72.7 % ventanas, N=54). Mejora.
> - **ETH 15m:** −0.043R → **+0.045R** (PF 1.09, walk-forward 41.7 % ventanas, mediana −0.038R). **Dejó de
>   perder pero quedó en break-even**, no robusto.
> - **Veredicto:** el sesgo HTF era la intuición correcta (ayudó a AMBOS → los sweeps contra-tendencia
>   arrastraban), pero **NO genera un edge robusto multi-símbolo**: BTC fuerte, ETH marginal. No alcanza
>   para autonomía (ETH falla #2 y #5). El edge real, si existe, es **débil y centrado en BTC**.
> - **Opciones abiertas:** (a) sesgo HTF más estricto (1D, o 4H+1D alineados) a ver si afila ETH;
>   (b) más símbolos (SOL…) para ver si el rango +0.045…+0.28R agrupa positivo (edge débil real) o
>   straddlea cero (no-edge); (c) aceptar "edge débil BTC-céntrico" y hacer un paper-test SOLO en BTC-15m,
>   con los ojos abiertos; (d) mecanizar otra capa SMC (premium/discount, inducement). Sigue sin pasar a real.

### Barrido multi-símbolo (5 símbolos, candidato fijo + `--htf 4h`) — el edge GENERALIZA, débil (2026-06-08)
Para distinguir "edge débil real" de "BTC con suerte": el MISMO candidato (sin re-tunear) en 5 símbolos
diversos, walk-forward 12 ventanas, 2022-2026 (15m a 155k velas c/u; 4h para el sesgo).
| símbolo | expR pooled | % ventanas | N | mediana ventana |
|---|---|---|---|---|
| BTC | **+0.249** | 72.7 % | 54 | +0.182 |
| XRP | **+0.194** | 58.3 % | 103 | +0.201 |
| SOL | **+0.146** | 66.7 % | 118 | +0.094 |
| BNB | +0.046 | 50.0 % | 59 | +0.000 |
| ETH | +0.045 | 41.7 % | 103 | −0.038 |
> - **5/5 pooled-POSITIVO** → inclina a *edge débil REAL*, no a "BTC con suerte" (que daría signos mezclados).
> - Pero **débil y desigual:** solo BTC/XRP/SOL robustos (mediana + y % decente); ETH/BNB en break-even.
> - **Caveat:** los majors cripto están CORRELACIONADOS → no son 5 pruebas independientes sino 5 vistas
>   del mismo régimen; evidencia más floja que mercados no correlacionados (forex/índices, no disponibles).
>   *Mitiga:* ETH (muy correlado a BTC) rinde 5× menos → hay microestructura por símbolo, no solo régimen.
> - **Veredicto:** el candidato pasó la última verificación histórica barata (generaliza, débilmente). Ha
>   GANADO el forward-test en PAPEL (#7) sobre el subconjunto fuerte (BTC/XRP/SOL), con los ojos abiertos a
>   que el edge es modesto. Alternativa: intentar FORTALECERLO antes (HTF 1D, premium/discount). NO a real.

### Fortalecimiento con HTF estricto — NO ayuda; 4H es el punto óptimo (2026-06-08)
`alignBias` + CLI `--htf2` (exige unanimidad de dos TFs). Probado en los 5 símbolos vs base 4H
(pooled / % ventanas / N):
| | 4H (base) | 1D solo | 4H+1D alineado |
|---|---|---|---|
| BTC | +0.249 / 73 % / 54 | +0.278 / 64 % / 56 | +0.203 / 56 % / 41 |
| ETH | +0.045 / 42 % / 103 | **−0.064** / 33 % / 126 | +0.020 / 42 % / 77 |
| SOL | +0.146 / 67 % / 118 | +0.094 / 58 % / 133 | +0.138 / 67 % / 71 |
| BNB | +0.046 / 50 % / 59 | +0.063 / 42 % / 71 | +0.011 / 42 % / 46 |
| XRP | +0.194 / 58 % / 103 | +0.123 / 50 % / 118 | +0.121 / 50 % / 72 |
> - **El HTF más estricto NO afila el edge** — igual o peor. 1D solo mete a ETH en negativo; 4H+1D recorta
>   N sin subir calidad. **El 4H ya era el óptimo del lever HTF.**
> - **Disciplina:** el 1D sube *marginalmente BTC* (+0.278) pero empeora los otros 4. Quedarse con 1D "porque
>   BTC mejora" sería **cherry-picking** = overfit. Se mantiene 4H (mejor para el conjunto).
> - **Conclusión:** el lever HTF está agotado. Quedan: (a) aceptar el edge 4H (débil/real) → paper-test;
>   (b) mecanizar una capa NUEVA (premium/discount, inducement) = dimensión de señal distinta, no re-tuning.

### Revisión independiente (2026-06-10) — re-validación con el histórico COMPLETO 2022-2026
Revisión externa (modelo nuevo, mandato `REVIEW-BRIEF.md`): causalidad del motor verificada en código
(sin lookahead en bias 4H/sweeps/OBs), 142/142 tests, corridas reproducidas. Hallazgo mayor = la
corrección de dataset del banner de arriba. Re-corridas con `--limit 200000` (155k velas, 2022-26),
candidato congelado + `--htf 4h`, walk-forward 12 ventanas:

| símbolo | pooled | % ventanas | N | (doc con 100k velas) |
|---|---|---|---|---|
| BTC | **+0.330R** | 83.3 % | 112 | +0.249 / 72.7 % / 54 |
| XRP | +0.163R | 66.7 % | 175 | +0.194 / 58.3 % / 103 |
| SOL | +0.131R | 66.7 % | 244 | +0.146 / 66.7 % / 118 |
| BNB | +0.089R | 66.7 % | 100 | +0.046 / 50.0 % / 59 |
| ETH | +0.013R | 66.7 % | 191 | +0.045 / 41.7 % / 103 |

> - **5/5 sigue pooled-positivo con N=822.** Embudo BTC: 159 señales → 112 trades (fill 70.4 %),
>   TP 36 · SL 27 · BE 49, PF 2.18, maxDD 3.96R. La evidencia OOS limpia (símbolos congelados
>   post-decisión: XRP/SOL/BNB) promedia **+0.134R (N=519)** — esa es la expectativa honesta, no el
>   +0.33 de BTC (in-sample del proceso de selección).
> - **Vecindad de parámetros = MESETA (anti-overfit):** cancelDist 2/3/4 → +0.468/+0.330/+0.325 ·
>   swing 8/10/12 → +0.276/+0.330/+0.183. Todos positivos; el candidato no es un pico aislado.
> - **CORRECCIÓN: "el BE al 50 % ES el mecanismo" es FALSO.** BE on/off: full+HTF **+0.330/+0.313**
>   (aporte ~0.02R) · 100k+HTF +0.279/+0.224 · full sin HTF +0.184/+0.109 · 100k sin HTF (la corrida
>   del doc) +0.231/+0.085. El BE era un **sustituto parcial del filtro HTF** (cortaba a ~0 los sweeps
>   contra-tendencia que el HTF ahora elimina). El edge es **direccional**, no un artefacto del stop.
> - **Slippage: el stress en $ fijos estaba mal especificado** ($20 = 0.12 %/lado con BTC a 17k en
>   2022 vs 0.02 % hoy → castiga 6× el pasado; full daría +0.091R por ese artefacto). En franja de
>   precio homogénea 2024-26: **+0.299 → +0.233R** con $20/lado (PF 1.79) = tolerable. Pendiente:
>   flag `--slip-bps` para stress proporcional honesto.
> - **Tasa de señales reciente (2025-06→2026-06), candidato congelado: 5/5 positivo, pooled ≈ +0.20R,
>   ~114 trades/año entre los 5 símbolos (~9.5/mes). BTC casi mudo: 5 trades/año** → el paper-test se
>   dimensiona por N acumulado (no por calendario) y el grueso vendrá de los símbolos no-BTC.
> - **Veredicto: GO al paper-test** con condiciones (gate re-registrado en `PAPER-TEST-SPEC.md`):
>   5 símbolos en shadow, evaluación a N≈50-60, criterio primario = paridad mecánica sim↔live +
>   touched-vs-crossed (el fill al toque del simulador es optimista y el paper lo hereda — hay que
>   instrumentarlo). Antes del paper: **visor de backtests** (replay visual; `PRODUCT-VISION.md` §3.3)
>   para auditar la mecanización trade a trade. Fix aplicado: id de intents C ahora incluye dirección
>   (dos sweeps opuestos en la misma vela ya no colisionan en el dedup del paper).

### Ciclo 2 pre-registrado (2026-06-10) — re-mecanización de la GESTIÓN con la transcripción del V1
La auditoría visual del usuario (vía el visor) + la transcripción cruda del Video 1
(`transcripts/VIDEO-1-TRANSCRIPT.md`) revelaron que la desviación del método NO estaba en los specs
(que eran fieles: "TP en la siguiente liquidez/POI", "BE a mitad del recorrido") sino en el diseño
del backtest de este doc (§6): el eje "TP 2R fijo" ganó contra una mecanización POBRE del
TP-liquidez, y el BE al 50 % quedó atado a ese 2R sintético → **44 % de trades en BE** (hiperactivo,
no fiel). **Pre-registro completo del Ciclo 2 en `CYCLE-2-PREREG.md`:** TP estructural (primer
POI/liquidez opuesto causal) + BE fiel (50 % del recorrido al target real) + pools de liquidez para
el sweep (equal highs/lows + swings vigentes). 4 combinaciones, calibración/held-out intactos,
benchmark = candidato actual, criterio de reemplazo fijado ANTES de correr. El candidato actual
sigue CONGELADO y vigente salvo que el C2 lo supere bajo esos criterios.
**RESULTADO (2026-06-11, `CYCLE-2-PREREG.md` §8): NEGATIVO-INFORMATIVO.** En calibración 5-símbolos
la base ganó por paliza (+89.1R vs −15.1/−39.7/−159.9): el TP estructural era BTC-céntrico (la firma
del overfit) y los pools refutados. **2ª confirmación de que el 2R fijo es el sustituto robusto de la
discrecionalidad del target** (1ª: Fase D). El candidato congelado va al gate #7 tal cual.

### Barrido OOS FRESCO — 5 símbolos jamás mirados (2026-06-12): el edge sobrevive su prueba más dura
A pedido del usuario (más frecuencia + validación), se backfillearon 5 símbolos que JAMÁS influyeron
en ninguna decisión de diseño (DOGE/ADA/LINK/AVAX/DOT, 155k velas 15m + 4h c/u desde 2022) y se corrió
el candidato CONGELADO tal cual (+ `--htf 4h`), single-run registrado + walk-forward 12 ventanas:

| símbolo | pooled | % ventanas | N | totalR |
|---|---|---|---|---|
| DOGE | **+0.191R** | 83.3 % | 220 | +41.9 |
| ADA | +0.149R | 50.0 % | 222 | +33.0 |
| LINK | +0.139R | 66.7 % | 240 | +33.7 |
| AVAX | +0.005R | 33.3 % | 247 | +1.2 |
| DOT | −0.023R | 41.7 % | 208 | −4.8 |

> - **Agregado fresco: +105.0R sobre N=1.137 → pooled +0.092R** (4/5 no-negativos; 3/5 claramente
>   positivos). Es **evidencia 100 % out-of-sample** — ningún parámetro vio nunca estos símbolos —
>   y replica el patrón del universo original (media positiva débil, dispersión por símbolo).
> - **Universo completo: 10 símbolos, N=1.959, ≈ +214R, pooled ≈ +0.109R, 9/10 no-negativos.**
>   La hipótesis "edge débil real" recibió su confirmación más fuerte hasta la fecha.
> - Implicación para el gate #7: con 10 símbolos en shadow la frecuencia ≈ se duplica
>   (~19-20 trades/mes estimado) → N≥50 se alcanza en ~2,5-3 meses. Propuesto ampliar el universo
>   del paper de 5 → 10 símbolos ANTES de encenderlo (anexo pre-arranque, no cambio a mitad).

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
