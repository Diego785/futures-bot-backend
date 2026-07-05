# Ciclo 4 — PRE-REGISTRO de la gestión de salida (parcial + BE-en-ganancia + runner a liquidez)

> **Estado: 🔴 PRE-REGISTRADO (2026-07-02) — pendiente de ejecutar.**
> Fuente primaria: **la práctica real del instructor/comunidad** (chats de WhatsApp aportados por el
> usuario, 2026-07-02: 1:1 con Pablo Rivas + grupo ~19k líneas, analizados exhaustivamente). NO viene
> de los videos (los videos NO traen parciales — cerrado en `CYCLE-2-PREREG.md` §6): es una fuente
> NUEVA, por eso un ciclo nuevo con su propio pre-registro.
> **Regla de oro (igual que C2/C3):** este documento fija QUÉ se prueba, CÓMO se valida y CUÁNDO se
> reemplaza el candidato congelado — ANTES de mirar un solo resultado. Cambiar criterios a mitad = overfit.
> **Regla Cero:** todo esto es BACKTEST (lee la DB). El candidato congelado sigue corriendo tal cual
> en paper (server+local) y el camino P.5.4 (test de fills real) NO se toca ni se retrasa.

## 0. Por qué un Ciclo 4

El usuario (auditoría del dashboard + su prioridad de fidelidad a la fuente) señala que el candidato
**cierra temprano**: TP 2R fijo corta las corridas largas, y los BE "no ganaste nada" (44 % en
histórico) frustran. Los profesionales que él sigue **no** salen todo-o-nada en un múltiplo fijo:
aseguran parcial, blindan la posición EN GANANCIA y dejan correr el resto hasta la estructura.
El 2R fijo fue NUESTRA simplificación (2 veces defendida por los datos como sustituto robusto del
target discrecional — Fase D y C2 §8 — pero siempre como TP de posición ENTERA). El C4 prueba un
diseño **matemáticamente distinto**: asegurar + dejar correr, que no está probado.

## 1. La fuente (citas de los chats, 2026-07-02)

**Pablo Rivas (1:1):**
- *"Generalmente cuando voy 5 % — tomo 30 % de parciales — y pongo en break even"*
- *"Yo cerré la mitad en 94 y puse SL en 95.000 — por eso no morí"* · *"Cerré la mitad en BE"*
- *"Yo tomo parciales y dejo correr"* · *"Y lo dejaré toda la noche"*
- TP del resto = estructura: *"el TP es 92k — **el último alto de ayer**"* · *"Son **altos que
  marqué de hace meses**"* · zonas de fibo ancladas a una mecha mayor
- *"Este negocio es más consistencia que análisis"*

**Grupo (corroboración):** *"tomen parciales, 25, 50, 75"* · *"50 % cerrado y dejo correr"* ·
*"sacá la mitad y manejá stoploss"* · *"si no tenés fundamento para que siga, tomá profit al menos
parcial"*.

**Requisito explícito del usuario:** un BE debe cerrar **en ganancia**, aunque sea $0.01 — nunca
"ni ganaste ni perdiste".

**Ambigüedad que NO se copia literal:** el *"cuando voy 5 %"* de Pablo es ROI **apalancado** (con
su leverage típico equivale a ~0.5–1R de recorrido) → el gatillo del parcial se parametriza **en R**.

## 2. La mecánica C4 (SOLO cambia el motor de salida)

**La ENTRADA no se toca:** gatillo C (sweep+reclaim), límite en el CE, SL distal+buffer,
`cancelBeyond` 3×, `minStopPct` 0.3 %, sesgo HTF 4H — idénticos al candidato congelado. El gate
`minRr` se sigue evaluando contra el TP nominal 2R ⇒ **los intents (y N) son IDÉNTICOS por
construcción**: la comparación es limpia (mismas entradas, distinta gestión).

Ciclo de vida de la posición (todo causal, mismas convenciones conservadoras del simulador):
1. **TP1 (parcial):** orden límite que cierra `partialFrac` de la posición en
   `entry + tp1AtR × riesgo` (dirección a favor). Fill al toque (maker), como el TP actual.
2. **Al llenar TP1 → SL → BE+buffer** para TODO el resto (mismo `beBufferPrice` actual: cubre el
   round-trip ⇒ la pierna BE rinde ≈ 0R; el trade completo queda **positivo** por el parcial —
   cumple el requisito "cerrar en ganancia"). El movimiento surte efecto en la vela SIGUIENTE
   (sin reordenar intrabar a favor — igual que el BE actual). En modo C4 el BE se ancla al fill
   del TP1 (reemplaza `breakevenAtTpFraction`; con `tp1AtR=1.0` el timing del BE es EXACTAMENTE
   el del candidato actual: 50 % del camino a 2R = +1R).
3. **Runner (`1 − partialFrac`):** corre hasta **TP2 = la liquidez opuesta más cercana no barrida**
   (la lógica CAUSAL existente `nearestLiquidityTp`, Fase D, conocida al cierre de la vela de
   señal; se persiste en el intent). **Fallback pre-fijado:** si no hay pool o el pool está
   ≤ TP1 → TP2 = 2R fijo (`tpSource 'fallbackFixedR'`, contabilizado). Sin salida por tiempo
   (`maxHoldBars=0`, "dejarlo correr"); `endOfData` cierra al último cierre como hoy.
