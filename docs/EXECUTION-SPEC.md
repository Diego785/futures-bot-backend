# EXECUTION-SPEC — capa de ejecución mínima (P.5) · BLUEPRINT 🔴 (a aprobar antes de codear)

> **Estado: DISEÑO. Ninguna orden real hasta que esto esté aprobado, implementado, probado en
> testnet y desplegado con los topes activos.** Este doc es el contrato de seguridad.

## §0 — Por qué existe (contexto)
El candidato congelado lleva ~10 días en paper (shadow). El análisis de **fill-stress** mostró que su
edge depende de fills "de toque" (límites apenas rozadas), y eso **el paper NO lo puede medir** (asume
que el toque llena). La **única** forma de medir si esas límites llenan en la realidad es colocar
órdenes reales. El usuario decidió automatizar la ejecución porque: (a) el barrido es rápido y necesita
una límite **descansando en el CE en el instante exacto** (un humano llega tarde); (b) una estrategia
mecánica se ejecuta más fiel por bot que a mano. Ambas razones son correctas.

**Esto es un TEST DE MEDICIÓN, no un payday.** Expectativa realista: ≈ break-even o sangría lenta de
fees (la lección del v1: edge que no transfiere → gotea centavos, no revienta). El valor es el **dato
de fills reales**. **NO se escala hasta que el fill se pruebe.**

## §1 — Alcance: qué hace y qué NO hace
**Hace:** ejecuta el candidato CONGELADO **idéntico al paper/backtest** (mismos parámetros, misma
lógica) con órdenes reales de tamaño minúsculo, mide el fill real vs el paper, con topes duros.
**NO hace (fuera de alcance, explícito):**
- ❌ NO cambia la estrategia (nada de TP dinámico, parciales, salida por tiempo — eso es Ciclo 4, otro proyecto).
- ❌ NO escala el tamaño automáticamente.
- ❌ NO opera símbolos fuera de los 10 del candidato.
- ❌ NO retira fondos (la key no tiene permiso).
- ❌ NO toma decisiones discrecionales — 100% mecánico, mismas reglas que el simulador.

## §2 — El cambio consciente de Regla Cero
La Regla Cero v2 era **"cero ejecución"**. P.5 la cambia, de forma **consciente, acotada y revisada**, a:
> **"ejecución HABILITADA pero ACOTADA a un test de validación: capital minúsculo, topes duros,
> key sin retiro, kill-switch, y solo el candidato congelado."**
Este es el "paso de autonomía con su propia revisión de seguridad" que siempre fue el gate de la
ejecución. Se habilita SOLO tras: candidato validado en backtest + paper + esta revisión aprobada.

## §3 — PRINCIPIO #1 DE SEGURIDAD: el sizing sale del capital CONFIGURADO, nunca del balance
El usuario usa la **cuenta principal** (no sub-cuenta). Por eso, **regla innegociable:**
- El riesgo por trade se calcula desde **`EXECUTION_TEST_CAPITAL` = $100** (config), **JAMÁS** del
  balance real de la cuenta. Riesgo/trade = `$100 × 0.5% = $0.50`. Si el bot leyera el balance y la
  cuenta tuviera $5.000, arriesgaría 50×. **Prohibido leer el balance para sizing.**
- **Refuerzo del usuario (recomendado fuerte):** fondear la **billetera de Futures con solo ~$120**
  (el test + un colchón). Así el balance de la billetera es el **límite absoluto** ante cualquier bug,
  pase lo que pase en el código. (Spot/otras billeteras quedan aparte; Futures solo ve su saldo.)
- `quantity = risk$ / |entry − SL|`, redondeado al `stepSize` del símbolo. Pérdida en SL = `qty × |entry−SL| = $0.50`. ✓

## §4 — Modelo de ejecución (mapeo simulador → órdenes Binance USDT-M)

