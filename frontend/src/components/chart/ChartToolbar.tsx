import { SymbolSelector } from './SymbolSelector';
import { TimeframeSelector } from './TimeframeSelector';
import { CrosshairInfo } from './CrosshairInfo';
import type { HoverOhlc } from './CandleChart';
import type { Timeframe } from '../../features/candles/candles.types';

interface Props {
  symbol: string;
  tf: Timeframe;
  onSymbol: (symbol: string) => void;
  onTf: (tf: Timeframe) => void;
  status: string;
  count: number;
  hover: HoverOhlc | null;
}

export function ChartToolbar({ symbol, tf, onSymbol, onTf, status, count, hover }: Props) {
  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <SymbolSelector value={symbol} onChange={onSymbol} />
        <TimeframeSelector value={tf} onChange={onTf} />
      </div>
      <div className="toolbar-center">
        <CrosshairInfo ohlc={hover} />
      </div>
      <div className="toolbar-right">
        <span className="badge">{count} velas</span>
        <span className={`badge status-${status}`}>{status}</span>
      </div>
    </div>
  );
}
