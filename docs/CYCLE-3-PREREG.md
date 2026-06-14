# Ciclo 3 — PRE-REGISTRO: gatillo D (sweep → CHoCH → entrada FVG)

> **Estado: ⬛ CERRADO (2026-06-13) — D NO supera al candidato. Por §4, el congelado va al paper TAL
> CUAL.** 3ª confirmación de que añadir capas SMC a esta mecanización la EMPEORA. Ver §7.
> Fecha pre-registro: 2026-06-13 (NADA mirado al fijarlo).
> Fuentes: `transcripts/VIDEO-EXTERNAL-BOSS-CHOCH.md` (2ª fuente SMC independiente) + el "por
> confirmación" del Video 2 (`SMC-SPEC-VIDEO-2.md`). Objetivo del usuario: **fortalecer el edge**
> (menos SL, mayor expectancy) — el último lever claramente motivado de las fuentes.
> **Regla de oro (la del v1):** este doc fija QUÉ/CÓMO/CUÁNDO antes de ver resultados. Gane o pierda,
> después de C3 se CONGELA y se pasa al paper-test — no más tuneo sobre el mismo histórico.

## 0. Motivación (la debilidad que ataca)

El candidato congelado (gatillo C) entra en el CE del sweep **sin esperar confirmación de reversión**
→ ~35 % de los trades cierran en SL (muchos sweeps no revierten). Las fuentes coinciden en un filtro:
tras el liquidity grab (sweep), **exigir un CHoCH** (cambio de carácter) antes de entrar, y entrar en
el **FVG** del desplazamiento (entrada precisa, stop corto, mejor R:R). C3 mecaniza eso como gatillo D.

> **Expectativa honesta (priores en contra, declarados):** el gatillo B (confirmación cruda) ya perdió
> contra el C una vez; el TP estructural ya falló en C2. La confirmación REDUCE el N por diseño. Doy
> ~40-50 % de que D supere al candidato. Y aunque gane, NO dará "meses verdes garantizados" — el estilo
> swing (~20 trades/mes) es de horizonte trimestral por matemática (señal/ruido mensual ≈ 0.4). El fin
> de C3 es un edge **más fuerte y robusto**, confirmable en ~2 meses en vez de 3 — no un milagro mensual.

## 1. El gatillo D — definición CAUSAL precisa (para el implementador)

Sobre velas 15m cerradas, filtrado por sesgo 4H (igual que el candidato). Para cada **sweep** (reusa
`detectSweeps`, gatillo C, swingLookback 10):

**Sweep alcista** (barrió un swing low, reclamó al alza → buscamos LONG), en la vela `s`:
1. **Nivel del CHoCH** = el último swing **high** CONFIRMADO en/antes de `s` (pivote `index+lookback ≤ s`).
   Es el "último lower high" del video.
2. **CHoCH** = la primera vela `b` en `(s, s+maxChochBars]` cuyo **cuerpo cierra por encima** de ese
   swing high (`close > nivel`). Si ninguna lo hace en la ventana → **sin trade** (el sweep no confirmó).
3. **FVG del desplazamiento** = el FVG estricto alcista (gap de 3 velas: `low[i+1] > high[i-1]`) MÁS
   RECIENTE dentro de `[s, b]` (la imbalance que dejó el impulso del CHoCH). Si no hay FVG → **sin trade**.
4. **Entrada** = CE (punto medio) del FVG `[high[i-1], low[i+1]]`. **SL** = borde inferior del FVG −
   buffer. **TP** = 2R (default robusto) | estructural (variante). cancelBeyond/invalidación como siempre.
5. **Causalidad:** la señal se conoce al CIERRE de `b` → `signalBarTime = b.openTime`; ejecución desde
   `b+1`. El nivel del CHoCH, el FVG y los precios quedan FIJADOS en su origen (cero lookahead).

**Sweep bajista** (SHORT): simétrico — CHoCH = cuerpo cierra por **debajo** del último swing **low**
confirmado; FVG estricto bajista (`high[i+1] < low[i-1]`); entrada CE; SL = borde superior del FVG +
buffer.

