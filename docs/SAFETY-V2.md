# Seguridad — v2

> Estado: v1.0 · 2026-05-27

## Regla cero
**El bot NO ejecuta operaciones.** Ningún módulo coloca, modifica o cancela órdenes.
El humano opera manualmente en el exchange. El bot solo lee, analiza, sugiere y registra.

## Credenciales
- API key del exchange **read-only**: sin permiso de trading, sin permiso de retiro.
- IP whitelist activada si el exchange/cuenta lo permite.
- Secrets solo en `.env` (nunca en el repo). Backup de `.env` fuera del repo.

## Datos
- Market data: solo lectura (WS klines + REST histórico).
- Journal: solo lectura del historial de cuenta (`userTrades` / `income`).

## Checklist ANTES de demoler v1 (Fase 0 → Fase 2)
- [ ] Bot v1 apagado (contenedor detenido).
- [ ] Confirmado: ningún proceso con ejecución automática activo.
- [ ] Backup de base de datos.
- [ ] Backup de `.env` y configuración de producción.
- [x] Tag/rama de respaldo `v1-final-before-v2` creado.
- [ ] `INVENTORY-V1.md` revisado y aprobado por el usuario.
- [ ] La demolición va en un **commit separado** (sin features mezcladas).

## Durante v2
- Cero módulos de órdenes activos, ni siquiera "por si acaso".
- Si en el futuro se evalúa ejecución, será una decisión explícita y separada, fuera del MVP.