> **v2 (Ciclo 4, 2026-07-04):** el candidato congelado ahora es PARTIAL-RUNNER. El lifecycle §4
> se extiende así (implementado; el executor detecta el modo desde `FROZEN_SIM`):
> - Al fill de la entrada se colocan TRES salidas: **SL** `STOP_MARKET closePosition` ·
>   **TP2 (runner)** `TAKE_PROFIT_MARKET closePosition` en el 2R nominal · **TP1 (parcial)**
>   `LIMIT reduceOnly` del 50 % de la qty en entry + 1R (maker, fiel al sim).
> - **Al fill del TP1** (ORDER_TRADE_UPDATE): el SL se re-coloca en **BE+buffer** (anclado al
>   fill, como el sim — ya no al 50 % del camino por vela). `closePosition` cubre lo que quede.
> - Salida final (SL/BE/TP2): se cancela la hermana + el TP1 si quedó resting; la **R es COMBINADA
>   por piernas** (TP1 maker + resto taker, entrada prorrateada) = misma escala que el paper.
> - Si la qty parcial redondea a 0 (posición de 1 step) o el TP1 falla al colocarse → el trade
>   DEGRADA a full-exit (v1) y se loggea — nunca una orden de qty 0, nunca posición sin SL/TP.
> - Reconciliación: re-adopta la pierna TP1 (si no llenó, re-coloca — id determinista = idempotente).
Modo de cuenta: **one-way** (no hedge) · margen **aislado (isolated)** · leverage **5x** (NO cambia el
riesgo —lo fija el SL al 0.5%— solo da margen; el SL cierra MUCHÍSIMO antes de cualquier liquidación).

Ciclo de vida (idéntico a `trade-simulator.ts`), por cada intent `live` que genera el motor:
1. **Señal (cierre de vela 15m):** el motor emite el intent (CE, SL, TP=2R, cancelBeyond). El executor
   **coloca una LÍMITE** (maker) en el CE, `reduceOnly=false`, qty del §3.
2. **Pendiente:** el executor vigila el precio (market WS). Si el precio **cruza `cancelBeyond` sin
   llenar** → **CANCELA la límite** (= el "ranAway"; ni ganaste ni perdiste). (El candidato no usa
   maxWaitFill ni invalidación-por-cuerpo activos, así que el único trigger de cancelación es cancelBeyond.)
3. **Fill (detectado por user-data WS):** al confirmarse el fill, el executor coloca el **bracket**:
   - **SL** = `STOP_MARKET reduceOnly` en el SL (taker al disparar).
   - **TP** = `LIMIT reduceOnly` en el TP 2R (maker).
   - Al llenar UNA de las dos, **cancela la hermana** (el executor gestiona el par; o `closePosition`).
4. **Break-even:** cuando el precio alcanza el **50%** del camino al TP, el executor **modifica el SL**
   (cancela el STOP y coloca uno nuevo en `entrada + buffer` que cubre el coste round-trip). = el BE del sim.
5. **Salida:** TP / SL / BE ejecutan en el exchange. El executor registra el resultado.
6. **Sin salida por tiempo** (el candidato tiene `maxHoldBars=0`): la posición corre hasta TP/SL/BE.

**Diferencia continuo vs 15m (importante y a favor):** el sim evalúa a CIERRE de vela 15m; el exchange
ejecuta **continuo** (intra-vela), que es MÁS fiel a la realidad. El **fill de entrada** (la incógnita)
lo resuelve el mercado real — justo lo que medimos. Esperamos diferencias menores real↔paper; eso ES el dato.