4. **Pesimismo intrabar intacto:** SL y TP1/TP2 en la misma vela ⇒ SL primero (pérdida completa
   −1R si aún no llenó TP1). TP1 y TP2 en la misma vela (a favor) ⇒ ambos llenan (sin ambigüedad
   adversa).
5. **Contabilidad en R (por pierna, neta de fees):**
   `R = partialFrac × R_tp1 + (1−partialFrac) × R_runner`; entrada maker prorrateada por pierna;
   TP1/TP2 maker; BE/SL taker. Métricas nuevas: `tp1HitRate`, distribución de salida del runner
   (TP2/BE/SL/endOfData), `avgRunnerR`, % fallbackFixedR.

**Qué le hace esto al dolor del usuario:** el trade que hoy muere "BE +0.00" pasa a cerrar
≈ `partialFrac × tp1AtR` en positivo (p. ej. 50 % × 1R ≈ **+0.5R asegurado**), y el que hoy corta
en 2R puede correr hasta el pool.

## 3. Espacio de búsqueda (CERRADO — 5 variantes, nada más)

| # | tp1AtR | partialFrac | TP2 del runner |
|---|---|---|---|
| V1 | 1.0R | 30 % | liquidez (fallback 2R) |
| V2 | 1.0R | 50 % | liquidez (fallback 2R) |
| V3 | 0.5R | 30 % | liquidez (fallback 2R) |
| V4 | 0.5R | 50 % | liquidez (fallback 2R) |
| V5 (descomposición) | 1.0R | 50 % | **2R fijo** (aísla el efecto "parcial" sin el target-pool) |

Benchmark = **candidato congelado** (2R entero + BE 50 %), re-corrido en las MISMAS ventanas.
Todo lo demás FIJO (cancelDist 3, swing 10, slBuffer 0.1, minStop 0.3 %, maker/taker, HTF 4H).
No se prueban variantes extra (trailing, otros gatillos de parcial, caps) — data-dredging prohibido.

## 4. Protocolo de validación (idéntico en espíritu a C2 §4)

1. **Calibración:** 2022-01 → 2025-06. Las 5 variantes × **10 símbolos**. Se elige UNA (mejor
   pooled con estabilidad) — decisión SOLO con calibración.
2. **Held-out intocado:** 2025-06 → 2026-07. La elegida se corre UNA vez. Se reporta tal cual.
3. **Walk-forward 12 ventanas** 2022-2026, 10 símbolos (estabilidad; se reporta).
4. El **agregado de los 10** manda (no cherry-pickear símbolos — lección del htf2/C2).
5. Toda corrida registrada con `--register` (paramsHash + comando); el visor las muestra.

## 5. Criterio de REEMPLAZO (pre-registrado — se juzga en held-out + walk-forward)

El C4-candidato reemplaza al congelado SOLO si cumple TODO en held-out:
1. **Pooled 10 símbolos ≥ benchmark + 0.02R** de expectancy.
2. **TotalR ≥ el del benchmark** (con N idéntico por construcción, equivale a expectancy — se
   verifica que N sea efectivamente idéntico como sanity del diseño).
3. **≥ 7/10 símbolos** con expectancy ≥ benchmark − 0.03R.
4. **maxDD por símbolo ≤ 1.5×** el del benchmark (asegurar parcial no puede disparar la varianza).
5. **Tasa de SL-completo** (pérdida −1R sin parcial) ≤ benchmark + 5 pp.
6. **Walk-forward:** % ventanas rentables ≥ benchmark − 10 pp.

Si NINGUNA variante cumple → **negativo-informativo**: el congelado sigue vigente, los flags quedan
como herramienta, y se documenta (como C2 §8 / C3 §7). Si cumple → el C4 se CONGELA como candidato
v2, corridas canónicas re-registradas, y arranca **SU PROPIO paper-test** (el gate del actual no se
hereda: gestión distinta = evidencia distinta). El paso a ejecución real del v2 exigiría su propio
checklist (EXECUTION-SPEC §11) — sin atajos.

## 6. Fuera de alcance del C4 (cada uno exigiría su propio pre-registro)
Trailing stop del runner · pirámide/re-entradas · salida por tiempo · filtros de sesión/killzone y
noticias (posible C4b: Pablo evita aperturas/noticias — pero apilar filtros ya empeoró 3 veces) ·
copiar el "5 % ROI" literal · scoring discrecional del pool (la lección del C2 §8).

## 7. Plan de slices (cada uno: build + tests + aprobación)
- **C4.a** — extensión del simulador: modo `exit: 'partial-runner'` en `SimConfig` (tp1AtR,
  partialFrac; TP2 viene del intent), contabilidad por pierna, pesimismo intacto. Tests: piernas
  (TP1→BE del runner ≈ +frac×tp1R; TP1→TP2; SL antes de TP1 = −1R; same-bar SL+TP1; fees por
  pierna; endOfData). El default sigue siendo el candidato congelado (flag off = idéntico bit a bit
  — test de regresión).
- **C4.b** — `signal-source`: persistir el TP2-liquidez causal en el intent (campo nuevo; el gate
  minRr sigue sobre el 2R nominal). Tests de causalidad.
- **C4.c** — CLI (`--exit c4 --tp1r X --frac Y [--tp2 fixed]`) + corridas de CALIBRACIÓN
  (5 variantes × 10 símbolos, registradas) → elección de UNA.
- **C4.d** — held-out + walk-forward + veredicto contra §5 → decisión.
- **C4.e** — si reemplaza: visor muestra TP1/TP2 y las piernas en el porqué causal; paper-test v2.
