# Paper-Test Spec — Forward-test en papel (criterio de autonomía #7)

> **Estado:** 🔴 DISEÑO para aprobación. Nada construido aún. Última actualización: 2026-06-08.
> Fuente del candidato y los criterios: `SMC-STRATEGY-MECHANICAL.md` §7 y §8.

## 0. Propósito y relación con la Regla Cero

El backtest histórico **aproxima** fills, slippage y latencia; no los replica. El criterio de autonomía
pre-registrado (#7) exige un **forward-test en papel de 1–3 meses en vivo** antes de considerar dinero
real. Este documento diseña ese paper-test.

**SHADOW READ-ONLY — dentro de la Regla Cero:** el paper-trader lee mercado en vivo, **registra lo que
el candidato HARÍA** (entrada/SL/TP candidatas y su desenlace simulado contra las velas que van
cerrando), y **NO coloca, modifica ni cancela ninguna orden.** Es la misma naturaleza que `bot-analysis`
(lectura read-only), extendida a "seguir la estrategia mecánica en tiempo real". 

**Salvaguarda estructural:** el módulo de paper-trading **no importa ni usa** los métodos de escritura
del exchange (`placeOrder`, `cancelOrder`, `placeStopLoss`, …). Solo consume velas
(`CandleRepository` / stream de market-data). Un test de invarianza verificará que **ningún code path**
del módulo referencia el write-API. El salto a ejecución real sería una decisión FUTURA y separada, con
su propia revisión de seguridad (kill-switch, límites, IP whitelist) — fuera del alcance de este doc.

## 1. El candidato bajo prueba (CONGELADO)

Se prueba EXACTAMENTE el candidato validado en backtest, **sin re-tunear** durante el forward-test
(tunear mirando resultados live invalidaría la prueba — es la trampa del v1):

| Parámetro | Valor |
|---|---|
| Timeframe gatillo | 15m |
| Gatillo | C (sweep + reclaim) |
| TP | 2R fijo |
| `cancelDist` | 3× rango de la zona |
| `swingLookback` | 10 |
| Break-even | 50 % del recorrido a TP |
| `minStopPct` (fee-aware) | 0.3 % |
| Fees | maker 0.02 % / taker 0.05 % |
| Sesgo HTF | 4H (BOS por cuerpo); LONG solo si 4H alcista, SHORT si bajista |
| Símbolos | **10 (anexo PRE-arranque 2026-06-12):** BTC, ETH, XRP, SOL, BNB + **DOGE, ADA, LINK, AVAX, DOT** — los 5 nuevos pasaron el barrido OOS fresco con el candidato congelado (+105R/N=1.137, 4/5 no-negativos) y duplican la frecuencia (~19-20 trades/mes → N≥50 en ~2,5-3 meses). Anexado ANTES de encender el reloj, no a mitad. El veredicto se segmenta por símbolo |

## 2. Arquitectura (reutiliza el motor de backtest)

Módulo nuevo `src/paper-trading/`, gated por `DB_ENABLED` + requiere `MARKET_DATA_LIVE=true` (ingest
de velas 15m + 4h de los 3 símbolos). Reutiliza **sin cambios** `signal-source`, `htf-bias` y la lógica
del `trade-simulator`.

**Driver live** — en cada vela **15m CERRADA** (evento del ingest de market-data, ya existente):
1. Recalcula el sesgo HTF 4H desde las velas 4H cerradas (causal: último cierre 4H ≤ ahora).
2. Corre `generateIntents` sobre la ventana reciente de velas 15m (+ sesgo) y detecta si hay un intent
   **nuevo** cuya `signalBarTime` == la vela recién cerrada → registra una *paper-position* PENDIENTE.
   Dedup por id de intent (nunca re-emite uno viejo).
3. Actualiza cada paper-position abierta con la nueva vela: ¿llenó el límite? ¿tocó SL/TP/BE? ¿se
   canceló (alejamiento / maxWaitFill)? — con la **misma** lógica del simulador.
4. Persiste los cambios.

**Causalidad:** garantizada por construcción — los datos futuros aún no existen. La señal se conoce al
cierre; la "ejecución" (paper) se evalúa en velas posteriores. Idéntico contrato que el backtest.

**Nota de implementación (P.1):** `simulateTrade` es "todo de una"; para vivo se extrae un *tracker
incremental* (estado PENDING→FILLED→CLOSED) derivado de su misma lógica, validado contra el resultado
all-at-once con los mismos tests (deben coincidir). No se toca el simulador del backtest.

## 3. Persistencia

Entidad `paper_trades` (migración explícita, `synchronize:false`): `id`, `symbol`, `direction`,
`entry`, `stopLoss`, `takeProfit`, `signalTime`, `state` (PENDING/FILLED/CANCELLED/CLOSED), `fillTime`,
`fillPrice`, `exitTime`, `exitPrice`, `exitReason`, `rMultiple`, `cancelReason`, `createdAt`, `updatedAt`.
Sobrevive reinicios; permite review y export. Idempotente por `(symbol, signalTime, direction)`.

## 4. Criterios de éxito (re-pre-registrados 2026-06-10 — NO se cambian a mitad)

> **Por qué se re-registraron (revisión independiente):** la versión anterior ("1–3 meses; expectancy
> live ≥50 % de la histórica") era estadísticamente inservible — con la tasa real de señales (~15
> trades/trimestre con 3 símbolos) el error estándar es ≈0.28R: un edge real puede salir negativo y un
> edge nulo positivo. El gate se define **por N acumulado, no por calendario**, y su criterio primario
> es de *ingeniería* (lo que el paper SÍ puede medir), no de significancia que no puede alcanzar.

- **Duración: hasta acumular N ≥ 50 trades cerrados** entre los 5 símbolos (estimado ~5-6 meses;
  mínimo 2 meses aunque N llegue antes). El reloj se pausa si el ingest se cae (los datos persisten).
- **Criterio PRIMARIO — paridad mecánica sim↔live (automatizable):** re-correr el backtest offline
  sobre las velas persistidas del período debe reproducir **1:1** los `paper_trades` (mismas señales,
  fills, salidas, R). Cualquier divergencia = bug del cableado live → se investiga, se corrige y se
  anota; la paridad sostenida es la validación de que "lo que el bot haría" está bien medido.
- **Criterio SECUNDARIO — no-colapso del edge:** al llegar a N≥50, el pooled live debe ser
  **> −0.10R**. Si es peor → el edge no sobrevive al vivo → NO autonomía (resultado válido). La
  *confirmación* positiva del edge (+0.13R del backtest OOS) exigirá más N; el paper puede extenderse
  por decisión explícita, nunca acortarse por impaciencia.
- **Instrumentación touched-vs-crossed (obligatoria):** por cada fill de entrada y de TP se registra si
  el precio **cruzó** el nivel o solo lo **tocó** (granularidad de la vela). Al cierre del gate se
  recalcula la expectancy bajo la regla estricta (solo cruces) → acota el sesgo optimista del fill por
  toque que el simulador asume y que el paper, al evaluar sobre velas, hereda.
- **Veredicto:** paridad OK + no-colapso → se abre la discusión del siguiente paso (más N en paper o
  diseño de la revisión de seguridad para ejecución real). Paridad rota o colapso → se documenta y NO
  se avanza. **Ambos desenlaces son válidos**; el segundo nos ahorra perder dinero (doc §9).
- **Integridad (clave):** el registro mecánico (`paper_trades`) incluye TODA señal que el candidato
  congelado genera, **automáticamente, SIN filtro humano**. La lectura discrecional del usuario ("yo la
  tomaría / la saltaría") se anota APARTE (journal): dato valioso para aprender y para una posible capa
  discrecional futura, pero **NO altera la expectancy mecánica** — si no, sería cherry-picking en vivo
  (la auto-decepción del v1 en otra forma). Observar y anotar libre; el veredicto sigue honesto.

## 5. Observabilidad — el dashboard (CLARIDAD TOTAL, requisito del usuario)

No es un test de caja negra: el usuario debe **VER en todo momento qué hace el bot**, en el mismo
dashboard (frontend + TradingView Lightweight Charts ya existente), para comprobar fácil y eficazmente si
somos rentables — sin esperar 3 meses confiando a ciegas. Dos capas sobre la gráfica:

- **Capa de ANÁLISIS (qué VE el bot)** — zonas SMC: OB, FVG, liquidez, sweeps, sesgo HTF 4H vigente. Ya
  construida en gran parte (`/api/bot/*` + cockpit). Es DETERMINISTA y causal desde las velas guardadas →
  el dashboard la **RE-DERIVA a demanda** para cualquier momento (sin snapshots = sin bloat; se guardan
  velas + paper-trades + notas, y se reconstruye el resto).
- **Capa PAPER (qué HARÍA el bot)** — NUEVA: cada señal disparada del candidato dibujada como posición
  (entry/SL/TP marcados, R:R) con su estado en vivo (PENDIENTE→LLENADA→GANADA/PERDIDA/BE) y el **PORQUÉ
  causal** (qué swing barrió, el reclaim, la dirección del sesgo 4H en ese instante). Panel de señales /
  posiciones abiertas + **historial detallado** de cada trade cerrado con su R.

**Tiempo real:** los eventos paper (señal nueva, fill, cierre) se empujan por el WS existente (`/ws`) → la
gráfica se actualiza sola. **Journal:** el usuario anota su propia lectura por señal (de acuerdo / en
desacuerdo / notas), SEPARADO del registro mecánico (ver §4 integridad).

Esta capa **es el producto copiloto** en sí (VISION-V2: el bot da su lectura, tú la comparas) — útil
AUNQUE este candidato falle el paper-test.

## 6. Necesidad operativa

El bot opera **INTERNAMENTE en el servidor** (24/7, `MARKET_DATA_LIVE=true`, ingest de 15m+4h de los 3
símbolos + Postgres); el dashboard/frontend es la ventana de análisis. El servidor hoy corre el **v1
(canary)** → desplegar v2 ahí exige cuidado: **coexistir** (puerto distinto) o **cortar** a v2 *con
backups* (DB/.env) + checklist `SAFETY-V2.md` (credenciales read-only, IP whitelist). Decisión a tomar
antes de P.4; NO se toca el v1 sin visto bueno. Si el bot se cae (como la DB hoy), el reloj se **pausa**,
no se invalida (datos persisten).

## 7. Plan de build (slices, cada uno validado y aprobado)

- **P.1 — núcleo PURO (offline):** `PaperEngine` incremental (vela a vela, derivado del simulador, sin
  red/DB) que reproduce EXACTO el backtest + test de invarianza Regla Cero (ningún archivo del módulo
  referencia el write-API). El punto de partida. ✅
- **V — VISOR DE BACKTESTS (antes de P.2; decisión 2026-06-10):** corrida registrada del candidato
  (comando + paramsHash, reproducible) + replay visual causal sobre la gráfica (`PRODUCT-VISION.md`
  §3.3) para que el usuario audite la mecanización trade a trade ANTES de comprometer meses de paper.
  La capa visual de posiciones (entry/SL/TP/estado) se reutiliza después en P.3.
- **P.2 — persistencia + cableado live ✅ (2026-06-12):** módulo `src/paper-trading/` completo:
  entidad `paper_trades` (migración; PK intentId + único `(symbol, signalBarTime, direction)`) ·
  `PaperTradingService` con **la DB como cola ordenada y cursor por símbolo** (el tick del WS solo
  despierta; los huecos reconciliados por REST nunca se pierden) · candidato CONGELADO en
  `frozen-candidate.ts` con paramsHash == corridas canónicas (trazabilidad sim↔live) · bias 4H
  causal refrescado al cierre 4h · **rehidratación = el mismo dren** (ventana ampliada hasta la señal
  viva más vieja; upsert idempotente absorbe lo ya registrado; sin eventos del pasado) · ventana
  segura del engine (3.000 velas; nunca recorta velas que una posición viva necesita) ·
  **touched-vs-crossed** persistido como penetraciones (`entryPenetration`/`tpPenetration`) ·
  gateway WS `/paper` (`paper.position`) · `GET /api/paper/status|trades` · flag `PAPER_TRADING`
  (default false). **Condiciones cumplidas:** test jest de equivalencia ventanada + recorte seguro;
  `verify-equivalence` (CLI read-only) compara el engine ventaneado vela a vela contra el backtest
  full-history sobre años reales — el chequeo de PARIDAD del gate, re-ejecutable en cualquier momento.
- **P.3 — dashboard de observabilidad ✅ (2026-06-12):** pestaña **Paper** en el frontend
  (Cockpit | Backtests | Paper). REUSA la capa visual auditada del visor: **estadísticas EN VIVO**
  (RunStats modo paper: ¿vamos rentables? + por símbolo/dirección/año + equity clickeable) ·
  historial completo filtrable (vivas/cerradas/canceladas × símbolo) · clic en una posición →
  **la gráfica** (ReplayChart con cursor = presente: niveles entry/SL/TP, zona del sweep, contexto
  SMC OBs+liquidez vía `GET /api/paper/context`) · panel del porqué causal + **touched-vs-crossed
  visible** (penetraciones del fill/TP) + trazabilidad (paramsHash/engine por trade) · **tiempo real**
  por WS `/paper` (`paper.position` actualiza lista/stats/gráfica al cierre de cada vela) · barra de
  estado por símbolo (vivas + cursor). El journal discrecional del usuario (§4) queda para una
  iteración posterior — el registro mecánico ya es completo e inviolable.
- **Separación histórico vs forward-test ✅ (2026-06-13):** al arrancar, el motor REHIDRATA (replay
  de la ventana reciente para reconstruir su estado) → esas señales son `phase='backfill'` (CONTEXTO,
  no cuentan). `PAPER_CLOCK_START` (env) marca el arranque oficial: señales posteriores = `phase='live'`
  (el forward-test real). Las estadísticas usan SOLO `live`; el dashboard nunca mezcla. **El deploy DEBE
  fijar `PAPER_CLOCK_START`** al momento de encender — ese es "anotar la fecha de arranque del reloj".
- **P.4 — deploy + arranque:** v2 en el servidor (coexistencia/cutover con backups) + reloj de 1–3 meses.

> P.1–P.3 son offline/read-only (Regla Cero estructuralmente intacta). P.4 es la decisión operativa.
