# Ciclo 2 — PRE-REGISTRO de la re-mecanización (TP estructural · BE fiel · pools de liquidez)

> **Estado: ⬛ CERRADO (2026-06-11) — resultado NEGATIVO-INFORMATIVO, ver §8.** Ninguna combinación
> superó al candidato congelado en calibración multi-símbolo → según §5, **el candidato actual sigue
> vigente y pasa al paper-test tal cual**. El código del C2 (`--tp structural`, `--pools`) queda como
> herramienta de investigación, NO default. Pre-registrado el 2026-06-10 y ejecutado SIN cambiar
> criterios a mitad.
> Fuente primaria: `transcripts/VIDEO-1-TRANSCRIPT.md` (aportada por el usuario)
> + auditoría visual del usuario en el visor + datos de la revisión independiente.
> **Regla de oro:** este documento fija QUÉ se prueba, CÓMO se valida y CUÁNDO se reemplaza el
> candidato actual — ANTES de mirar un solo resultado. Cambiar estos criterios a mitad = overfit.

## 0. Por qué un Ciclo 2 (y por qué NO es "tunear el candidato")

La auditoría visual del usuario detectó que el candidato actual no representa la gestión que
enseña el video: **44 % de los trades muere en break-even** y el TP de 2R "no deja correr el
precio". La transcripción del Video 1 lo confirma con las palabras del mentor (§1). El Ciclo 2
re-mecaniza la GESTIÓN para que sea fiel a la fuente — y eso produce un **candidato NUEVO** que
debe pasar el protocolo anti-overfit completo contra el actual como benchmark. El candidato
actual sigue CONGELADO y vigente hasta que (y solo si) el C2 lo supera bajo los criterios de §5.

## 1. Lo que la transcripción CONFIRMA de la mecanización actual (citas)

| Regla mecanizada | Cita del video | Veredicto |
|---|---|---|
| OB = última vela contraria, con mechas, anclado a estructura | *"marcamos la última vela bajista de este punto"*, *"incluyendo las mechas"*, *"si la estructura es alcista buscamos POIs en la parte baja"* | ✓ fiel |
| Gate de fuerza ("equipara" → descartar) | *"esta vela roja EQUIPARA la vela que abre al lado… allí no hay la fuerza. Aquí sí"* | ✓ fiel |
| Entrada en el CENTRO de la zona (CE) | *"yo siempre tiendo a marcar la parte central porque trato de operar en la parte central"* (de las 3 entradas: alta/central/baja; *"la tercera muy poco tiende a cumplirse"*) | ✓ fiel |
| SL al distal de la zona | *"trataría de colocar mi stop loss acá en la parte baja"* | ✓ fiel |
| Stops apretados ~0.5 % | *"en ese punto que yo estoy colocando el stop loss me queda un 0.50 %"* | ✓ **valida `minStopPct` 0.3 % como piso** (y los datos: sin él −3.3R) |
| BE = mover SL a la entrada al 50 % del recorrido | *"cuando el precio va a LA MITAD DE ESTE RECORRIDO… agarro el stop loss y lo coloco aquí arriba, precio de entrada… y me voy a dormir"* | ✓ la REGLA es fiel — el **denominador** no (ver §2) |
| Confluencia OB+imbalance pesa más | *"el punto de interés ahora no lo genera solo el order block sino el order block más el imbalance"* | ✓ (capa de confluencia; no en el gatillo C aún) |
| Sin régimen lateral | *"cuando usted no ve fuerza… mercado aburrido, lateralizado… no hay ninguna institución operando"* | (pendiente de mecanizar; fuera del C2 — §6) |

**Hallazgo importante:** `SMC-SPEC-VIDEO-1.md` §10 ya decía "TP en la siguiente liquidez/POI" y
"BE a mitad del recorrido" — **los specs eran fieles**. La desviación nació en el DISEÑO DEL
BACKTEST (`SMC-STRATEGY-MECHANICAL` §6): el eje "TP: R-fijo (2R) | liquidez" eligió 2R porque la
mecanización del TP-liquidez era pobre (targets lejanos sin cap de POI → DD 22-43R), y el BE al
50 % quedó atado a ese 2R sintético → BE hiperactivo. El C2 corrige la mecanización, no la spec.

## 2. Lo que la transcripción CORRIGE (las 2 piezas del C2)

### Corrección A — TP ESTRUCTURAL (el target del video es el POI opuesto más cercano)
> *"mi take profit está acá en este punto EN LA PARTE ALTA [el order block opuesto]… porque aquí
> hay un order block en la parte alta. Si el precio reacciona aquí y yo sigo esperando el precio
> hasta aquí arriba, lo que me estoy arriesgando es a que el precio no llegue, empiece a
> retroceder y pierda mi entrada."*

El TP del método = **el primer POI/liquidez OPUESTO vigente** (conservador: salir antes de que el
precio reaccione contra ti en el siguiente punto de interés). NO un múltiplo R fijo. El R:R
**resulta** (en el ejemplo del video: riesgo 0.50 % → ganancia 2.50 % = 5:1), nunca se impone.

