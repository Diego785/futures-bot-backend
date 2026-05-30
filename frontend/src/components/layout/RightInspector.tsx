import type { Candle } from '../../features/candles/candles.types';
import { formatPrice } from '../../lib/price-format';
import { formatUtc } from '../../lib/time';

interface Props {
  symbol: string;
  tf: string;
  loaded: number;
  hover: Candle | null;
}

/**
 * Inspector derecho. Muestra contexto (símbolo/tf/velas cargadas) y la vela bajo el cursor
 * (OHLCV + tiempo). En slices futuros mostrará el detalle de una zona/señal.
 */
export function RightInspector({ symbol, tf, loaded, hover }: Props) {
  return (
    <div className="panel">
      <h3 className="panel-title">Inspector</h3>
      <div className="kv"><span>Símbolo</span><b>{symbol}</b></div>
      <div className="kv"><span>Timeframe</span><b>{tf}</b></div>
      <div className="kv"><span>Velas cargadas</span><b>{loaded}</b></div>
      <div className="divider" />
      {hover ? (
        <>
          <div className="kv"><span>Hora</span><b>{formatUtc(hover.openTime)}</b></div>
          <div className="kv"><span>O</span><b>{formatPrice(hover.o)}</b></div>
          <div className="kv"><span>H</span><b>{formatPrice(hover.h)}</b></div>
          <div className="kv"><span>L</span><b>{formatPrice(hover.l)}</b></div>
          <div className="kv"><span>C</span><b>{formatPrice(hover.c)}</b></div>
          <div className="kv"><span>Vol</span><b>{hover.v.toFixed(2)}</b></div>
        </>
      ) : (
        <p className="hint">Pasa el cursor sobre una vela para ver su detalle.</p>
      )}
      <div className="divider" />
      <p className="hint">Detalle de zona/señal: próximos slices.</p>
    </div>
  );
}