## §5 — Topes DUROS (el arnés) — defaults, configurables
Chequeados ANTES de cada orden; si alguno se viola → NO coloca + alerta:
- **Riesgo/trade:** $0.50 (0.5% de $100). Hard-coded desde el config, no del balance.
- **Máx. posiciones concurrentes:** 3 (riesgo simultáneo máx. ≈ $1.50 = 1.5% si las 3 pegan SL).
- **Máx. nocional por orden:** $400 (techo de cordura — un bug de sizing no puede abrir más).
- **Máx. margen usado total:** $80 (nunca bloquea más, aunque la cuenta tenga más).
- **Máx. pérdida diaria:** −3R (−$1.50) → **kill-switch del día** (no abre nuevas; las abiertas siguen con su SL).
- **Circuit breaker total:** pérdida **NETA** −10R o −20% del capital → **kill-switch TOTAL** (para todo + alerta).
  (Fix 2026-07-27: era BRUTA —sumaba pérdidas sin descontar ganancias— y se habría disparado ~fill 15 del
  camino esperado del candidato aun estando en verde. El freno es de desastre, no de varianza.)
- **Whitelist:** solo los 10 símbolos del candidato.
- **Sanity por orden:** qty>0 y múltiplo de stepSize · precio dentro de ±5% del mercado · SL/TP del lado
  correcto · exits `reduceOnly` · sin orden si el WS de precio está stale.
- **KILL-SWITCH:** `EXECUTION_ENABLED=false` (env) **+** endpoint `POST /api/exec/kill` → cancela TODAS
  las órdenes, (opcional) cierra TODAS las posiciones a mercado, y detiene la ejecución al instante.

## §6 — Reconciliación y resiliencia (donde los bots de ejecución se vuelven peligrosos)
- **Fuente de verdad = el EXCHANGE.** El executor reconcilia su estado contra las órdenes/posiciones
  reales de Binance al arrancar, al reconectar el WS, y periódicamente.
- **Reinicio del bot:** al arrancar, consulta posiciones+órdenes abiertas → re-adopta la gestión
  (SL/TP/BE) de lo que ya esté vivo. Nunca abre duplicados (idempotencia por `clientOrderId` = intentId).
- **Fill parcial:** si la límite llena parcial, el bracket se dimensiona a lo realmente llenado.
- **Desconexión WS / error API:** reintento con backoff; si no se puede operar con seguridad → no abre
  nuevas + alerta. Un estado dudoso NUNCA coloca a ciegas.
- **`clientOrderId` = intentId** del paper → trazabilidad 1:1 paper↔real, anti-duplicado.

## §7 — Credenciales y flags
- Key Binance: **trade SÍ, withdrawal NO, IP-whitelist al VPS `38.242.145.246`**. En el `.env` del server
  (`BINANCE_API_KEY`/`SECRET`), **nunca en código ni en el chat.**
- Flags: `EXECUTION_ENABLED` (default **false**) · `EXECUTION_TESTNET` (default **true**) ·
  `EXECUTION_TEST_CAPITAL=100` · `EXECUTION_RISK_PCT=0.005` · `EXECUTION_MAX_POSITIONS=3` · etc.
- El paper-trading shadow **sigue corriendo en paralelo** (es el espejo para la comparación).

## §8 — Secuencia testnet → real (no se salta)
- **P.5.2 — Adapter + TESTNET.** Adapter de órdenes Binance (place/cancel límite, STOP/TP reduceOnly,
  query posiciones, user-data WS) contra **Binance Futures testnet** (key propia, plata falsa). Tests +
  correr 1 día → verificar que coloca tamaño correcto, pone el SL, hace BE, cancela y reconcilia BIEN.
- **P.5.3 — Cableado + arnés (aún testnet).** Conectar al motor (intent→orden) + todos los topes +
  kill-switch + reconciliación. Probar el camino completo en testnet.
- **P.5.4 — REAL minúsculo.** `EXECUTION_TESTNET=false`, $100, **1-3 símbolos primero**, mirándolo de
  cerca los primeros días. Comparar fills reales vs paper.

## §9 — Logging y la COMPARACIÓN (el dato que justifica todo)
- Tabla `execution_orders`: cada orden/fill/cancel/modificación/error, con `intentId`, precios reales,
  timestamps, comisiones reales.
