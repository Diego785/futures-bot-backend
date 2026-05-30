import type { Candle } from '../../features/candles/candles.types';
import {
  isZoneKind,
  isPlanKind,
  computeRR,
  MARK_COLORS,
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
  onUpdateNote: (id: string, note: string) => void;
  onDeleteMark: (id: string) => void;
}

export function RightInspector({
  symbol,
  tf,
  loaded,
  hover,
  selectedMark,
  onUpdateNote,
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
          {isZoneKind(selectedMark.kind) ? (
            <>
              <div className="kv"><span>Precio alto</span><b>{formatPrice(selectedMark.priceHigh ?? 0)}</b></div>
              <div className="kv"><span>Precio bajo</span><b>{formatPrice(selectedMark.priceLow ?? 0)}</b></div>
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
              {!planSideValid(selectedMark) && (
                <p className="warn">⚠ SL/TP del lado incorrecto para {selectedMark.side}. En {selectedMark.side === 'LONG' ? 'LONG el TP va arriba y el SL abajo' : 'SHORT el TP va abajo y el SL arriba'}.</p>
              )}
            </>
          ) : (
            <div className="kv"><span>Precio</span><b>{formatPrice(selectedMark.price ?? 0)}</b></div>
          )}
          <label className="note-label">
            Nota
            <textarea
              className="note-input"
              value={selectedMark.note ?? ''}
              placeholder="¿Por qué marcaste esto?"
              onChange={(e) => onUpdateNote(selectedMark.id, e.target.value)}
            />
          </label>
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

      <div className="divider" />
      <p className="hint">Detalle de zona/señal del bot: próximos slices.</p>
    </div>
  );
}
