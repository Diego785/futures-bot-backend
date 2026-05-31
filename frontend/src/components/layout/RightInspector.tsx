import type { Candle } from '../../features/candles/candles.types';
import {
  isZoneKind,
  isPlanKind,
  computeRR,
  MARK_COLORS,
  REVIEW_STATUSES,
  STATUS_LABELS,
  STATUS_COLORS,
  type ManualMark,
} from '../../features/manual-marks/manualMarks.types';
import {
  FVG_COLORS,
  FVG_STATE_LABELS,
  type BotFvg,
} from '../../features/bot-analysis/botFvg.types';
import {
  OB_COLORS,
  OB_STATE_LABELS,
  type BotOb,
} from '../../features/bot-analysis/botOb.types';
import {
  LIQ_COLOR,
  LIQ_TYPE_LABELS,
  type BotLiquidity,
} from '../../features/bot-analysis/botLiquidity.types';
import { CONF_DIR_COLORS, type ConfluenceZone } from '../../features/bot-analysis/botConfluence.types';
import {
  SETUP_DIR_COLORS,
  SETUP_STATE_LABELS,
  type BotSetup,
} from '../../features/bot-analysis/botSetup.types';
import { formatPrice } from '../../lib/price-format';
import { formatUtc } from '../../lib/time';

/** ¿Están SL/TP del lado correcto para el side del plan? */
function planSideValid(m: ManualMark): boolean {
  if (m.entry == null || m.stopLoss == null || m.takeProfit == null) return true;
  return m.side === 'LONG'
    ? m.takeProfit > m.entry && m.stopLoss < m.entry
    : m.takeProfit < m.entry && m.stopLoss > m.entry;
}

interface Props {
  symbol: string;
  tf: string;
  loaded: number;
  hover: Candle | null;
  selectedMark: ManualMark | null;
  selectedBotFvg: BotFvg | null;
  selectedBotOb: BotOb | null;
  selectedBotLiq: BotLiquidity | null;
  selectedBotConf: ConfluenceZone | null;
  selectedBotSetup: BotSetup | null;
  onUpdateMeta: (id: string, patch: Partial<ManualMark>) => void;
  onDeleteMark: (id: string) => void;
}

