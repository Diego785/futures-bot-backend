# Visión de Producto y Norte del Proyecto

> **Qué es este doc:** centraliza el OBJETIVO FINAL del proyecto y lo que el usuario debe poder VER.
> Es el "para qué" que ningún modelo debe perder de vista. Extiende `VISION-V2.md` (filosofía copiloto /
> origen) con el **norte concreto** y la **visión de dashboard**. Si hay conflicto con un detalle de otro
> doc, el NORTE de aquí manda. Última actualización: 2026-06-08.

## 1. El Norte (innegociable)

1. **El bot debe ser RENTABLE.** Es EL objetivo final. Toda decisión se mide contra una sola pregunta:
   *¿esto nos acerca a un bot demostrable y verificablemente rentable?* **Nunca nos desviamos de aquí.**
2. **Dirección: que el bot llegue a operar POR SÍ SOLO (autónomo).** No es un copiloto para siempre; el
   fin es la autonomía. PERO con disciplina absoluta: solo tras PROBAR rentabilidad por etapas —
   **backtest ✅ → paper-test en vivo (papel) → recién entonces ejecución real**, y esa última con su
   propia revisión de seguridad (kill-switch, límites, IP whitelist). Hasta esa decisión futura y
   explícita rige la **Regla Cero**: el bot NO coloca/modifica/cancela órdenes.
3. **Claridad TOTAL en cualquier momento.** El usuario no confía a ciegas: debe poder ver, **fácil y en
   detalle**, qué hace el bot y **por qué** — cada señal, cada entrada, cada operación. La transparencia
   es la condición para confiar, y para que algún día se le permita operar solo.

## 2. Por qué la claridad es requisito, no lujo

La lección del v1: una **caja negra** que parecía rentable (PF 7.37 in-sample) y perdió **−68 % en vivo**.
Ver cada decisión del bot permite (a) **cazar errores en la semana 1, no en el mes 3**; (b) **validar que
cada entrada se ejecutó con criterio y lógica SMC correctos**; (c) construir la confianza necesaria para
una eventual autonomía. **Sin visibilidad no hay confianza; sin confianza no hay autonomía.**

## 3. El Dashboard — qué debo poder VER (requisito central)

Tres vistas, sobre la gráfica existente (TradingView Lightweight Charts del cockpit) o ligadas a ella:

### 3.1 En vivo (la gráfica)
- Cada señal / entrada del bot dibujada en su **punto EXACTO**: entry, SL, TP, dirección, R:R.
- El **análisis que la sustenta**: las zonas SMC (OB, FVG, liquidez), el sweep, el sesgo HTF — el
  **PORQUÉ causal** de esa señal, no solo el resultado.
- **Estado en vivo** de cada posición: pendiente → llena → ganada / perdida / break-even.
- *(Detalle de implementación de la capa en vivo: `PAPER-TEST-SPEC.md` §5.)*

### 3.2 Historial / Reportes
- Registro de **todo lo que el bot hizo**: cada operación con su resultado en **R** y la **rentabilidad
  acumulada**.
- Debe responder, fácil y al instante, **la única pregunta que importa: ¿estamos siendo rentables?**
  (expectancy en R, win-rate, profit factor, curva de equity, max drawdown, nº de operaciones).
- Filtrable y con el detalle completo de cada trade (por qué entró, cómo salió).

### 3.3 Backtests — replay visual (requisito EXPLÍCITO del usuario)
- Una **sección por cada backtest realizado**.
- **Reproducción DINÁMICA sobre la gráfica:** ver cómo se desarrolló el backtest **con el paso de las
  velas** — cada operación apareciendo en su momento, en su **punto exacto de entrada y salida**, a
  medida que el tiempo (las velas) avanza.
- **Objetivo:** que el usuario (y el bot) **validen visualmente que CADA entrada se ejecutó correctamente,
  con criterio y lógica SMC adecuados.** El número de expectancy no basta; hace falta ver **la película**
  de cómo se llegó a él, trade por trade, en su contexto de mercado.
- Convierte el backtest de "un número en una tabla" a "algo que puedo **auditar con mis propios ojos**".

## 4. Cómo encaja con lo ya construido (es factible)

- **Datos:** las velas (años de histórico, 5 símbolos) ya están en la DB.
- **Motor de backtest:** ya produce **cada trade con su entry/SL/TP/R/tiempos** → la sección Backtests
  solo los **dibuja y reproduce** sobre las velas. Es visualización de datos que YA generamos.
- **Análisis determinista y causal:** las zonas/señales se **re-derivan a demanda** desde las velas (sin
  inflar la DB con snapshots).
- **Paper-trader (P.1 ✅):** produce las señales/posiciones en vivo → alimenta 3.1 y 3.2.
- ⇒ Es sobre todo trabajo de **frontend + endpoints read-only**, NO de re-inventar la lógica de trading.

## 5. Sugerencia proactiva de orden

El **visor de backtests (3.3) es construible YA**: los datos y los trades existen, no necesita el
cableado en vivo. Daría **claridad inmediata** y una herramienta para **validar la estrategia
visualmente** antes y durante el paper-test (justo lo que el usuario pide). Buen candidato a priorizarse
junto a — o antes de — la parte live. *(Sujeto a la revisión independiente y a tu decisión.)*

## 6. Principios innegociables

- **Rentabilidad es el juez.** Honestidad > optimismo: un "no es rentable" es un resultado VÁLIDO que
  ahorra dinero (no un fracaso).
- **Regla Cero** hasta la decisión futura y explícita de autonomía (con su propia revisión de seguridad).
- **Integridad:** el registro mecánico incluye TODA señal del candidato, sin filtro humano; la lectura
  discrecional del usuario va APARTE (journal) — nunca cherry-picking (ver `PAPER-TEST-SPEC.md` §4).
- **Causalidad / sin repaint** en todo: lo que se dibuja es lo que el bot sabía en ese instante.
- **SMC al pie de la letra:** la estrategia que capturamos de los videos (`SMC-STRATEGY-MECHANICAL.md`).

## 7. El camino

```
backtest ✅  →  paper-test en papel (gate #7, en curso)  →  [si la rentabilidad sobrevive en vivo]
   →  decisión de ejecución real (revisión de seguridad propia)  →  AUTONOMÍA rentable y AUDITABLE
```

Cada etapa se valida antes de pasar a la siguiente. El dashboard (sección 3) es lo que hace cada etapa
**auditable** — y por eso es parte del producto, no un extra.
