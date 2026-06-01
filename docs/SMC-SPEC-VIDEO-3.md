# Especificación SMC — Video 3 (Trading Sin Edición) · "Breaker Block"

> Estado: **BORRADOR PROVISIONAL para co-validación** · 2026-05-31
> Fuente: transcripción del directo "Smart Money la estrategia — parte 3".
> Regla: nada marcado 🔴 se implementa con valores fijos hasta validarlo. Todo parametrizable.
> Decisión del usuario (2026-05-31): el Breaker Block entra como **capa VISUAL de estudio**, NO como
> generador de entradas (ver §4 y §10).

> **Lectura de una línea:** un Order Block que el precio **rompe con fuerza** no muere — se convierte
> en **Breaker Block (BB)**: sigue siendo POI, pero con la **función invertida**. Nuestro bot hoy hace
> lo contrario: descarta el OB roto. De ahí la incoherencia que el usuario detectó (§5).

## 1. Resumen operativo del video
- **Breaker Block (BB)** = *order block roto / order block en quiebre*. Es un OB que el mercado **no
  respetó** y atravesó con fuerza. Como sigue conteniendo liquidez, **sigue siendo punto de interés**.
- **Función invertida:** un OB de **compra** roto a la baja pasa a ser POI de **venta**; un OB de
  **venta** roto al alza pasa a POI de **compra**. El precio tiende a **regresar** al BB para tomar la
  liquidez acumulada y **continuar** en la dirección de la ruptura.
- **Encadenamiento:** si el precio rompe un POI de compra, el siguiente POI de compra por debajo es el
  próximo objetivo; si también lo rompe, el siguiente; y así sucesivamente.
- **Gestión (mostrada con el indicador "Breaker Block with signals" de LuxAlgo):** zona *Premium*
  donde nació el movimiento (referencia para el SL, por encima de ella), entrada en el BB (zona
  punteada), TP en el siguiente POI. Ejemplo del video: ≈3.19 % de SL y ≈6.73 % de recorrido a favor.