## 2. Parámetros: fijos por lógica vs ejes libres

**Fijos (NO se tunean — elegidos por lógica/consistencia con el candidato):**
| Parámetro | Valor | Origen |
|---|---|---|
| sweep / swingLookback | gatillo C, 10 | candidato congelado |
| `maxChochBars` | 15 (~3.75 h en 15m) | "reversión pronta" del video |
| FVG | estricto 3 velas, el más reciente del desplazamiento | definición estándar |
| entrada | CE del FVG | convención del proyecto |
| `slBuffer` | 0.1 × altura del FVG | consistencia |
| sesgo HTF | 4H (BOS por cuerpo) | candidato congelado |
| minStopPct, fees, cancelDist, BE 50 % | = candidato congelado | no se tocan |

**Ejes libres del C3 = SOLO 2** (todo lo demás fijado, lección del v1/C2):
1. **CHoCH:** OFF (= gatillo C, el benchmark) vs ON (= gatillo D).
2. **TP:** 2R | estructural.

→ La **decisión de reemplazo se basa en D + 2R** (el sustituto robusto probado 2×). D + estructural se
corre como side-experiment INFORMATIVO (no decide — evita cherry-picking de la combinación ganadora).

## 3. Protocolo de validación (idéntico a C2)

- **Calibración** 2022-01 → 2025-06; **held-out** 2025-06 → 2026-06 INTOCADO; **walk-forward** 12
  ventanas; **10 símbolos** (BTC/ETH/XRP/SOL/BNB/DOGE/ADA/LINK/AVAX/DOT — toda la evidencia disponible).
- Benchmark = candidato congelado (gatillo C + 2R) corrido en EXACTAMENTE el mismo dataset/ventanas.
- Toda corrida con `--register` (paramsHash + comando). Maneja `maxChochBars` como fijo; si la
  calibración mostrara sensibilidad fuerte, se elige SOBRE calibración y se valida en held-out (como
  `cancelDist` en su día) — jamás a ojo sobre todo el histórico.

## 4. Criterio de REEMPLAZO (pre-fijado; se juzga en held-out + walk-forward, NO en calibración)

D (con 2R) **reemplaza** al candidato congelado y va al paper SOLO si cumple TODO:
1. **Expectancy pooled (10 símbolos) ≥ candidato + 0.05R** (salto real: de ~+0.11R a ≥ +0.16R; el
   usuario pidió MÁS fuerte, no marginal).
2. **≥ 7 de 10 símbolos** pooled-positivo **y ningún símbolo < −0.05R** (robusto, no BTC-céntrico).
3. **SL-rate < 30 %** (vs ~35 % del candidato) — el mecanismo DEBE reducir los SL (el objetivo declarado).
4. **N ≥ 40 % del N del candidato** (la confirmación recorta N por diseño, pero no al punto de volverlo
   intesteable / demasiado lento para el paper).
5. **maxDD por símbolo ≤ 1.5× el del candidato.**

Si **no** cumple → el candidato congelado va al paper-test TAL CUAL (resultado válido; C3 se documenta
y cierra). Si cumple → D se congela, se re-registran las corridas canónicas, se actualiza
`frozen-candidate.ts` y el gate corre con D (mismos términos: 10 símbolos, N≥50, paridad).

## 5. Fuera de alcance (no se mecaniza en C3)
TP estructural como default (solo side-experiment) · refinamiento multi-TF 5m · premium/discount ·
inducement · killzones · parciales (ninguna fuente los trae). Cada uno exigiría su propio ciclo.

## 6. Slices
- **C3.a/b** — CHoCH+FVG en `signal-source` (gatillo D) + tests causales + sanity en datos reales.
- **C3.c** — calibración (D+2R, D+estructural, benchmark C+2R) × 10 símbolos, registradas.
- **C3.d** — held-out + walk-forward + veredicto contra §4.
- **C3.e** — si reemplaza: congelar D, re-registrar canónicas, actualizar el paper; si no, el candidato
  sigue. **En ambos casos: STOP tuneo → paper-test.**

