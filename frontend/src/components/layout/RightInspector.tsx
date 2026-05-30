import type { Candle } from '../../features/candles/candles.types';
import {
  isZoneKind,
  MARK_COLORS,
  type ManualMark,
} from '../../features/manual-marks/manualMarks.types';
import { formatPrice } from '../../lib/price-format';
import { formatUtc } from '../../lib/time';

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
            <b style={{ color: MARK_COLORS[selectedMark.kind] }}>{selectedMark.kind}</b>
          </div>
          {isZoneKind(selectedMark.kind) ? (
            <>
              <div className="kv"><span>Precio alto</span><b>{formatPrice(selectedMark.priceHigh ?? 0)}</b></div>
              <div className="kv"><span>Precio bajo</span><b>{formatPrice(selectedMark.priceLow ?? 0)}</b></div>
              <div className="kv"><span>Desde</span><b>{selectedMark.timeStart ? formatUtc(selectedMark.timeStart) : '—'}</b></div>
              <div className="kv"><span>Hasta</span><b>{selectedMark.timeEnd ? formatUtc(selectedMark.timeEnd) : '—'}</b></div>
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
