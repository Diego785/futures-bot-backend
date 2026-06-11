# Futures AI Bot — Guía del proyecto (v2: Copiloto SMC)

> **Rama activa: `v2-copilot`.** Reescritura del bot como **copiloto** de trading SMC.
> El v1 (autopiloto) está archivado: vive en `main`, en el historial git y en `legacy/`.
> No mezclar lógica v1 en v2. Si algo de esta guía contradice el código de la rama, gana el código.

## ⚠️ Regla Cero (innegociable)
**El bot NO ejecuta operaciones.** Ningún módulo coloca, modifica ni cancela órdenes. El usuario
opera **manualmente** en Binance. El backend solo lee mercado, detecta/dibuja zonas, **sugiere**
entradas (candidatas) y registra el journal. Toda señal es una **sugerencia**, nunca una instrucción.
Si vas a añadir algo que toque órdenes/posiciones/balances de forma activa → **detente y pregunta**.

## Qué es v2
Un copiloto que ayuda al usuario a operar SMC manualmente en BTC y a **aprender a operar**:
- detecta y dibuja zonas (Order Blocks, imbalances, liquidez) sobre velas en tiempo real;
- **sugiere** entradas/SL/TP solo cuando se cumplen condiciones de edge (no al toque de zona);
- lleva un journal del desempeño (datos del broker read-only + anotaciones del usuario);
- el usuario **compara** su lectura con la del bot y edita/rechaza cada sugerencia → así
  aprende, valida y debate. El bot **no** copia las entradas del usuario: ambos estudian la
  misma estrategia y el bot da una lectura SMC propia (ver `docs/VISION-V2.md`).

## Qué NO es
Autopiloto · ejecutor de órdenes · clon del ojo del usuario (no imita tus marcas, hace su
propia lectura) · clon de LuxAlgo · sistema con ML al inicio.

## Lección del v1 (por qué cambiamos)
El v1 decidía y ejecutaba solo. Backtest PF 7.37 → gap del 68 % en vivo. El problema no era el código:
era el enfoque (autopiloto sobre una estrategia visual y discrecional, entrando al toque de zona =
adverse selection). v2 mueve la decisión al humano y usa el software como ojos + memoria + disciplina.

## Stack v2
- **Framework**: NestJS 11, TypeScript (nodenext)
- **DB**: TypeORM + PostgreSQL — `synchronize:false`; TypeORM solo se carga si `DB_ENABLED=true`
- **WebSocket**: Socket.IO (namespace `/ws`) para el dashboard
- **Exchange**: Binance USDT-M Futures (datos públicos; credenciales read-only solo para journal).
  Fallback Bybit. Abstracción multi-exchange en `src/exchange/` (puertos + adapters).
- **Front (futuro)**: React/Next + TradingView Lightweight Charts. Flutter → app móvil posterior.
- **SIN**: BullMQ/Redis, DeepSeek, risk-manager, ejecución de órdenes (todo eliminado del v1).

## Estado actual (2026-06-06)
- Fase 1 Docs: COMPLETA. Ver `docs/` (lista abajo).
- Fase 2 Demolición: COMPLETA. Esqueleto compila + smoke test verde (`/api/status` 200; endpoints v1
  → 404; arranca sin DB con `DB_ENABLED=false`).
- Capa de entrada (`ENTRY-EDGE-SPEC.md`): especificada (provisional).
- Market Data + lectura del bot (`src/bot-analysis/`: FVG/OB/Liquidez/Confluencia/Setups/Planes) +
  cockpit frontend (marcado manual + workspace): COMPLETOS. OB con detector **ESTRUCTURAL** (swing-first).
- **RUMBO 2026-06-06:** los 3 videos (OB / entradas / Breaker) sintetizados en una **estrategia mecánica
  unificada** (`SMC-STRATEGY-MECHANICAL.md`) para **backtestear** y medir expectancy. Decisión del
  usuario: *mecánica + backtest primero; la ejecución se decide después con la curva out-of-sample*.
  **Regla Cero intacta** (el backtest NO ejecuta; la autonomía sería decisión futura con su propia
  revisión de seguridad).
- Fase B (detectores) ✅ y **Fase C (motor de backtest) ✅**: módulo `src/backtest/` (simulador en R +
  métricas + signal-source 3 gatillos + CLI `npm run backtest`, lee la DB read-only). Causal, 30 tests.
- Fase D ✅: backfill de años (CLI `npm run backfill`; BTCUSDT 4h 9.7k/1h 30k/15m 85k/5m 150k) + filtro
  **fee-aware** (minStopPct) + fees **maker/taker**. Rejilla de 24 variantes re-corrida.