### Corrección B — BE fiel = 50 % del recorrido AL TARGET ESTRUCTURAL
La regla "mitad del recorrido" estaba bien implementada, pero la mitad de 2R (=+1R de avance) se
alcanza constantemente → 44 % de BEs. Con el TP estructural (más lejano en promedio), el MISMO
50 % se arma mucho más tarde en términos de R → menos BEs, sin tocar el simulador (el BE ya se
calcula sobre el TP del intent). **La tasa de BE debe BAJAR — métrica explícita del C2 (§5).**

### (Datos previos que enmarcan, de la revisión 2026-06-10)
- BE on/off (con HTF, dataset completo): BTC +0.330/+0.313 · ETH +0.013/−0.024 · XRP +0.163/+0.103
  · SOL +0.131/+0.067 · BNB +0.089/−0.119. El BE aporta poco en media pero **recorta el maxDD a la
  mitad** y sostiene a ETH/BNB → no se elimina: se re-ancla (Corrección B).
- `minStopPct` no se toca: sin él −3.299R (0/12 ventanas); a la mitad, marginal negativa.

## 3. Los DOS ejes del C2 (y solo estos)

**Eje 1 · `tpRule: 'structural'`** — al cierre de la vela de señal, candidatos de target en la
dirección del trade (todo CAUSAL, conocido a la señal):
- (a) **OB opuesto** más cercano: confirmado (`confirmedAtTime ≤ señal`) y NO invalidado a la
  señal (vía `computeStateTimeline`). Target = su **borde proximal** (donde reacciona primero).
- (b) **Liquidez opuesta** más cercana no barrida (equal highs/lows y swings confirmados — la
  lógica causal de `nearestLiquidityTp` actual).
- TP = el MÁS CERCANO entre (a) y (b) más allá del entry. `minRr` 1.0 se mantiene (target
  demasiado cerca → señal descartada, reason `minRr`). **Sin candidato** → fallback a 2R fijo,
  marcado en el intent (`tpSource: 'fallbackFixedR'`) y contabilizado.
- SIN cap de distancia en el núcleo (fidelidad al video: "el más cercano" ya es el cap natural;
  la diferencia vs el TP-liquidez fallido de Fase D es que los OBs opuestos densifican los
  targets cercanos y el BE al 50 % protege el recorrido).

**Eje 2 · `poolMode: 'pools'`** — el sweep barre POOLS vigentes, no solo el último swing:
- (a) **equal highs/lows**: clusters de ≥2 pivotes (lookback 10) dentro de tolerancia 0.1 %,
  no barridos. Nivel del pool = extremo del cluster.
- (b) **swings confirmados individuales NO barridos** (todos los vigentes, no solo el último).
- Sweep válido = mecha cruza el nivel && cuerpo cierra de vuelta (igual que hoy); cada pool se
  barre UNA vez; zona de reacción = [extremo de mecha ↔ nivel del pool]. Subsume el detector
  actual (⇒ más señales, con zonas más grandes que pasan `minStopPct` por naturaleza).

**Espacio de búsqueda = 4 combinaciones** (off/off = candidato actual = benchmark · solo Eje 1 ·
solo Eje 2 · ambos). Nada más se varía: cancelDist 3, swing 10, slBuffer 0.1, minStop 0.3 %,
maker/taker, HTF 4H y BE 50 % quedan FIJOS del candidato congelado.

## 4. Protocolo de validación (idéntico en espíritu al original)

1. **Calibración:** 2022-01 → 2025-06 (mismo split que Fase E). Se corren las 4 combinaciones en
   los 5 símbolos. Se elige UNA combinación (la de mejor pooled con estabilidad aceptable) —
   decisión SOLO con datos de calibración.
2. **Held-out intocado:** 2025-06 → 2026-06. La combinación elegida se corre UNA vez. Sin ajustes
   posteriores (si decepciona, se reporta tal cual).
3. **Walk-forward 12 ventanas** sobre 2022-2026 completo (estabilidad, criterio #5 ≥70 %... se
   reporta; el juicio principal es §5).
4. **5 símbolos** (BTC/ETH/XRP/SOL/BNB) en todo el proceso; el agregado manda (no cherry-pickear
   el mejor símbolo — lección del htf2).
5. Toda corrida se registra con `--register` (paramsHash + comando) — nada de números a mano.

## 5. Criterio de REEMPLAZO (pre-registrado — se juzga en held-out + walk-forward, NO en calibración)

El C2-candidato **reemplaza** al actual y hereda su lugar en el gate #7 si cumple TODO:
1. **Pooled 5 símbolos ≥ actual + 0.03R** (actual: ≈ +0.13R pooled, N=822).
2. **TotalR 5 símbolos ≥ el del actual** (≈ +109R) — la expectancy no puede "mejorar" matando N.
3. **Ningún símbolo < −0.05R pooled.**
4. **Tasa de BE < 30 %** (actual: 44 % — el objetivo declarado del C2).
5. **maxDD por símbolo ≤ 1.5× el del actual** (el BE re-anclado no puede disparar la varianza).

