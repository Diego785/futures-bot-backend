import type { HoverOhlc } from '../chart/CandleChart';
import { formatPrice } from '../../lib/price-format';

interface Props {
  symbol: string;
  tf: string;
  hover: HoverOhlc | null;
}

/**
 * Inspector derecho. Hoy muestra el contexto (símbolo/tf) y el OHLC bajo el crosshair.
 * En slices futuros mostrará el detalle de una zona/señal: por qué apareció, qué regla la
 * activó, qué la invalidaría.
 */
export function RightInspector({ symbol, tf, hover }: Props) {
  return (
    <div className="panel">
      <h3 className="panel-title">Inspector</h3>
      <div className="kv"><span>Símbolo</span><b>{symbol}</b></div>
      <div className="kv"><span>Timeframe</span><b>{tf}</b></div>
      <div className="divider" />
      <div className="kv"><span>O</span><b>{hover ? formatPrice(hover.o) : '—'}</b></div>
      <div className="kv"><span>H</span><b>{hover ? formatPrice(hover.h) : '—'}</b></div>
      <div className="kv"><span>L</span><b>{hover ? formatPrice(hover.l) : '—'}</b></div>
      <div className="kv"><span>C</span><b>{hover ? formatPrice(hover.c) : '—'}</b></div>
      <div className="divider" />
      <p className="hint">Detalle de zona/señal: próximos slices.</p>
    </div>
  );
}
