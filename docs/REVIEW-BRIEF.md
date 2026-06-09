# Review Brief — Revisión independiente del proyecto (antes del paper-trading)

> **Para quién:** un modelo/revisor NUEVO (p.ej. Fable 5) que entra fresco al proyecto. Si estás leyendo
> esto en una sesión nueva: ya tienes `CLAUDE.md` y la memoria auto-cargados; este documento te da el
> **mandato de revisión** y el **orden de lectura**. Última actualización: 2026-06-08.

## 0. Tu rol (léelo primero)

Eres un **revisor independiente y escéptico**. Tu trabajo **NO es validar lo hecho, es PRESIONARLO**:
buscar fallos en la lógica, la metodología y la dirección **antes** de comprometer 1–3 meses de
forward-test en papel. Sé crítico, proactivo y honesto; propón mejoras concretas; señala lo que no
hayamos visto. **Un "esto no tiene edge / esta dirección está mal" es un resultado VALIOSO**, no una
ofensa — la lección rectora del proyecto es que el v1 confió en un backtest bonito (PF 7.37 in-sample)
y perdió **−68 % en vivo**. No repitas esa trampa; ayúdanos a evitarla.

No tomes mis conclusiones (las del modelo anterior, Opus) como dadas. Forma tu propio criterio desde
los **documentos y el código**, que son la fuente de verdad.

## 1. Contexto en 60 segundos

- Bot de trading reescrito en la rama `v2-copilot` como **copiloto SMC** (Smart Money Concepts).
- **Regla Cero (innegociable):** el bot **NO ejecuta** órdenes; lee mercado, detecta zonas, sugiere. El
  usuario opera manual. Nada coloca/modifica/cancela órdenes.
- **Giro:** se sintetizó la estrategia de 3 videos de YouTube en una **mecánica causal backtesteable**
  para medir si tiene edge, hacia una **posible** autonomía futura (con su propia revisión de seguridad).