function NoteField(props: { label: string; value: string; placeholder: string; onChange: (v: string) => void }) {
  return (
    <label className="note-label">
      {props.label}
      <textarea
        className="note-input"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

export function RightInspector({
  symbol,
  tf,
  loaded,
  hover,
  selectedMark,
  selectedBotFvg,
  selectedBotOb,
  selectedBotLiq,
  selectedBotConf,
  selectedBotSetup,
  onUpdateMeta,
  onDeleteMark,
}: Props) {
  return (
    <div className="panel">
      <h3 className="panel-title">Inspector</h3>
      <div className="kv"><span>Símbolo</span><b>{symbol}</b></div>
      <div className="kv"><span>Timeframe</span><b>{tf}</b></div>
      <div className="kv"><span>Velas cargadas</span><b>{loaded}</b></div>
      <div className="divider" />

      {selectedBotSetup ? (
        <div className="mark-detail">
          <div className="kv">
            <span>Lectura del bot</span>
            <b style={{ color: SETUP_DIR_COLORS[selectedBotSetup.direction] }}>
              Setup · {selectedBotSetup.state}
            </b>
          </div>
          <div className="kv">
            <span>Contexto</span>
            <b style={{ color: SETUP_DIR_COLORS[selectedBotSetup.direction] }}>
              {selectedBotSetup.direction === 'bullish' ? 'posible LONG ▲' : 'posible SHORT ▼'}
            </b>
          </div>
          <div className="kv"><span>Estado</span><b>{SETUP_STATE_LABELS[selectedBotSetup.state]}</b></div>
          <div className="kv"><span>Confluencia origen</span><b>{selectedBotSetup.rating} (score {selectedBotSetup.score})</b></div>
          <div className="kv"><span>Rango</span><b>{formatPrice(selectedBotSetup.priceLow)}–{formatPrice(selectedBotSetup.priceHigh)}</b></div>
          <div className="kv"><span>Mitigado</span><b>{selectedBotSetup.mitigatedAtTime ? formatUtc(selectedBotSetup.mitigatedAtTime) : '—'}</b></div>
          <div className="kv"><span>Armado</span><b>{selectedBotSetup.armedAtTime ? formatUtc(selectedBotSetup.armedAtTime) : '—'}</b></div>
          <div className="kv"><span>Distancia al precio</span><b>{selectedBotSetup.distancePct}%</b></div>
          <p className="hint">
            {selectedBotSetup.state === 'WATCHING'
              ? 'WATCHING: zona de confluencia relevante; el precio aún no ha vuelto a ella.'
              : selectedBotSetup.state === 'MITIGATED'
                ? 'MITIGATED: el precio entró/tocó la zona, pero aún no hay confirmación.'
                : 'ARMED: tras mitigar, se formó un OB de confirmación en la zona (no fue solo el toque).'}
          </p>
          <p className="hint">
            Falta para una posible entrada:{' '}
            {selectedBotSetup.state === 'WATCHING'
              ? 'que el precio regrese a la zona (mitigación).'
              : selectedBotSetup.state === 'MITIGATED'
                ? 'una confirmación (que se forme un OB/reacción en la zona).'
                : 'es lo más cerca que llega esta fase. La entrada sugerida (Entry/SL/TP) llega en 5F.'}
          </p>
          <p className="hint">
            La invalidaría: un cierre {selectedBotSetup.direction === 'bullish' ? 'por debajo' : 'por encima'} del
            rango. Lectura del bot — NO es señal ni entrada.
          </p>
        </div>
      ) : selectedBotConf ? (
        <div className="mark-detail">
          <div className="kv">
            <span>Lectura del bot</span>
            <b style={{ color: CONF_DIR_COLORS[selectedBotConf.direction] }}>
              ★ Confluencia {selectedBotConf.rating}
            </b>
          </div>
          <div className="kv">
            <span>Sesgo operativo</span>
            <b style={{ color: CONF_DIR_COLORS[selectedBotConf.direction] }}>
              posible {selectedBotConf.direction === 'bullish' ? 'LONG ▲' : 'SHORT ▼'}
            </b>
          </div>
          <div className="kv"><span>Rol</span><b>zona de interés (no entrada)</b></div>
          <div className="kv"><span>Score</span><b>{selectedBotConf.score} ({selectedBotConf.rating})</b></div>
          <div className="kv"><span>OB</span><b>{selectedBotConf.hasOB ? `sí (+${selectedBotConf.scoreOB})` : 'no'}</b></div>
          <div className="kv"><span>FVG</span><b>{selectedBotConf.hasFVG ? `sí (+${selectedBotConf.scoreFVG})` : 'no'}</b></div>
          <div className="kv"><span>Liquidez cercana</span><b>{selectedBotConf.hasLiquidity ? `sí (+${selectedBotConf.scoreLiquidity})` : 'no'}</b></div>
          <div className="kv"><span>Rango</span><b>{formatPrice(selectedBotConf.priceLow)}–{formatPrice(selectedBotConf.priceHigh)}</b></div>
          <div className="kv"><span>Distancia al precio</span><b>{selectedBotConf.distancePct}%</b></div>
          <p className="hint">
            Combina {[
              selectedBotConf.hasOB ? 'OB' : null,
              selectedBotConf.hasFVG ? 'FVG' : null,
              selectedBotConf.hasLiquidity ? 'liquidez' : null,
            ].filter(Boolean).join(' + ')} — más capas alineadas = más peso.
          </p>
          <p className="hint">
            Para activarse: el precio debe mitigar la zona y mostrar reacción/confirmación en
            timeframe menor (sweep + CHoCH/BOS). Eso llega en Setup States (5E).
          </p>
          <p className="hint">
            La invalidaría: un cierre {selectedBotConf.direction === 'bullish' ? 'por debajo' : 'por encima'} del
            rango, o un cambio de sesgo en timeframe mayor. Lectura del bot — NO es señal ni entrada.
          </p>
        </div>
      ) : selectedBotLiq ? (
        <div className="mark-detail">
          <div className="kv">
            <span>Lectura del bot</span>
            <b style={{ color: LIQ_COLOR }}>
              Liquidez {selectedBotLiq.side === 'buyside' ? 'buyside ▲' : 'sellside ▼'}
            </b>
          </div>
          <div className="kv"><span>Tipo</span><b>{LIQ_TYPE_LABELS[selectedBotLiq.type]}</b></div>
          <div className="kv"><span>Nivel</span><b>{formatPrice(selectedBotLiq.level)}</b></div>
          <div className="kv"><span>Toques</span><b>{selectedBotLiq.touches}</b></div>
          <div className="kv"><span>Estado</span><b>{selectedBotLiq.swept ? 'Barrida' : 'Activa'}</b></div>
          <div className="kv"><span>Distancia al precio</span><b>{selectedBotLiq.distancePct}%</b></div>
          <p className="hint">
            Por qué: nivel donde se acumula liquidez (stops/órdenes) que el precio tiende a
            buscar. {selectedBotLiq.type === 'equalHigh' || selectedBotLiq.type === 'equalLow'
              ? `Igualdad de ${selectedBotLiq.side === 'buyside' ? 'máximos' : 'mínimos'} (${selectedBotLiq.touches} toques) = más fuerte.`
              : 'Swing único.'} Lectura del bot — no es señal.
          </p>
        </div>
      ) : selectedBotOb ? (
        <div className="mark-detail">
          <div className="kv">
            <span>Lectura del bot</span>
            <b style={{ color: OB_COLORS[selectedBotOb.direction] }}>
              OB {selectedBotOb.direction === 'bullish' ? 'alcista ▲' : 'bajista ▼'}
            </b>
          </div>
          <div className="kv"><span>Estado</span><b>{OB_STATE_LABELS[selectedBotOb.state]}</b></div>
          <div className="kv"><span>Rango</span><b>{formatPrice(selectedBotOb.obLow)}–{formatPrice(selectedBotOb.obHigh)}</b></div>
          <div className="kv"><span>Fuerza</span><b>{selectedBotOb.strength}× media</b></div>
          <div className="kv"><span>Rompió estructura</span><b>{selectedBotOb.brokeStructure ? 'Sí' : 'No'}</b></div>
          <div className="kv"><span>Dejó imbalance</span><b>{selectedBotOb.leftImbalance ? 'Sí' : 'No'}</b></div>
          <div className="kv"><span>Vela origen</span><b>{formatUtc(selectedBotOb.originTime)}</b></div>
          <div className="kv"><span>Confirmado</span><b>{formatUtc(selectedBotOb.confirmedAtTime)}</b></div>
          <p className="hint">
            Por qué: última vela contraria antes de un impulso fuerte (la zona donde "quedaron"
            órdenes). Lectura automática del bot — no es señal. Compárala con tu análisis.
          </p>
        </div>
      ) : selectedBotFvg ? (
        <div className="mark-detail">
          <div className="kv">
            <span>Lectura del bot</span>
            <b style={{ color: FVG_COLORS[selectedBotFvg.direction] }}>
              FVG {selectedBotFvg.direction === 'bullish' ? 'alcista ▲' : 'bajista ▼'}
            </b>
          </div>
          <div className="kv"><span>Estado</span><b>{FVG_STATE_LABELS[selectedBotFvg.state]} ({Math.round(selectedBotFvg.fillRatio * 100)}%)</b></div>
          <div className="kv"><span>Gap</span><b>{formatPrice(selectedBotFvg.gapLow)}–{formatPrice(selectedBotFvg.gapHigh)}</b></div>
          <div className="kv"><span>Tamaño gap</span><b>{formatPrice(selectedBotFvg.gapHigh - selectedBotFvg.gapLow)}</b></div>
          <p className="hint">
            Por qué: 3 velas consecutivas; la 2ª (desplazamiento) deja un hueco entre la 1ª y la
            3ª que el precio no recorrió.
          </p>
          <div className="kv"><span>Vela 1</span><b>{formatUtc(selectedBotFvg.candle1Time)}</b></div>
          <div className="kv"><span>Vela 2 (despl.)</span><b>{formatUtc(selectedBotFvg.candle2Time)}</b></div>
          <div className="kv"><span>Vela 3</span><b>{formatUtc(selectedBotFvg.candle3Time)}</b></div>
          <p className="hint">Lectura automática del bot — no es señal. Compárala con tu análisis.</p>
        </div>
      ) : selectedMark ? (
        <div className="mark-detail">
          <div className="kv">
            <span>Marca</span>
            <b style={{ color: MARK_COLORS[selectedMark.kind] }}>
              {isPlanKind(selectedMark.kind) ? `${selectedMark.side ?? ''} Position` : selectedMark.kind}
            </b>
          </div>

          {/* Datos técnicos */}
          {isZoneKind(selectedMark.kind) ? (
            <>
              <div className="kv"><span>Precio alto</span><b>{formatPrice(selectedMark.priceHigh ?? 0)}</b></div>
              <div className="kv"><span>Precio bajo</span><b>{formatPrice(selectedMark.priceLow ?? 0)}</b></div>
              <div className="kv"><span>Alto de zona</span><b>{formatPrice(Math.abs((selectedMark.priceHigh ?? 0) - (selectedMark.priceLow ?? 0)))}</b></div>
              <div className="kv"><span>Desde</span><b>{selectedMark.timeStart ? formatUtc(selectedMark.timeStart) : '—'}</b></div>
              <div className="kv"><span>Hasta</span><b>{selectedMark.timeEnd ? formatUtc(selectedMark.timeEnd) : '—'}</b></div>
            </>
          ) : isPlanKind(selectedMark.kind) ? (
            <>
              <div className="kv"><span>Lado</span><b>{selectedMark.side}</b></div>
              <div className="kv"><span>Entrada</span><b>{formatPrice(selectedMark.entry ?? 0)}</b></div>
              <div className="kv"><span>Stop Loss</span><b style={{ color: '#ef5350' }}>{formatPrice(selectedMark.stopLoss ?? 0)}</b></div>
              <div className="kv"><span>Take Profit</span><b style={{ color: '#22c55e' }}>{formatPrice(selectedMark.takeProfit ?? 0)}</b></div>
              <div className="kv">
                <span>R:R</span>
                <b>
                  {(() => {
                    const rr = computeRR(selectedMark.entry ?? 0, selectedMark.stopLoss ?? 0, selectedMark.takeProfit ?? 0);
                    return rr != null ? rr.toFixed(2) : '—';
                  })()}
                </b>
              </div>
              <div className="kv"><span>Dist. Entry→SL</span><b>{formatPrice(Math.abs((selectedMark.entry ?? 0) - (selectedMark.stopLoss ?? 0)))}</b></div>
              <div className="kv"><span>Dist. Entry→TP</span><b>{formatPrice(Math.abs((selectedMark.takeProfit ?? 0) - (selectedMark.entry ?? 0)))}</b></div>
              {!planSideValid(selectedMark) && (
                <p className="warn">⚠ SL/TP del lado incorrecto para {selectedMark.side}. En {selectedMark.side === 'LONG' ? 'LONG el TP va arriba y el SL abajo' : 'SHORT el TP va abajo y el SL arriba'}.</p>
              )}
            </>
          ) : (
            <div className="kv"><span>Precio</span><b>{formatPrice(selectedMark.price ?? 0)}</b></div>
          )}

          {/* Estudio: estado de revisión + notas. Opcional y secundario (colapsado). */}
          <details className="advanced">
            <summary>Estudio / notas avanzadas</summary>
            <div className="status-row">
              {REVIEW_STATUSES.map((s) => {
                const active = (selectedMark.status ?? 'DRAFT') === s;
                return (
                  <button
                    key={s}
                    type="button"
                    className={`status-btn${active ? ' active' : ''}`}
                    style={active ? { borderColor: STATUS_COLORS[s], color: STATUS_COLORS[s] } : undefined}
                    onClick={() => onUpdateMeta(selectedMark.id, { status: s })}
                  >
                    {STATUS_LABELS[s]}
                  </button>
                );
              })}
            </div>
            <NoteField label="Contexto" value={selectedMark.context ?? ''} placeholder="Contexto de mercado (HTF, sesión…)" onChange={(v) => onUpdateMeta(selectedMark.id, { context: v })} />
            <NoteField label="Razón" value={selectedMark.reason ?? ''} placeholder="¿Por qué marcaste esto?" onChange={(v) => onUpdateMeta(selectedMark.id, { reason: v })} />
            <NoteField label="Duda" value={selectedMark.doubt ?? ''} placeholder="¿Qué te genera dudas / qué revisar?" onChange={(v) => onUpdateMeta(selectedMark.id, { doubt: v })} />
            <NoteField label="Resultado / observación" value={selectedMark.outcome ?? ''} placeholder="¿Qué pasó después? ¿Qué aprendiste?" onChange={(v) => onUpdateMeta(selectedMark.id, { outcome: v })} />
          </details>

          <button className="btn-danger" type="button" onClick={() => onDeleteMark(selectedMark.id)}>
            Borrar marca
          </button>
        </div>
      ) : hover ? (
        <>
          <div className="kv"><span>Hora</span><b>{formatUtc(hover.openTime)}</b></div>
          <div className="kv"><span>O</span><b>{formatPrice(hover.o)}</b></div>
          <div className="kv"><span>H</span><b>{formatPrice(hover.h)}</b></div>
          <div className="kv"><span>L</span><b>{formatPrice(hover.l)}</b></div>
          <div className="kv"><span>C</span><b>{formatPrice(hover.c)}</b></div>
          <div className="kv"><span>Vol</span><b>{hover.v.toFixed(2)}</b></div>
        </>
      ) : (
        <p className="hint">Selecciona una marca o pasa el cursor sobre una vela.</p>
      )}
    </div>
  );
}
