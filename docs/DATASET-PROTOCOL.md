# Protocolo del golden dataset

> Estado: v1.0 · 2026-05-27
> Objetivo: validar el motor SMC **sin recrear el overfitting que hundió al v1**.
>
> **Aclaración clave (no imitación):** las marcas manuales del usuario **no** son el
> objetivo a copiar. El motor produce su **propia lectura SMC** desde la estrategia
> documentada (`SMC-SPEC-VIDEO-1.md`); este dataset sirve para **comparar y validar** esa
> lectura, no para que el bot imite las entradas del usuario. La "coincidencia" de abajo
> es una señal de comparación para el aprendizaje del usuario, no una orden de clonar.

## Los 4 conjuntos
| Conjunto | Uso | ¿Se toca al ajustar parámetros? |
|---|---|---|
| **Calibración** | Ajustar parámetros del detector | Sí |
| **Validación held-out** | ¿Generaliza a casos no vistos? | No |
| **Validación out-of-time** | ¿Funciona en fechas posteriores? | No |
| **Cuarentena** | Prueba final antes de "confiar más" | Casi nunca; solo al final |

**Regla de oro:** el motor NO aprueba por coincidir con el set de **calibración**.
Aprueba si **generaliza** en held-out / out-of-time.

## Cómo se capturan los casos
Desde el **visor mínimo** (Fase 4), marcando sobre datos reales — no pegando OHLCV a mano.
Cada marca se guarda en DB con su capa (`MyManualMarks`).

## Estructura de un caso
`símbolo` · `tf` · `rango (from/to)` · `OHLCV (ref)` · `tipo` · `zona esperada (high/low/timeStart/timeEnd)` · `notas`

`tipo` ∈ { `positivo`, `negativo`, `invalidación`, `timing` }

Cobertura mínima sugerida: 5 OB claros del video · 5 imbalance del video · 5 marcas tuyas ·
5 donde tú y LuxAlgo difieren · 5 donde **NO** debe marcar nada · varios de invalidación/timing.

## Métricas de aprobación (dos ejes)
1. **Coincidencia** (alineación): solapamiento de zona ≥ 60–70 %; precio medio dentro de X %;
   mismo `impulseId`; no genera zonas basura (precisión/recall).
2. **Utilidad** (valor real): ¿encuentra zonas válidas que el usuario pasó por alto? ¿filtra ruido?

Coincidencia mide alineación; utilidad mide valor. El motor no debe ser un clon ciego del ojo del
usuario, pero tampoco ir por libre.

## Reproducibilidad
Cada corrida registra `engineVersion` + `paramsHash`. Un resultado debe poder regenerarse idéntico.
