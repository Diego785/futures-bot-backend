# Plan de migración v1 → v2

> Estado: v1.0 · 2026-05-27

## Decisiones fijadas
- Mismo repo, rama `v2-copilot`. El bot v1 se apaga.
- TFs iniciales: **1D, 4H, 1H, 15m** (semanal/mensual después).
- **Sin** BullMQ/Redis. Front: **React/Next + Lightweight Charts** (Flutter → móvil futuro).
- Exchange: verificar **Binance**; fallback **Bybit**. **Copiloto puro (cero ejecución).**

## Fases

| Fase | Qué se hace | Qué NO se hace |
|---|---|---|
| **0 — Congelar v1** | Backup DB + `.env`, tag `v1-final-before-v2`, apagar bot, confirmar cero ejecución, aprobar `INVENTORY-V1` | No borrar sin inventario |
| **1 — Docs** *(este commit)* | VISION, SAFETY, INVENTORY, MIGRATION, API-CONTRACT, SMC-SPEC, DATASET-PROTOCOL, NO-REPAINT | No motor SMC |
| **2 — Demolición** | Eliminar módulos 🔴 en commit separado; ajustar `app.module`; quitar bullmq/redis | No features nuevas aquí |
| **3 — Market data** | Velas histórico + live 1D/4H/1H/15m, normalizado Binance/Bybit, **persistidas localmente** | No detección |
| **4 — Visor mínimo** | Front Lightweight Charts: velas + marcado manual (OB/FVG/liquidez/entrada/SL/TP) + guardado | No motor, no señales |
| **5 — Golden dataset** | Capturar casos desde el visor; partir en calibración / held-out / out-of-time / cuarentena | No ajustar contra todo |
| **6 — Motor SMC offline** | Detectores causales vela-por-vela; aprueba en held-out, no en calibración | No live |
| **7 — Señales candidatas** | Entradas alta/media/baja, SL distal, **TPs candidatos**, **R:R calculado**, BE | No órdenes |
| **8 — Live + capas + journal** | WS push; capas toggleables; journal API read-only (persistencia local) | No ejecución |
| **9 — Calibración real** | 1–2 semanas: observar / marcar / aceptar / rechazar / comparar | No automatizar |

## Nota crítica sobre el journal
Binance Futures devuelve solo **~6 meses** de historial de trades (cambio de oct-2024) y Bybit
es similar. → **Sincronizar y persistir localmente desde el día uno.** El exchange no es el
archivo histórico; nuestra DB sí.

## Lookback histórico (causalidad)
Al arrancar, el motor carga histórico suficiente por REST y lo procesa **causalmente** para
reconstruir zonas vigentes (≈1–2 años en 1D, semanas en 15m). Ver `NO-REPAINT-RULES.md`.

## La SMC-SPEC es viva, no bloqueante
La `SMC-SPEC-VIDEO-1.md` se cierra **marcando casos reales en el visor (Fase 4–5)**, no antes.
El visor no espera a la spec; el visor es la herramienta para validar la spec.