## 7. RESULTADOS (2026-06-13) — D NO supera al candidato (screening full-history, 10 símbolos)

**totalR / N / SL-rate por símbolo:**

| símbolo | C+2R (benchmark) | D+2R | D+estructural |
|---|---|---|---|
| BTC | +37.0 / 112 / 24 % | +3.8 / 35 / 43 % | +2.1 / 34 / 62 % |
| ETH | +1.3 / 192 / 41 % | −1.6 / 44 / 50 % | −15.0 / 42 / 62 % |
| XRP | +30.5 / 176 / 34 % | −3.6 / 34 / 38 % | −8.9 / 33 / 64 % |
| SOL | +32.1 / 247 / 35 % | +15.1 / 49 / 35 % | +1.9 / 49 / 61 % |
| BNB | +8.9 / 100 / 25 % | −11.8 / 33 / 52 % | −9.5 / 32 / 62 % |
| DOGE | +41.9 / 220 / 36 % | +5.7 / 44 / 41 % | −1.4 / 41 / 61 % |
| ADA | +33.0 / 222 / 33 % | −7.8 / 40 / 48 % | −16.4 / 40 / 72 % |
| LINK | +32.5 / 243 / 33 % | +4.7 / 49 / 43 % | +9.7 / 47 / 72 % |
| AVAX | +1.2 / 248 / 38 % | −2.0 / 54 / 41 % | −5.5 / 52 / 65 % |
| DOT | −4.8 / 208 / 38 % | +4.5 / 36 / 36 % | −17.8 / 36 / 58 % |
| **Σ** | **+213.6 / 1968 / pooled +0.109R · 9/10 pos** | **+7.1 / 418 / pooled +0.017R · 5/10 pos** | **≈ −60.6 / 405 · negativo** |

**Veredicto contra §4 — D+2R FALLA en todos los gates:**
1. Expectancy ≥ candidato + 0.05R? **NO** (+0.017R vs +0.109R — 6× más débil). ✗
2. ≥7/10 positivo y ninguno < −0.05R? **NO** (5/10; BNB −0.36R, ADA −0.19R). ✗
3. SL-rate < 30 %? **NO** — D la SUBE (40-52 % en la mayoría) en vez de bajarla. ✗ (lo contrario del objetivo)
4. N ≥ 40 % del candidato? **NO** (418 = 21 % de 1968). ✗
> D+estructural aún peor (≈ −60.6R). El screening full-history (incluye held-out) es tan inequívoco
> que el split formal sería teatro: no hay escenario donde el held-out revierta una brecha de 6× en
> expectancy + 5/10 robustez.

**Diagnóstico (importante):** la confirmación CHoCH SÍ sube algo el win-rate (BTC 48→51 %), pero:
(a) el stop ajustado al FVG lo barre el ruido MÁS seguido → SL-rate SUBE, no baja; (b) exigir
CHoCH+FVG filtra ~80 % de los trades y los que sobreviven NO son de mejor calidad, solo más tardíos
y con stop más fino. **3ª confirmación del mismo patrón:** gatillo B perdió contra C (rejilla original);
C2 (estructural/pools) perdió; ahora C3 (CHoCH/FVG) pierde. **El sweep+reclaim crudo con 2R+BE es el
óptimo ROBUSTO** — cada capa "de libro" que añadimos (confirmación, TP estructural, pools, CHoCH, FVG)
RESTA. La discrecionalidad de los videos (elegir el CHoCH/FVG/target bueno con el ojo) no mecaniza en
mejora; mecanizada ingenuamente, daña.

**Decisión (§4, automática): el candidato CONGELADO va al gate #7 TAL CUAL. STOP tuneo.** El gatillo D
queda como herramienta (`--gatillo D`), no default. No se prueban más variantes ad-hoc (= data-dredging);
un eventual hito futuro (p. ej. una capa discrecional asistida) exigiría su propio pre-registro y, sobre
todo, iría DESPUÉS del paper-test. La lección rectora: la mecanización simple es la robusta.
