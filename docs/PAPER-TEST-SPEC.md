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
| Símbolos | **BTCUSDT, XRPUSDT, SOLUSDT** (el subconjunto fuerte del barrido) |

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

## 4. Criterios de éxito (pre-registrados — NO se cambian a mitad)

Tras 1–3 meses de operación continua:
- **Consistencia IS→live:** la expectancy en R **live-forward** debe mantenerse cerca de la del backtest
  (criterio #6: ≥50 % de la histórica). Si live ≈ backtest → el edge sobrevive a la ejecución real.
- **N y estabilidad:** muestra suficiente acumulada; % de meses/ventanas rentables consistente con el
  walk-forward.
- **Veredicto:** si la curva live-forward acompaña a la del backtest → recién ENTONCES se abre la
  discusión de ejecución real (con su propia revisión de seguridad). Si live **se derrumba** vs backtest
  → el edge era ilusorio (slippage/fills reales lo matan) → NO autonomía. **Ambos desenlaces son
  válidos**; el segundo nos ahorra perder dinero (doc §9).
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
  referencia el write-API). El punto de partida.
- **P.2 — persistencia + cableado live:** entidad `paper_trades` (migración) + suscripción al stream de
  velas cerradas (market-data) + eventos paper por WS. Read-only.
- **P.3 — dashboard de observabilidad:** endpoints `/api/paper/*` + capa frontend (posiciones con
  entry/SL/TP en la gráfica, panel de señales/abiertas, historial, el PORQUÉ causal, journal) + live por WS.
- **P.4 — deploy + arranque:** v2 en el servidor (coexistencia/cutover con backups) + reloj de 1–3 meses.

> P.1–P.3 son offline/read-only (Regla Cero estructuralmente intacta). P.4 es la decisión operativa.