- **La métrica del test:** para cada señal, el paper registra lo que HARÍA y el executor lo que PASÓ →
  **fill-rate real vs paper** · **precio de fill real vs CE** (slippage) · **resultado real vs paper**.
  Foco en los fills de penetración ≈0 (los que el fill-stress marcó frágiles): ¿llenan o no?

## §10 — Criterio de ÉXITO y de PARAR (pre-registrado)
- **Éxito (escalar con cuidado):** a ~20-30 fills reales, el **fill-rate real ≈ el del paper** (las
  límites de toque llenan) **y** el resultado real no colapsa vs paper. → recién ahí se evalúa subir tamaño.
- **PARAR / no escalar:** si los fills reales son sustancialmente peores que el paper (las de toque no
  llenan) → el edge era de papel → **no se escala**; se vuelve al Ciclo 4 (estrategia con entrada robusta).
- **Kill inmediato:** cualquier desync, comportamiento inesperado, o el circuit breaker.

## §11 — Checklist PRE-REAL (P.5.4, todos obligatorios)
- [ ] P.5.2/P.5.3 verdes en testnet (órdenes correctas, BE, cancel, reconciliación, reinicio).
- [ ] Key real: trade sí / withdrawal no / IP-whitelist verificada.
- [ ] Billetera Futures fondeada con ~$120 (límite absoluto).
- [ ] Margen aislado + leverage 5x configurados en la cuenta.
- [ ] Todos los topes del §5 activos y testeados (probar que el kill-switch cancela todo).
- [ ] `EXECUTION_ENABLED=true`, `EXECUTION_TESTNET=false`, capital $100.
- [ ] Backup del estado + plan de "apagar todo" a mano si hace falta.
- [ ] Arrancar con 1-3 símbolos, no los 10.

## §12 — Runbook de validación TESTNET (P.5.3 paso 5)
Correr **LOCAL** (no tocar el server de producción, que corre el paper-test sobre mercado REAL). Env:
```
EXCHANGE_PROVIDER=binance
BINANCE_FUTURES_BASE_URL=https://testnet.binancefuture.com
BINANCE_FUTURES_WS_URL=wss://stream.binancefuture.com   ← WS de testnet (clave: detección de fills)
BINANCE_API_KEY / BINANCE_API_SECRET = los de testnet (con permiso de trade)
DB_ENABLED=true + DB local (localhost:5433 / futures_bot_v2 / *_dev_password / futures_bot_v2_dev)
EXECUTION_ENABLED=true · EXECUTION_TESTNET=true
MARKET_DATA_LIVE=true · MARKET_DATA_SYMBOLS=BTCUSDT,ETHUSDT
(PAPER_TRADING no es necesario para el inyector; sí para validar señales naturales)
```
Pasos (la migración `execution_orders` ya está aplicada en la DB local):
1. `npm run build` → `node dist/main`
2. `GET /api/exec/status` → enabled/testnet/risk-guard limpio
3. `POST /api/exec/test-intent {"symbol":"BTCUSDT"}` → en los logs: **LÍMITE → FILL → BRACKET** (segundos)
4. `GET /api/exec/status` → la posición FILLED; en la UI de Binance testnet → la posición + SL/TP
5. esperar SL/TP, **o** `POST /api/exec/kill` para aplanar (prueba el kill-switch)
6. `GET /api/exec/status` → CLOSED + risk-guard actualizado; tabla `execution_orders` → la fila del ciclo
7. **BE:** dejar una posición abierta; al cierre de la vela 15m, si el precio alcanzó el 50 % a TP → el SL se mueve
8. **reconciliación:** matar `node` con una posición abierta → re-arrancar → debe re-adoptarla y verificar el bracket

**Éxito = ** fill detectado · SL+TP colocados · BE mueve el stop · salida → R correcta · kill-switch aplana ·
reinicio re-adopta/protege. Recién con esto verde → P.5.4 (real $100, +isolated margin, +checklist §11).
