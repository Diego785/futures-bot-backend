import type { HoverOhlc } from './CandleChart';
import { formatPrice } from '../../lib/price-format';

interface Props {
  ohlc: HoverOhlc | null;
}

export function CrosshairInfo({ ohlc }: Props) {
  if (!ohlc) {
    return <span className="crosshair-info muted">O — H — L — C —</span>;
  }
  return (
    <span className="crosshair-info">
      <span>O {formatPrice(ohlc.o)}</span>
      <span>H {formatPrice(ohlc.h)}</span>
      <span>L {formatPrice(ohlc.l)}</span>
      <span>C {formatPrice(ohlc.c)}</span>
    </span>
  );
}