- **Fase E ✅: candidato VALIDADO en histórico** (`walkforward.ts` + CLI `--wf`). Candidato: **15m · C
  (sweep+reclaim) · TP 2R · cancelDist 3 · swing 10 · BE 50%**. `cancelDist` 1→3 elegido en calibración y
  validado en held-out (+0.376R). Walk-forward 2022–2026 (15m a 155k velas, incluye bear 2022): **N=108,
  pooled +0.231R, 81.8% ventanas rentables.** El BE al 50% ES el mecanismo del edge (quitarlo lo derrumba).
  Cruzaba los criterios históricos #1/#2/#4/#5/#6/#8 EN BTC-15m. PERO:
- **Fase F (robustez) ✅ → el candidato NO generaliza = OVERFIT.** Slippage: robusto (aguanta $20/lado).
  Pero el edge es SOLO de 15m (BTC 5m/1h/4h pierden) y **NO pasa a ETH-15m** (mismos params, N=211: −0.043R,
  PF 0.91, 42% ventanas). Positivo aislado rodeado de break-even/negativo = firma del overfit, no del edge.
  El pase de walk-forward en BTC-15m era convincente y aun así engañoso — **la trampa del v1, atrapada a
  tiempo** (antes de paper-test o dinero). NO pasa a autonomía.
- **Revisión sesgo HTF ✅** (`htf-bias.ts` + CLI `--htf`, commit 4c29599): el gatillo C solo dispara a favor
  de la estructura HTF (BOS por cuerpo 4H, causal). **Mejora real pero NO suficiente:** BTC 15m +0.246→+0.279R
  (72.7% ventanas); ETH 15m −0.043→**+0.045R** (PF 1.09, 42% ventanas) = dejó de perder pero quedó break-even.
  El sesgo HTF era la intuición correcta (ayudó a ambos) pero el edge sigue **débil y BTC-céntrico**, no robusto.
- **Barrido multi-símbolo ✅ (2026-06-08): el edge GENERALIZA (débil).** Mismo candidato + `--htf 4h` en 5
  símbolos (walk-forward 12 ventanas, 2022-26): **5/5 pooled-positivo** — BTC +0.249 / XRP +0.194 / SOL +0.146
  (robustos) · BNB +0.046 / ETH +0.045 (break-even). No era "BTC con suerte". Caveat: majors correlacionados =
  no son 5 pruebas independientes. Pasó de "overfit a BTC" a "edge débil REAL, fuerte en BTC/XRP/SOL".
- **Fortalecimiento HTF estricto probado → NO ayuda** (`alignBias` + CLI `--htf2`, commit pendiente): el HTF
  más estricto (1D solo / 4H+1D alineados) deja el edge igual o peor (1D mete a ETH en negativo). **El 4H ya
  era el óptimo del lever HTF.** No se cherry-pickea el 1D-en-BTC (= overfit). Lever HTF agotado.
