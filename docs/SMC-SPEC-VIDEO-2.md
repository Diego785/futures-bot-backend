# Especificación SMC — Video 2 (Trading Sin Edición) · "la entrada"

> Estado: **BORRADOR PROVISIONAL para co-validación** · 2026-05-31
> Fuente: transcripción del directo "Smart Money la estrategia — parte 2".
> Regla: nada marcado 🔴 se implementa con valores fijos hasta validarlo. Todo parametrizable.
> Habrá más videos (3, 4…) que afinarán/debatirán esta misma estrategia: versionar, no reescribir.

> **Lectura de una línea:** el Video 1 enseñó a DIBUJAR zonas; el Video 2 enseña a ENTRAR a ellas.
> Casi todo su aporte va a `ENTRY-EDGE-SPEC.md`, no a `SMC-SPEC-VIDEO-1.md`.

## 1. Resumen operativo del video
Sobre las zonas ya marcadas (OB/imbalance/liquidez del Video 1, top-down mensual→…→5m), el video
explica **cómo se entra**:
- **Dos tipos de entrada:** *por riesgo* (dejar la orden programada en la zona ANTES de que el
  precio llegue, sin esperar reacción) y *por confirmación* (esperar a que el precio llegue a la
  zona y **se forme un nuevo OB/reacción**, y entrar sobre esa confirmación).
- **3 niveles dentro de la zona:** alta (proximal/agresiva), media (el ponente la añade; la estrategia
  "oficial" usa solo bordes), baja (distal). Entrar en alta/media suele dar el movimiento 1:1.
- **Refinar el ingreso en TF menores:** marcar la zona en 1H, bajar a 15m y 5m para **afinar** la
  zona y apretar el SL → mejor R:R. **Trade-off explícito:** cuanto más refinas, mejor R:R pero
  **menor probabilidad** de que la entrada se ejecute. No bajar de 5m.
- **Gestión del riesgo y disciplina/paciencia:** órdenes programadas (no vivir pegado al gráfico);
  una entrada que **no se ejecuta no es ni ganancia ni pérdida**; no toda zona reacciona; backtesting.

## 2. Reglas NUEVAS detectadas
- **N1 — Entrada por riesgo vs por confirmación** (lo central). "Por riesgo" = entrar al toque sin
  confirmación (asumes el riesgo de que rompa). "Por confirmación" = esperar que se forme un OB nuevo
  en la zona → entrar ahí. → `ENTRY-EDGE §3` (`entryTriggerMode`).
- **N2 — Refinamiento multi-TF del ingreso** (1H → 15m → 5m): no cambia la zona estructural; afina
  el rectángulo de entrada para apretar SL y subir el R:R, a costa de menor probabilidad de fill.
  → nuevo `ENTRY-EDGE §12`.
- **N3 — Ciclo de vida de la entrada como SUGERENCIA programada:** una entrada candidata es una orden
  *pendiente* sugerida; si el precio no la alcanza, **expira sin P&L** (no es pérdida). → mapea a
  `EXPIRED` y al tracking (`resultR` vacío).
- **N4 — Vela de desplazamiento sin mechas = imbalance + OB juntos** (señal de impulso fuerte).
  Refinamiento menor de `SMC-SPEC §1/§3`.

## 3. Reglas que CONFIRMAN el Video 1 (y la auditoría)
- **OB = última vela de color contrario antes del impulso, con mechas** (idéntico; mostrado también
  en corto). → confirma `SMC-SPEC §3` y nuestro detector 5B.
- **3 entradas (alta/media/baja)** dentro de la zona. → confirma `SMC-SPEC §9`.
- **El precio busca liquidez** y retrocede a tomarla antes de continuar; **TP en la siguiente
  liquidez/POI**. → confirma `SMC-SPEC §6` y `§10`.
- **R:R se calcula, no se impone** (ejemplos 1:1 y refinados >2R). → confirma `ENTRY-EDGE §8`.
- **Top-down** mensual→semanal→…→5m. → confirma `SMC-SPEC §2`.
- **CLAVE — "nunca entrar al toque sin confirmación":** el video llama a entrar al toque
  "entrada por riesgo" y la contrasta con la "entrada por confirmación". Esto **valida de forma
  independiente el hallazgo #1 de la auditoría** (`ENTRY-EDGE §3`, "touch = legacy NO recomendado")
  y la lección del v1 (entrar al toque = adverse selection).

