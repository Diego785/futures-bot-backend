# Visión — Futures AI Bot v2 (Copiloto SMC)

> Estado: v1.0 · 2026-05-27 · Rama: `v2-copilot`

## Qué es
Una herramienta que **asiste** al trader humano a operar Smart Money Concepts (SMC)
manualmente en BTC. Detecta y dibuja zonas (Order Blocks, imbalances, liquidez) y
**sugiere** entradas/SL/TP sobre un gráfico en tiempo real. El humano decide y ejecuta.

## Qué NO es
- **No es un autopiloto.** No coloca, modifica ni cierra órdenes. Cero ejecución.
- **No es un clon del ojo del usuario.** Es una segunda opinión consistente.
- **No replica LuxAlgo ni ningún indicador cerrado.** Los trata como capa de referencia.
- **No usa ML al inicio.** "Aprender" = codificar reglas validadas, incrementalmente.

## Aprendizaje: comparación, no imitación
El bot **no** aprende copiando las entradas del usuario. Tú y el bot estudian la **misma
estrategia** (la documentada en `SMC-SPEC-VIDEO-1.md` / `ENTRY-EDGE-SPEC.md`):
- El bot produce una **lectura SMC propia**: OB, FVG/imbalance, liquidez, escenarios
  long/short, invalidaciones, SL/TP lógicos y **el porqué** de lo que ve.
- Las marcas manuales del usuario son un **dataset de comparación y validación**, no un
  objetivo a clonar.
- El usuario **compara** su lectura contra la del bot para aprender, validar y debatir:
  ¿marqué el mismo OB? · ¿el bot vio un FVG que pasé por alto? · ¿mi long entra antes de
  confirmación? · ¿el SL está técnicamente protegido? · ¿el TP apunta a liquidez? ·
  ¿vemos la misma estructura HTF?

El bot es una **segunda mente técnica consistente**, no una sombra automática del usuario.

## Por qué cambiamos (lección del v1)
El v1 intentó decidir y ejecutar solo. Backtest brillante (PF 7.37) → gap del 68 % en vivo.
Diagnóstico: el problema no era el código, era el enfoque (autopiloto sobre una estrategia
visual y discrecional). v2 mueve la decisión al humano y usa el software como ojos + memoria
+ disciplina.

## Principios
1. Copiloto, no autopiloto.
2. Las señales son **candidatas**, no órdenes. El usuario valida / edita / rechaza.
3. Definiciones **parametrizables y validadas**, no hardcodeadas.
4. **Causalidad**: el motor nunca mira el futuro (ver `NO-REPAINT-RULES.md`).
5. **Anti-overfitting**: validación held-out / out-of-time (ver `DATASET-PROTOCOL.md`).
6. Más simple = menos piezas (sin colas, sin auto-trading).

## Alcance inicial
- Activo: **BTC**. Exchange: **Binance** (fallback **Bybit**).
- Estilo: **intradía 15m** con contexto **1D / 4H / 1H**. (Semanal/mensual: fase posterior.)
- Estrategia: SMC del "Video 1" de *Trading Sin Edición* (ver `SMC-SPEC-VIDEO-1.md`).

## Definición de éxito
No "coincidir con mis marcas al 100 %". Sí:
- **Consistencia**: ante el mismo patrón, marca igual siempre.
- **Utilidad de decisión**: muestra zonas válidas que se me escapan y filtra ruido.