- **Decisión del usuario (2026-06-08): parar de tunear (evitar overfit) y pasar al PAPER-TEST (gate #7).**
  Diseño en `docs/PAPER-TEST-SPEC.md` (shadow read-only: lee en vivo, registra lo que el candidato HARÍA,
  NO coloca órdenes; salvaguarda estructural = no importa el write-API). Candidato CONGELADO (no re-tunear).
  Plan P.1 (núcleo puro offline) → P.2 (cableado live) → P.3 (review) → P.4 (mini-deploy + reloj 1-3 meses).
- **P.1 ✅** (commit 686a8e9): `PaperEngine` puro incremental (reproduce EXACTO el backtest; reusa
  signal-source + simulador) + test de invarianza Regla Cero (escaneo estructural anti-write-API).
- **Revisión independiente ✅ (2026-06-10, mandato `REVIEW-BRIEF.md`): GO al paper-test con condiciones.**
  Causalidad verificada en código; corridas reproducidas. **Hallazgo mayor:** las corridas documentadas
  (Fase E→htf2) usaron las últimas 100k velas (2023-08→2026-06), NO 2022-26 — con el histórico COMPLETO
  el candidato MEJORA: BTC +0.330R/83.3 %/N=112; 5/5 símbolos positivo (N=822); vecindad de parámetros =
  meseta. **Correcciones:** "el BE es el mecanismo" era falso (BE ≈ sustituto parcial del HTF; el edge es
  direccional); stress de slippage en $ fijos mal especificado (franja 2024-26: +0.299→+0.233 con $20).
  Fix aplicado: id de intents C con dirección (anti-colisión del dedup). Gate #7 RE-REGISTRADO en
  `PAPER-TEST-SPEC.md` §4: 5 símbolos, evaluación a N≥50 (no calendario), paridad mecánica sim↔live +
  touched-vs-crossed. Detalle en `SMC-STRATEGY-MECHANICAL.md` §8 («Revisión independiente»).
- **Visor de backtests ✅ (V.1+V.2+V.3, commits 5dad0e0/7633edf/+)**: corridas registradas
  reproducibles + replay visual CAUSAL + claridad total (niveles/fees, contexto SMC OBs/liquidez,
  embudo). El usuario AUDITÓ y detectó: BE hiperactivo (44 %), TP 2R no fiel, pocas entradas.
- **Ciclo 2 PRE-REGISTRADO (`docs/CYCLE-2-PREREG.md`, 2026-06-10):** con la transcripción del V1
  (`docs/transcripts/`) se confirmó que los specs eran fieles y la desviación nació en el eje del
  backtest (TP 2R + BE atado a él). C2 = TP estructural + BE fiel + pools de liquidez; 4 combinaciones,
  calibración/held-out, benchmark = candidato actual congelado, criterio de reemplazo pre-fijado.
- SIGUIENTE: aprobar el pre-registro → C2.a (pools) → C2.b (TP estructural) → C2.c/d (validación y
  veredicto) → gate #7 (paper-test por N≥50, 5 símbolos) con el candidato que sobreviva.

## Documentación (fuente de verdad — leer antes de codear)
- `docs/PRODUCT-VISION.md` — **EL NORTE**: objetivo final (bot rentable y autónomo) + qué debe poder VER el usuario (dashboard en vivo + historial/reportes + replay visual de backtests). El "para qué" innegociable
- `docs/VISION-V2.md` — filosofía copiloto + definición de éxito
- `docs/SAFETY-V2.md` — Regla Cero, API read-only, checklist pre-demolición
- `docs/INVENTORY-V1.md` — qué se conservó/eliminó/archivó
- `docs/MIGRATION-PLAN.md` — fases 0–9
- `docs/API-CONTRACT.md` — modelo canónico de vela, tipos Zone/Setup/SignalCandidate, REST + WS
- `docs/SMC-SPEC-VIDEO-1.md` — cómo se DIBUJAN las zonas (provisional, con 🔴)
- `docs/SMC-SPEC-VIDEO-2.md` — "la entrada": riesgo vs confirmación, refinamiento multi-TF (provisional)
- `docs/SMC-SPEC-VIDEO-3.md` — **Breaker Block** (OB roto = POI con función invertida); capa de estudio (provisional, 🔴 bajo edge en cripto)
- `docs/ENTRY-EDGE-SPEC.md` — **dónde vive el edge**: zona ≠ entrada, máquina de estados de señal
- `docs/SMC-STRATEGY-MECHANICAL.md` — **síntesis mecánica unificada (V1+V2+V3)**: estrategia cerrada y causal + diseño de backtest (3 ejes libres) + **criterio de autonomía pre-registrado** (provisional 🔴)
- `docs/DATASET-PROTOCOL.md` — anti-overfitting (calibración/held-out/out-of-time/cuarentena)
- `docs/NO-REPAINT-RULES.md` — causalidad (lookahead=0, vela por vela)
- `docs/PAPER-TEST-SPEC.md` — **forward-test en papel (criterio #7)**: shadow read-only, candidato congelado, plan P.1–P.4 (🔴 diseño)
- `docs/REVIEW-BRIEF.md` — **brief para una revisión independiente** (modelo nuevo): mandato crítico + orden de lectura + dudas a pressure-testear antes del paper-test

## Concepto clave: zona ≠ entrada
Una **Zone** (OB/FVG/liquidez) es un punto de interés dibujado. Una **entrada** es una decisión bajo
condiciones de edge: sesgo HTF + barrido de liquidez + confirmación en LTF + premium/discount +
inducement + régimen + killzone + R:R mínimo. Una `SignalCandidate` (entrada sugerida) **solo** nace
cuando un `Setup` recorre `WATCHING → MITIGATED → ARMED → TRIGGERED`. Detalle en `ENTRY-EDGE-SPEC.md`.

## Módulos vivos en `src/`
- `common/` (utils HMAC/precision, filters, config `env.validation` con zod, interfaces)
- `health/` (GET /health)
- `exchange/` + `binance/` + `bybit/` — abstracción multi-exchange (REST, market WS, user WS, info)
- `dashboard/` — esqueleto: `GET /api/status` + gateway WS (sin eventos v1)
- `notifications/` — FcmService (existe; aún no cableado en `app.module` — pendiente decidir)
- `legacy/` — `strategy/smc.service.ts` (motor SMC v1, referencia) + `backtest/`. **Fuera del build**
  (`tsconfig.build.json` excluye `legacy/`). NO importar desde `legacy/`; si se reutiliza algo, se
  reescribe para v2.

## Cómo correr el esqueleto (smoke test)
```bash
npm run build
NODE_ENV=test PORT=3301 EXCHANGE_PROVIDER=binance DB_ENABLED=false node dist/main
# GET /api/status → 200 {"ok":true,"version":"v2-skeleton"}
```

## Despliegue
La producción `38.242.145.246:3300` corre el **v1** (canary). v2 aún no se despliega; cuando se haga,
exigirá `DB_ENABLED=true` + credenciales read-only + IP whitelist. Backups (DB, `.env`) ANTES de
cualquier deploy de v2 (ver checklist en `SAFETY-V2.md`).
