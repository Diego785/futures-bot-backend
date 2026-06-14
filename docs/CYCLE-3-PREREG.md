# Ciclo 3 — PRE-REGISTRO: gatillo D (sweep → CHoCH → entrada FVG)

> **Estado:** 🔴 PRE-REGISTRO para construir y correr — NADA mirado aún. Fecha: 2026-06-13.
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