- **Indicadores:** el ponente presenta 4 indicadores de LuxAlgo (Breaker Blocks with signals; Order
  Blocks & Breaker Blocks; Market Structure Breakers; Breaker Blocks) + uno extra (Super Order Block /
  FVG / BOS). **Solo los menciona** y recomienda **NO depender de ellos** ("el día que desaparezcan no
  sabrás analizar"); critica que "ensucian el gráfico" con decenas de OBs/BBs.

## 2. Reglas NUEVAS detectadas
- **N1 — Breaker Block (OB roto = POI con función invertida).** Un OB `INVALIDATED` (roto con cierre
  más allá del borde, §8 SMC-SPEC) **no se descarta**: se reinterpreta como POI del lado contrario.
  → nueva Zone derivada en `SMC-SPEC §8`; nota en `ENTRY-EDGE`.
- **N2 — "Roto con fuerza" como condición.** No todo OB tocado es BB; el BB nace cuando el precio lo
  **atraviesa con cuerpo/impulso** (no solo lo mecha). Reusa la noción de `Impulse` (§1 SMC-SPEC).
- **N3 — Premium/Discount como ancla de gestión del BB.** El origen del movimiento (zona Premium para
  cortos / Discount para largos) define el SL del BB. Conecta con `ENTRY-EDGE §4` (premium/discount).
- **N4 — Vigencia/consumo del BB.** Un BB es relevante mientras el precio **no lo rompa de nuevo** en
  sentido contrario; si lo re-rompe, se "consume" y el siguiente POI pasa a ser el objetivo (N1 cadena).

## 3. Reglas que CONFIRMAN videos previos / la auditoría
- **El precio regresa a POIs importantes a tomar liquidez y continuar** → confirma `SMC-SPEC §6` y
  `§10` (TP a la siguiente liquidez/POI).
- **Marcar pocos y limpios; el humano decide los POIs importantes** → confirma la filosofía del
  proyecto ("pocos, claros, explicables") y el rechazo a clonar LuxAlgo.
- **OB = última vela contraria + impulso, con mechas** → idéntico a `SMC-SPEC §3` y al detector 5B.

## 4. Reglas que CONTRADICEN o MATIZAN (lo más importante de este video)
- **🔴 El BB casi NO aplica en cripto HOY — por boca del propio instructor.** Cita textual: *"yo no
  utilizo en el mercado cripto los Breaker blocks"*. Dice que en cripto se cumplen poquísimo
  (*"uno cada dos o tres meses"* vs varios por semana en mercados tradicionales: sp500, nasdaq, Tesla,
  Microsoft). Lo trae **solo por la creciente adopción institucional** (ETFs: BlackRock, JPMorgan,
  Morgan Stanley…) que haría que BTC se comporte más "tradicional" **en el futuro**: *"puede ser que
  en el futuro sí empiece a respetarla"*.
  → **Implicación para v2:** como **generador de entradas en BTC, el BB tiene bajo edge hoy.** Por eso
  la decisión es **capa de estudio, no señal** (§10). No sobre-vender este edge.
- **Matiz sobre densidad:** el instructor marca **solo los BB cercanos/relevantes**, no todos. Mostrar
  decenas de BB sería el "gráfico sucio" que él mismo critica. La capa BB debe ser **selectiva**.
- **Apalancamiento / "comprar la caída" / DCA:** comentarios de mercado del directo, **fuera de
  alcance** del copiloto (Regla Cero).

## 5. HALLAZGO: por qué nuestro bot estaba "ciego" cerca del precio (puente con la incoherencia)
El usuario observó que TradingView (con indicadores LuxAlgo) marca **muchos más OBs cerca del precio**
y que la única entrada del bot quedaba lejísimos (≈95k con BTC en ≈73k). Medición real (BTCUSDT 4h,
2026-05-31):
- El bot detecta **66 OBs**; **59 (89 %) están rotos** (`invalidated`/`mitigated`).
- `confluence.scorer` **excluye** los OBs rotos → no forman confluencia/setup/plan → **se descartan**.
- **18 de esos OBs rotos están a ≤5 % del precio**; solo **1 OB activo** está cerca.
- Por eso las únicas señales que sobreviven están lejos (zonas altas no rotas con cuerpo).

**Causa raíz = exactamente N1:** el bot trata el OB roto como basura (`INVALIDATED` → excluido), cuando
la estrategia dice que es un **Breaker Block** (POI con función invertida). Los ≈18 OBs rotos cercanos
son, en su mayoría, los Breaker Blocks que el usuario ve en TradingView y el bot no. Implementar la
capa BB **cierra ese hueco de cobertura** sin tocar la Regla Cero.

## 6. Cambios propuestos a `SMC-SPEC-VIDEO-1.md`
- **§8 (Mitigación/Invalidación):** añadir que un OB `INVALIDATED` por **ruptura con fuerza** no se
  elimina: genera una Zone derivada **`BreakerBlock`** con dirección invertida y `originObId`. La
  caducidad/consumo del BB sigue N4 (se invalida si el precio lo re-rompe en contra).
- **§3 (Order Block):** nota cruzada — el ciclo de vida del OB ahora tiene una "segunda vida" como BB.

## 7. Cambios propuestos a `ENTRY-EDGE-SPEC.md`
- **Tabla de objetos / Relación con SMC-SPEC:** el `BreakerBlock` es un **POI** más (como OB/FVG/
  liquidez), elegible para entrar en un Setup **con función invertida**. Pero por §4 (bajo edge en
  cripto) **no alimenta `SignalCandidate` por defecto**: es capa de estudio/contexto.
- **Máquina de estados:** un Setup `INVALIDATED` cuyo OB fue roto con fuerza **puede derivar** un nuevo
  POI `BreakerBlock` (no revive el Setup; nace una Zone nueva del lado contrario).

## 8. Qué queda PROVISIONAL 🔴
- Definición exacta de "roto con fuerza" para promover OB→BB (¿cierre más allá del borde + impulso
  N×media? ¿cuántas velas?). Reusar `Impulse` (§1) como base.
- Vigencia/consumo del BB (N4): cuántas velas vive, cuándo se considera re-roto y se descarta.
- Selección "pocos y limpios": cuántos BB mostrar, criterio de relevancia (frescura, cercanía,
  fuerza de la ruptura) para no ensuciar el gráfico.
- **Edge real del BB en cripto:** el propio video lo marca como bajo HOY. Cualquier uso como entrada
  exige medición (expectancy en R) antes de habilitarse — no se asume por el video.

## 9. Qué NO implementar todavía
- BB como fuente de `SignalCandidate` / entradas (confirmación o riesgo). Decisión del usuario: por
  ahora **solo visual**.
- Clonar indicadores de LuxAlgo (el video mismo desaconseja depender de ellos; `LuxAlgoReference` se
  puebla manual, no por algoritmo — ver `SMC-SPEC-VIDEO-1` capas).
- Órdenes, posiciones, balances, apalancamiento, ejecución. Regla Cero intacta.

## 10. Recomendación de implementación (capa VISUAL de Breaker Blocks)
Construir una capa **read-only** análoga a las demás capas del bot (FVG/OB/Liquidez/Confluencia):
- **Detector `breaker.detector.ts`:** a partir de los OBs ya detectados, promover los `INVALIDATED`
  (rotos con fuerza) a `BreakerBlock` con **dirección invertida**, `originObId`, y estado de vigencia
  (no re-roto). **Selectivo:** pocos, frescos, cercanos al precio (anti-ruido, como el resto).
- **Endpoint:** `GET /api/bot/breakers` (gated `DB_ENABLED`, solo velas cerradas, sin repaint).
- **Capa frontend:** toggle "Bot Breaker Blocks" (OFF por defecto), color/borde propio (distinto de
  OB activo), etiqueta `BB ▲/▼` con la **función invertida** explícita; inspector con: OB de origen,
  por qué se rompió, función invertida, "capa de estudio — no es señal operable (bajo edge en cripto
  según el propio video)".
- **NO** alimenta confluencia/setup/plan (decisión: estudio). Si en el futuro se mide edge, se reevalúa.
- Objetivo: que el bot **deje de estar ciego** cerca del precio y el usuario pueda **comparar** su
  lectura (y la de TradingView) contra la del bot, que es el propósito del copiloto.
