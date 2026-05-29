# Especificación de la capa de ENTRADA (donde vive el edge)

> Estado: **BORRADOR PROVISIONAL para co-validación** · 2026-05-29
> Complementa `SMC-SPEC-VIDEO-1.md` (que define cómo se DIBUJAN las zonas).
> Regla: nada marcado 🔴 se implementa con valores fijos hasta validarlo. Todo parametrizable.

## Por qué existe este documento

La auditoría multi-perspectiva (2026-05-28) encontró el riesgo #1 del proyecto:
**`SMC-SPEC-VIDEO-1.md` define muy bien cómo dibujar zonas, pero colapsa "zona" con "entrada"**
(entrar al toque del OB). Eso es *adverse selection* — exactamente lo que hundió al v1
("only filled when price BROKE the zone = bad trades").

> Un Order Block es una **zona de interés**. Una entrada es una **decisión bajo condiciones
> específicas**. No son lo mismo. El edge en SMC no vive en dibujar el OB (eso lo hace cualquiera,
> incluido LuxAlgo): vive en **cuándo**, **dónde** y **bajo qué confirmación** entras a esa zona.

Las zonas se siguen dibujando con TODO el rigor de `SMC-SPEC` — eso cumple el objetivo de "marcar
bien" y de enseñar al usuario a leer el mercado. Pero **"entrada sugerida" es un objeto distinto**,
que solo nace cuando se cumplen condiciones de edge. Este documento define esa capa.

## Separación conceptual (4 objetos distintos)

| Objeto | Qué es | Quién lo produce | Doc |
|---|---|---|---|
| **Zone** | POI dibujado (OB / VideoImbalance / StrictFVG / Liquidity) | detector de zonas | `SMC-SPEC` |
| **Setup** | una Zone que el motor está *vigilando* como posible operación, con su ciclo de vida | máquina de estados | este doc |
| **EntryTrigger** | el evento de confirmación que arma el gatillo dentro del Setup | detector de trigger | este doc |
| **SignalCandidate** | la entrada sugerida (entradas/SL/TP/R:R) — **solo existe si el Setup llegó a TRIGGERED** | emisor de señal | `API-CONTRACT` |

**Regla de oro:** una Zone marcada en el gráfico **NO** es una señal. Solo un Setup en estado
`TRIGGERED` produce una `SignalCandidate` que se muestra como "entrada sugerida".

## Máquina de estados de la SEÑAL

```
   ┌──────────┐   precio entra    ┌───────────┐   gates de edge OK    ┌────────┐
   │ WATCHING │ ─── a la zona ──► │ MITIGATED │ ──────────────────►  │ ARMED  │
   └──────────┘                   └───────────┘                       └────┬───┘
        │                               │                                  │ confirmación LTF
        │ zona inválida / caduca        │ zona inválida                    ▼
        ▼                               ▼                            ┌───────────┐
   ┌──────────────┐ ◄─────────────────────────────────────────────  │ TRIGGERED │
   │ INVALIDATED  │            invalidación en cualquier punto        └─────┬─────┘
   │  / EXPIRED   │                                                         │ emite
   └──────────────┘                                                        ▼
                                                              ┌──────────────────────┐
                                                              │  SignalCandidate      │
                                                              │ (entrada sugerida)    │
                                                              └──────────────────────┘
```

**Transiciones (provisional `VideoSMC`):**

| De → A | Condición |
|---|---|
| `WATCHING → MITIGATED` | el precio toca/entra en la Zone (según `MitigationStatus` de `SMC-SPEC §8`) |
| `MITIGATED → ARMED` | **todos** los gates de edge habilitados pasan (ver abajo): HTF alineado + (sweep o inducement barrido) + premium/discount correcto + régimen OK + (killzone si se exige) |
| `ARMED → TRIGGERED` | aparece **confirmación en LTF** (CHoCH / vela de rechazo / desplazamiento) — §3 |
| `TRIGGERED → (emite SignalCandidate)` | se calculan las 3 entradas, SL, TPs y R:R; si ningún TP cumple `minRiskReward`, se marca `minRrMet=false` |
| `* → INVALIDATED` | CHoCH HTF en contra / zona atravesada / cambio de bias (§8 SMC-SPEC) |
| `* → EXPIRED` | caduca por antigüedad (`setupMaxAgeBars`) sin llegar a TRIGGERED |

