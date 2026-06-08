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

## 5. Necesidad operativa (decisión del usuario)

El forward-test exige el **v2 app corriendo 24/7** con `MARKET_DATA_LIVE=true` (ingest de 15m+4h de los
3 símbolos) + Postgres, durante 1–3 meses. v2 aún no está desplegado (`CLAUDE.md` §Despliegue) → esto
fuerza un **mini-deploy read-only** (backups de DB/.env, credenciales del exchange read-only, IP
whitelist — checklist en `SAFETY-V2.md`). **Dónde corre (máquina del usuario vs server) es una decisión
a tomar antes de P.4.** Si se cae (como pasó hoy con la DB), el reloj del forward-test se pausa, no se
invalida (los datos persisten).

## 6. Plan de build (slices, cada uno validado y aprobado)

- **P.1 — núcleo PURO (offline, testeable):** tracker incremental de paper-position (derivado del
  simulador) + entidad `paper_trades` + `PaperTradingService` que, alimentado con velas, reproduce el
  resultado del backtest. Test de invarianza Regla Cero (no toca write-API). Sin red.
- **P.2 — cableado live:** suscripción al stream de velas cerradas (market-data) + persistencia.
- **P.3 — review:** endpoint/CLI read-only para ver paper-trades + métricas live-forward acumuladas.
- **P.4 — arranque:** mini-deploy + inicio del reloj de 1–3 meses.

> Cada slice se construye, valida (build/tests) y se entrega para revisión, igual que el backtest.
> P.1–P.3 son offline/read-only (Regla Cero triv'mente intacta). P.4 es la decisión operativa.
