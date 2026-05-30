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

      {selectedMark ? (
        <div className="mark-detail">
          <div className="kv">
            <span>Marca</span>
            <b style={{ color: MARK_COLORS[selectedMark.kind] }}>
              {isPlanKind(selectedMark.kind) ? `${selectedMark.side ?? ''} Position` : selectedMark.kind}
            </b>
          </div>

          {/* Estado de revisión */}
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

          {/* Notas estructuradas de revisión */}
          <NoteField label="Contexto" value={selectedMark.context ?? ''} placeholder="Contexto de mercado (HTF, sesión…)" onChange={(v) => onUpdateMeta(selectedMark.id, { context: v })} />
          <NoteField label="Razón" value={selectedMark.reason ?? ''} placeholder="¿Por qué marcaste esto?" onChange={(v) => onUpdateMeta(selectedMark.id, { reason: v })} />
          <NoteField label="Duda" value={selectedMark.doubt ?? ''} placeholder="¿Qué te genera dudas / qué revisar?" onChange={(v) => onUpdateMeta(selectedMark.id, { doubt: v })} />
          <NoteField label="Resultado / observación" value={selectedMark.outcome ?? ''} placeholder="¿Qué pasó después? ¿Qué aprendiste?" onChange={(v) => onUpdateMeta(selectedMark.id, { outcome: v })} />

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