> Implementación incremental permitida: al principio el motor puede implementar solo
> `WATCHING → MITIGATED` y dejar los gates como *flags informativos* (no bloqueantes), pero el
> **contrato y los estados nacen completos** para no migrar después. Lo que NO se permite es
> emitir `SignalCandidate` sin pasar por `TRIGGERED`.

---

## Componentes de edge (cada uno provisional + configurable)

Cada gate produce un booleano causal (evaluado solo con velas `t ≤` su timestamp; ver
`NO-REPAINT-RULES.md`) y alimenta tanto la transición `MITIGATED → ARMED` como el `ConfluenceScorer`.

### 1. Sesgo HTF vinculante
**Por qué:** operar un OB contra la tendencia de 1H/4H sin razón es perder sistemáticamente.
**Regla provisional:** la dirección del Setup debe coincidir con el bias de `htfBiasTimeframes`.
```ts
requireHtfAlignment: boolean      // default TRUE para señales operables
htfBiasTimeframes: Timeframe[]    // default ['4h','1h'] (contexto '1d')
```
🔴 ¿Contra-bias permitido solo si hubo sweep claro y marcado como menor calidad?

### 2. Barrido de liquidez (sweep) como GATILLO — no solo como TP
**Por qué:** el agujero de edge #1. En `SMC-SPEC §6` la liquidez es solo objetivo (TP). Pero el
setup A+ es **sweep de liquidez → desplazamiento → mitigación del OB → entrada**. La liquidez es,
sobre todo, el **gatillo**.
**Regla provisional:** antes de (o al llegar a) la zona se barrió un pool (equalHighs/Lows, swing) y
el precio **cerró de vuelta** del lado correcto.
```ts
requireSweepBeforeEntry: boolean  // default TRUE para A+
sweepLookbackBars: number
sweepClosesBackInside: boolean    // 'swept' = mecha barre Y cierre vuelve dentro
```
🔴 ¿Sweep obligatorio o factor de calidad? Resuelve el 🔴 abierto de `SMC-SPEC §6` ('swept').

### 3. Trigger de confirmación en LTF
**Por qué:** **nunca entrar al toque.** Esperar que el precio *reaccione* dentro de la zona.
**Regla provisional:** tras `MITIGATED`, esperar confirmación en TF inferior.
```ts
entryTriggerMode: 'ltf_choch' | 'rejection_close' | 'displacement' | 'touch'
                                  // default 'ltf_choch'; 'touch' = legacy NO recomendado
triggerTimeframe: Timeframe       // p.ej. '5m'/'1m' relativo al TF del setup
triggerLookback: number
rejectionBodyPct: number          // para 'rejection_close'
```
🔴 Qué TF de trigger por TF de setup; definición exacta del CHoCH de confirmación.

### 4. Premium / Discount (equilibrium 50%)
**Por qué:** pilar de SMC hoy **ausente**. No comprar en premium, no vender en discount.
**Regla provisional:** calcular el *dealing range* vigente (último swing high/low estructural del TF
de bias) y su 50%. Long solo en discount (<50%), short solo en premium (>50%) por defecto.
```ts
premiumDiscountFilter: boolean    // default TRUE
equilibriumSource: 'last_structural_range'
```
🔴 Qué swing define el rango por TF; tolerancia alrededor del 50%.

### 5. Inducement (IDM)
**Por qué:** antes de un OB válido casi siempre hay un mini-pool de liquidez (inducement) que debe
barrerse primero. Sin modelarlo, el motor marca el OB equivocado (el primero, no el válido).
**Regla provisional:** detectar el pool menor entre el origen del impulso y el OB; exigir
`inducementSwept=true` antes de validar la entrada.
```ts
detectInducement: boolean         // default TRUE
inducementMaxBars: number
```
🔴 Definición precisa del pool de inducement; ¿obligatorio o factor de calidad?