Si NINGUNA combinación cumple → **el candidato actual sigue vigente y va al paper-test tal cual**
(resultado válido; el C2 se documenta y se cierra). Si cumple → el C2 se CONGELA, se re-registran
las corridas canónicas y el gate #7 corre con él (mismos términos: N≥50, 5 símbolos, paridad).

## 6. Fuera de alcance del C2 (cada uno exigiría su propio ciclo)
Parciales TP1/TP2 (el Video 1 usa UN target; esperar transcripción del Video 2 antes de
pre-registrar parciales) · inducement · premium/discount · killzones · filtro de régimen
ATR/lateralidad · multi-TF completo (POI HTF + gatillo LTF) · Breaker como señal.

## 7. Plan de slices (cada uno: build + tests + aprobación)
- **C2.a** — detector de pools (`pools` en `sweep.detector` o módulo propio) + tests causales
  (cluster, no-barrido, un-barrido-por-pool, causalidad del pivote).
- **C2.b** — `tpRule:'structural'` en `signal-source` (OB opuesto causal vía timeline + liquidez
  causal existente; `tpSource` en el intent) + tests.
- **C2.c** — flags CLI (`--tp structural`, `--pools`) + corridas de CALIBRACIÓN (4 combos × 5
  símbolos, registradas) → elección de la combinación.
- **C2.d** — held-out + walk-forward + veredicto contra §5 → decisión de reemplazo.
- **C2.e** — si reemplaza: visor muestra el target estructural (qué POI es el TP) en el porqué
  causal; corridas canónicas re-registradas; docs actualizados.

## 8. RESULTADOS (2026-06-11) — calibración 2022-01→2025-06, 4 combos × 5 símbolos (20 corridas registradas)

**totalR por símbolo (single-run, mismos params congelados + HTF 4H):**

| combinación | BTC | ETH | XRP | SOL | BNB | **Σ totalR** |
|---|---|---|---|---|---|---|
| **base (candidato actual)** | +34.5 | −0.6 | +21.1 | +28.7 | +5.4 | **+89.1** |
| TP estructural | **+51.2** | −6.1 | **−37.6** | −5.5 | −17.1 | **−15.1** |
| pools | −11.7 | −12.1 | −25.8 | +8.2 | +1.7 | **−39.7** |
| estructural + pools | −27.3 | −49.1 | −95.3 | +34.0 | −22.2 | **−159.9** |

> - **La elección de calibración (§4) es LA BASE** — ninguna combinación C2 se acerca siquiera.
>   No procede held-out del C2 (no hay candidato C2 que validar). Aplica §5: el actual sigue.
> - **El TP estructural en BTC era una sirena** (+51.2R, BE-rate 44 %→25 % — el objetivo del usuario
>   cumplido EN BTC) pero **se derrumba fuera** (XRP −37.6, BNB −17.1): el patrón "positivo aislado
>   en BTC" — la misma firma del overfit que la Fase F ya enseñó. WR se desploma a 24-32 % en todos.
> - **Diagnóstico:** el target estructural mecánico-ingenuo ("el POI opuesto MÁS CERCANO") no captura
>   la pieza DISCRECIONAL del método — el mentor elige el POI *importante* (fuerza, frescura,
>   confluencia), no el más cercano. Sin ese juicio, la calidad del target es aleatoria: el WR cae
>   más de lo que los ganadores grandes compensan. Es la 2ª vez que el TP-por-niveles pierde contra
>   2R (Fase D con liquidez; ahora con OBs opuestos + timeline causal) → ya no es "mala mecanización":
>   **el 2R fijo es un sustituto ROBUSTO de la discrecionalidad del target, y multi-símbolo.**
> - **Los pools EMPEORAN y además reducen N** (BTC 97 señales vs 149): la regla "muere al cruce" +
>   "el más profundo reclamado" produce zonas de entrada más profundas en mechas largas (adverse
>   selection) y mata niveles que el modo lastSwing re-barría con éxito. Hipótesis "pools = más y
>   mejores entradas" = **refutada**.
> - **Disciplina:** no se prueban variantes extra del structural (cap de distancia, scoring del POI…)
>   — sería el data-dredging que este doc prohíbe. Un eventual C3 (p. ej. scoring de POIs) exigiría
>   su propio pre-registro, y la recomendación es correr ANTES el paper-test del candidato congelado:
>   cada ciclo adicional sobre el mismo histórico erosiona la frescura del held-out.
> - **Decisión (§5, automática): el candidato congelado va al gate #7 (paper-test) tal cual.**
>   La fidelidad-al-video del usuario era correcta como diagnóstico (el BE hiperactivo ES infiel);
>   la mecanización fiel resultó inferior al sustituto robusto. La lectura discrecional del POI
>   pertenece al journal del copiloto (humano vs máquina), no al motor mecánico.
