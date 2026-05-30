import type { Candle } from '../../features/candles/candles.types';
import { formatPrice } from '../../lib/price-format';

interface Props {
  candle: Candle | null;
}

export function CrosshairInfo({ candle }: Props) {
  if (!candle) {
    return <span className="crosshair-info muted">O — H — L — C — V —</span>;
  }
  return (
    <span className="crosshair-info">
      <span>O {formatPrice(candle.o)}</span>
      <span>H {formatPrice(candle.h)}</span>
      <span>L {formatPrice(candle.l)}</span>
      <span>C {formatPrice(candle.c)}</span>
      <span className="muted">V {candle.v.toFixed(2)}</span>
    </span>
  );
}