## 4. Reglas que CONTRADICEN o matizan
- **Matiz, no contradicción:** el video presenta "entrada por riesgo" (al toque) como una opción
  **válida** para perfiles arriesgados, no como error. Nosotros la mantenemos como modo posible pero
  **NO por defecto** (el default es confirmación), por la lección del v1.
- **SL "~0.5% al borde distal"** del Video 1: el Video 2 no lo desmiente, pero el refinamiento en LTF
  lo hace **aún más ajustado**. Mantenemos el matiz de la auditoría (`ENTRY-EDGE §9`): el buffer del
  SL debería ser función del ATR/ruido del TF, no un % fijo — el refinamiento ayuda pero no exime.
- **Apalancamiento 5x/10x:** es preferencia **personal y manual** del ponente, NO regla de estrategia.
  Fuera de alcance del copiloto (Regla Cero: no ejecutamos, no sugerimos apalancamiento).

## 5. Cambios propuestos a `SMC-SPEC-VIDEO-1.md`
Mínimos (el Video 2 es de entradas):
- §1 Impulso: añadir como señal de fuerza la **vela de desplazamiento de cuerpo completo / sin mechas**
  (deja imbalance y, junto con la vela contraria previa, el OB).
- §2/§9: confirmar **5m como piso de refinamiento** del ingreso (no bajar más para esta estrategia).
- Sin cambios a liquidez ni a confluencia (el Video 2 no los modifica; los **usa** como objetivo/contexto).

## 6. Cambios propuestos a `ENTRY-EDGE-SPEC.md`
- §3 (Trigger de confirmación): anotar el mapeo del Video 2 — `por riesgo` = `entryTriggerMode:'touch'`;
  `por confirmación` = esperar **un OB nuevo en la zona** → añadir modo `'confirmation_ob'` (definición
  más simple y directamente del video que `ltf_choch`). Default sigue siendo confirmación, no toque.
- Nuevo §12 — **Refinamiento multi-TF del ingreso** (zona estructural en HTF → entrada afinada en
  15m/5m; trade-off precisión↔probabilidad de fill; parámetros).
- Anotar ciclo de vida: entrada programada no alcanzada → `EXPIRED`, sin `resultR` (N3).

## 7. Qué queda PROVISIONAL 🔴
- Definición exacta de "confirmación" = ¿qué cuenta como "OB nuevo / reacción" en la zona? (tamaño,
  cierre, cuántas velas). El video es informal.
- TF y monto de refinamiento por TF de setup; cómo cuantificar el trade-off precisión↔fill.
- Umbral de R:R por defecto (el video usa 1:1 didáctico y refinados >2R; nosotros default 2.0 a validar).
- **NO cubierto por el Video 2** (siguen 🔴 y vienen de la AUDITORÍA, no de los videos): BOS/CHoCH
  formal, inducement, sweep-como-gatillo, premium/discount, filtro de régimen, killzones, noticias.
  El Video 2 **no** los menciona → 5E no debe asumir que están validados por el video.

## 8. Qué NO implementar todavía
- 5E Setup States (máquina WATCHING/MITIGATED/ARMED/TRIGGERED) — pendiente de tu OK tras revisar esto.
- Señales, Long/Short automático, Entry/SL/TP automático, break-even, journal, órdenes, posiciones,
  balances, apalancamiento. Regla Cero intacta.

## 9. Recomendación para 5E (Setup States)
Construir la máquina de estados **read-only / visual**, mapeando el Video 2:
- `WATCHING` = zona relevante (confluencia 5D / OB-POI) por delante del precio.
- `MITIGATED` = el precio toca/entra en la zona (ya lo calculamos para OB/FVG).
- `ARMED` = (modo confirmación) se forma un **OB nuevo / reacción** en la zona; (modo riesgo) basta
  la mitigación.
- `TRIGGERED` = confirmación completa → recién aquí nace una **SignalCandidate** (3 niveles + SL
  distal/refinado + TP a la siguiente liquidez), **etiquetada "sugerencia, no orden"**.
- **Default = `byConfirmation`** (NO al toque). Es la lección del v1 que el propio Video 2 respalda:
  el `byRisk` (al toque) queda como opción explícita de mayor riesgo, nunca como default.
- Empezar visual: pintar el estado de cada zona y, en `TRIGGERED`, una entrada *sugerida* editable
  por el usuario — sin ejecutar nada.