### 6. Filtro de régimen (trending vs ranging)
**Por qué:** SMC funciona en mercado direccional; en rango (el "mercado aburrido" del propio video)
genera señales falsas constantes.
**Regla provisional:** detector de régimen que **suprime o degrada** señales en lateralidad.
```ts
regimeMode: 'range_atr_ratio' | 'structure_sequence' | 'off'
rangingSuppressesSignals: boolean // default TRUE (suprime), o degrada el score
```
🔴 Métrica exacta de régimen y umbral.

### 7. Killzones / sesiones
**Por qué:** SMC intradía 15m vive de Londres / NY. Un OB a las 3am en sesión asiática es ruido.
**Regla provisional:** ventanas horarias en UTC; cada señal lleva `session` e `inKillzone`.
```ts
sessions: { london:[h,h], nyAM:[h,h], ny:[h,h] }   // UTC
onlyTradeKillzones: boolean        // default FALSE para detección; TRUE recomendado para señales 15m
```
🔴 Ventanas exactas en UTC; ¿filtro duro o factor de score?

### 8. R:R mínimo
**Por qué:** "R:R calculado, nunca impuesto" es la trampa: con TP a la liquidez más cercana tendrás
trades sub-1R → expectativa negativa. El R:R se calcula, pero debe existir un **umbral de aceptación**.
```ts
minRiskReward: number             // default 2.0 — señales bajo el mínimo se marcan no-operables
```
🔴 Default exacto; ¿descartar o solo marcar `minRrMet=false`?

### 9. SL relativo a ATR (no % fijo)
**Por qué:** el "~0.5% al borde distal" del video es arbitrario; el ruido normal de BTC 15m lo barre.
**Regla provisional:** buffer del SL como función del ATR del TF.
```ts
slBufferAtrMult: number           // default ~0.3–0.5 (reemplaza el % fijo de SMC-SPEC §10)
```
🔴 Default por TF; valida contra los casos `timing` del dataset.

### 10. Tracking de expectancy (en R)
**Por qué:** sin medir R ganados/perdidos nunca sabrás si hay edge — el error exacto del v1.
**Regla provisional:** cada `SignalCandidate` persiste `plannedR` y, al resolverse, `resultR` y
`outcome` (TP/SL/BE/parcial). Métrica = `expectancy = winRate*avgWin_R − lossRate*avgLoss_R`,
**segmentada** por `inKillzone`, `htfAligned`, `liquiditySwept` y banda de `confluenceScore`.
```ts
// se mide sin ejecutar: el usuario opera manual, pero el motor registra el outcome hipotético
plannedR: number
resultR?: number
outcome?: 'TP'|'SL'|'BE'|'PARTIAL'|'OPEN'
```
🔴 Cómo se resuelve el outcome cuando el usuario edita la entrada manualmente.

### 11. Ventanas de noticias
**Por qué:** una entrada SMC perfecta muere en un spike de FOMC/CPI.
**Regla provisional:** ventanas configurables; señales en blackout se marcan `tradableNews=false`.
```ts
newsBlackoutWindows: {from:number,to:number}[]   // epoch ms UTC
```
🔴 Fuente del calendario (manual al inicio).

---

## Relación con `SMC-SPEC-VIDEO-1.md`

- `SMC-SPEC` (zonas) **no cambia su rigor**: sigue dibujando OB/imbalance/liquidez/confluencia con
  causalidad. Esa capa es el "cartógrafo" — valiosa para enseñar y para marcar bien.
- Este doc añade la capa de **decisión**. El `ConfluenceScorer` de `SMC-SPEC §7` se extiende con
  criterios de EDGE (peso alto): `sweptLiquidityBeforeZone`, `htfAligned`, `inCorrectPremiumDiscount`,
  `inducementSwept`, `inKillzone` — que deben pesar **más** que los geométricos.
- `SMC-SPEC §9` (3 entradas) y `§10` (SL/TP/BE) **solo se calculan en estado `TRIGGERED`**.

## Lo que este documento NO hace (gate)

- ❌ No implementa motor, detectores ni señales (eso es Fase 6-7).
- ❌ No define ejecución de órdenes — sigue siendo copiloto puro (Regla Cero, `SAFETY-V2`).
- Los defaults 🔴 se **calibran** marcando casos en el visor (Fase 4-5). Pero la **estructura**
  (estados + qué gates existen) se decide AQUÍ, no en el visor: marcar 50 OBs nunca revela que
  falta un trigger de confirmación.