- **Estado:** se construyó el motor de backtest, se validó un candidato (15m, gatillo "sweep+reclaim"),
  se descartó un overfit, y el edge resultó **débil pero real** (generaliza a 5 símbolos, fuerte en
  BTC/XRP/SOL). Decisión actual: pasar al **paper-test** (forward-test en papel, gate #7). Ya está hecho
  P.1 (núcleo del paper-trader, offline). **Aún NO se ha arriesgado dinero ni se ha desplegado en vivo.**

## 2. Orden de lectura (fuente de verdad = docs + código, NO esta decisión)

1. **`CLAUDE.md`** — estado actual + reglas del proyecto (Regla Cero, stack, módulos). Ya auto-cargado.
2. **`docs/VISION-V2.md`** + **`docs/SAFETY-V2.md`** — filosofía copiloto + seguridad/Regla Cero.
3. **`docs/SMC-STRATEGY-MECHANICAL.md`** ⭐ — **el documento central**: la estrategia mecánica completa,
   los 3 gatillos, los parámetros fijos vs libres, el criterio de autonomía PRE-REGISTRADO (§7), y
   **todos los hallazgos del backtest** (§8: corridas, overfit, sesgo HTF, barrido multi-símbolo). Léelo
   entero y con lupa.
4. **`docs/PAPER-TEST-SPEC.md`** — el diseño del forward-test que estamos por construir.
5. **`docs/DATASET-PROTOCOL.md`** + **`docs/NO-REPAINT-RULES.md`** — la disciplina metodológica
   (anti-overfit, causalidad/lookahead=0). Úsalas como vara de medir.
6. **`docs/SMC-SPEC-VIDEO-1/2/3.md`** + **`docs/ENTRY-EDGE-SPEC.md`** — de dónde salió la estrategia (los
   videos originales). Para juzgar **fidelidad** de la mecanización.
7. **Código:** `src/backtest/` (`signal-source.ts`, `trade-simulator.ts`, `metrics.ts`, `walkforward.ts`,
   `htf-bias.ts`, `backtest.runner.ts`), `src/bot-analysis/` (detectores OB/sweep/liquidez/…),
   `src/paper-trading/` (P.1). Corre: `npm test` (debe dar verde), `npm run backtest -- --grid --tfs 4h,1h,15m`,
   `npm run backtest -- --wf --tf 15m --gatillo C --tp fixedR --cancel-dist 3 --htf 4h --windows 12`.

## 3. Mandato — pressure-test ESTO (y lo que se te ocurra)

### A) Fidelidad de la estrategia a los videos
- ¿La mecanización (gatillo **C = sweep+reclaim**, **OB estructural** swing-first, **sesgo HTF 4H**, BE al
  50 %, TP 2R) es **fiel** a los videos, o se perdió algo discrecional que es donde realmente vive el edge?
- El entry es **single-TF + filtro de sesgo HTF**. El método "real" de los videos es **multi-TF** (POI en
  HTF + gatillo de confirmación en LTF), que se **difirió**. ¿Esa simplificación nos cuesta el edge?

### B) Metodología del backtest (¿nos estamos engañando?)
- **Causalidad / no-repaint:** ¿hay algún lookahead escondido? Mira con cuidado el TP por liquidez, la
  confirmación de swings, y el sesgo HTF (`biasAt` causal).
- **Modelado de ejecución:** el simulador asume que un límite **llena cuando el precio toca** el nivel
  (sin cola de órdenes). ¿Optimista? El SL-primero en empate intrabar, los fees maker/taker, el
  `cancelBeyond`, el filtro `minStopPct` fee-aware: ¿sólidos y conservadores, o hay sesgo a favor?
- **⚠️ Sesgo de selección (importante):** el candidato "15m · C" se eligió como **el mejor de 24
  variantes** (3 gatillos × 2 TP × 4 TFs). Eso es **comparaciones múltiples / data-dredging**. ¿El
  walk-forward + held-out + el barrido cross-símbolo lo mitigan **lo suficiente**, o el edge aparente
  está inflado por haber elegido al ganador?
- **Calibración:** se movió `cancelDist` 1→3 (elegido en calibración, validado en held-out). ¿Disciplina
  correcta o un knob sobreajustado?

### C) El edge en sí (¿es real?)
- Es **DÉBIL** (+0.05 a +0.25R por trade) y los 5 símbolos del barrido están **MUY correlacionados**
  (majors cripto). ¿"5/5 positivo" es evidencia de edge real, o está **sobre-valuada** porque no son 5
  pruebas independientes (mismo régimen)?
- **DEPENDE del break-even:** quitarlo derrumba la expectancy (+0.231R → +0.085R). ¿El "edge" es
  **direccional** (el sweep predice) o es básicamente un **artefacto de gestión de stop** (cortar
  perdedores a 0)? ¿Bandera roja o mecanismo legítimo? Tu opinión importa.
- El **trimestre más reciente** salió negativo y **N por ventana** es chico (3–21). ¿Cuánto peso darle?

### D) El paper-test (gate #7)
- ¿La metodología **shadow read-only** (registrar lo que el candidato haría, sin colocar nada) es válida
  para concluir el criterio #7? ¿La **salvaguarda de integridad** (registro mecánico sin filtro humano +
  journal discrecional aparte) está bien planteada?
- ¿Falta algo para que el forward-test sea **concluyente**? (duración, tamaño de muestra esperado,
  criterios de éxito/fracaso, métricas a registrar, manejo de pausas si el server se cae).

### E) Puntos ciegos / proactividad (lo que NO hemos visto)
- ¿Qué capas SMC **no mecanizamos** que podrían ser el factor que falta? (premium/discount, inducement,
  liquidez interna vs externa, killzones que descartamos por el Video 2). ¿Vale la pena alguna?
- Gestión de riesgo / sizing / y el eventual camino a ejecución real (Regla Cero): ¿algo que prever ya?
- Cualquier mejora, simplificación o riesgo que se te ocurra y no esté contemplado.

## 4. Normas de trabajo (respétalas)

- **Regla Cero es innegociable.** Si vas a tocar algo que coloque/modifique/cancele órdenes,
  posiciones o balances → **detente y pregunta**. (Hay un test de invarianza en `src/paper-trading/`
  que falla si el módulo referencia el write-API; entiéndelo.)
- **Un slice autorizado a la vez:** propones, el usuario aprueba, construyes, validas (build + tests),
  commit limpio, devuelves. No hagas cambios grandes sin acordarlos.
- **No puedes ver la gráfica** — la validación visual la hace el usuario; pídesela cuando aplique.
- **Responde en español.** Veredicto honesto por encima del optimismo.

## 5. Entregable esperado de la revisión

Un informe claro: **(1)** ¿la dirección general es sólida para pasar al paper-test? · **(2)** fallos y
riesgos encontrados, **priorizados** (qué es crítico vs menor) · **(3)** recomendación: ¿pasar al
paper-test ya, **fortalecer** la estrategia antes, o **reconsiderar** el enfoque? · **(4)** mejoras
proactivas concretas. Sé específico y apóyate en el código/los datos, no en impresiones.
