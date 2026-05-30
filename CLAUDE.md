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

## Estado actual (2026-05-29)
- Fase 1 Docs: COMPLETA. Ver `docs/` (lista abajo).
- Fase 2 Demolición: COMPLETA. Esqueleto compila + smoke test verde (`/api/status` 200; endpoints v1
  → 404; arranca sin DB con `DB_ENABLED=false`).
- Capa de entrada (`ENTRY-EDGE-SPEC.md`): especificada (provisional).
- SIGUIENTE: Fase 3 Market Data (velas multi-TF 1D/4H/1H/15m, **persistidas** desde el día uno).

## Documentación (fuente de verdad — leer antes de codear)
- `docs/VISION-V2.md` — filosofía copiloto + definición de éxito
- `docs/SAFETY-V2.md` — Regla Cero, API read-only, checklist pre-demolición
- `docs/INVENTORY-V1.md` — qué se conservó/eliminó/archivó
- `docs/MIGRATION-PLAN.md` — fases 0–9
- `docs/API-CONTRACT.md` — modelo canónico de vela, tipos Zone/Setup/SignalCandidate, REST + WS
- `docs/SMC-SPEC-VIDEO-1.md` — cómo se DIBUJAN las zonas (provisional, con 🔴)
- `docs/ENTRY-EDGE-SPEC.md` — **dónde vive el edge**: zona ≠ entrada, máquina de estados de señal
- `docs/DATASET-PROTOCOL.md` — anti-overfitting (calibración/held-out/out-of-time/cuarentena)
- `docs/NO-REPAINT-RULES.md` — causalidad (lookahead=0, vela por vela)

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
