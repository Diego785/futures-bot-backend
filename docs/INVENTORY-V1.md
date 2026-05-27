# Inventario v1 — conservar / eliminar / adaptar / archivar

> Estado: v1.0 · 2026-05-27 · Basado en el árbol real de `src/` al crear `v2-copilot`.
> Leyenda: 🟢 conservar · 🔴 eliminar · 🟡 adaptar · 📦 archivar
> Nada se borra hasta que este inventario esté aprobado (la demolición es la Fase 2).

## Infraestructura — 🟢 conservar
- `main.ts`, `app.module.ts` (🟡 ajustar imports tras demolición)
- `common/**` (utils: hmac, precision, client-order-id · filters · constants · interfaces · config/env.validation)
- `health/**`
- `notifications/**` (FCM — para alertas de señal candidata)

## Exchange / datos de mercado — 🟢 conservar
- `exchange/**` (interfaces + module: abstracción multi-exchange, clave para Binance↔Bybit)
- `binance/**` (rest, market-ws, user-ws, adapters, exchange-info, dto)
- `bybit/**` (rest, market-ws, user-ws, exchange-info) — fallback

## Dashboard — 🟡 adaptar (núcleo nuevo)
- `dashboard/dashboard.gateway.ts` — se expande (emite análisis SMC + velas)
- `dashboard/dashboard.controller.ts` — se expande (histórico, journal, marcas manuales)
- `dashboard/dto/**`

## Estrategia
- `strategy/smc.service.ts` — 🟡 referencia; se reescribe como motor v2 (otras definiciones)
- `strategy/indicators.service.ts` — 🔴 (sin indicadores; rescatar solo helper de "fuerza" si sirve)
- `strategy/pullback-ob-signal.service.ts` — 🔴
- `strategy/hybrid-signal.service.ts` — 🔴
- `strategy/signal-generator.service.ts` — 🔴 (se reemplaza por generador de candidatas)
- `strategy/pre-filter-gate.service.ts` — 🔴
- `strategy/deepseek.service.ts` + `schemas/deepseek-response.schema.ts` — 🔴 (sin IA)
- `strategy/signal-cache.service.ts` — 🟡 evaluar
- `strategy/schemas/signal.schema.ts` — 🟡 adaptar a señal candidata

## Trading
- `trading/execution.service.ts` — 🔴 (no ejecuta órdenes)
- `trading/risk-manager.service.ts` — 🔴 (no auto-trading)
- `trading/telemetry.service.ts` — 🟡 evaluar (diagnóstico)
- `trading/entities/signal.entity.ts` — 🟡 → `SignalCandidate`
- `trading/entities/trade.entity.ts` — 🟡 → `JournalEntry`
- `trading/entities/order.entity.ts` — 🔴
- `trading/entities/daily-pnl.entity.ts` — 🟡 métricas del journal
- `trading/entities/daily-telemetry.entity.ts` — 🟡 evaluar
- `trading/entities/strategy-state-snapshot.entity.ts` — 🔴 (era para replay del v1)

## Bot
- `bot/strategy-cycle.processor.ts` — 🔴 (BullMQ auto-trading)
- `bot/kill-switch.service.ts` — 🔴
- `bot/bot-state.service.ts` — 🟡 (on/off del análisis)
- `bot/maintenance-cron.service.ts` — 🟡 (rescatar keepalive WS + reconcile journal)

## Telemetry
- `telemetry/state-snapshot.service.ts` — 🔴 (replay del v1)

## Backtest — 📦 archivar
- `backtest/**` — no se borra; se aísla. Podría servir para validar la estrategia v2 más adelante.

## Dependencias
- 🔴 quitar: `@nestjs/bullmq`, `bullmq`, `ioredis` (sin colas)
- 🟢 mantener: `@nestjs/typeorm` + `pg` · `@nestjs/platform-socket.io` + `socket.io` · `ws` ·
  `@nestjs/schedule` · `zod` · `class-validator` · `nestjs-pino` · `google-auth-library` (FCM)
