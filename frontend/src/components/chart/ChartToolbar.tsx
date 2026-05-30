import { SymbolSelector } from './SymbolSelector';
import { TimeframeSelector } from './TimeframeSelector';
import { CrosshairInfo } from './CrosshairInfo';
import type { Candle, Timeframe } from '../../features/candles/candles.types';
import type { MarketStatus } from '../../lib/liveClient';
import { formatPrice } from '../../lib/price-format';

interface Props {
  symbol: string;
  tf: Timeframe;
  onSymbol: (symbol: string) => void;
  onTf: (tf: Timeframe) => void;
  status: string;
  count: number;
  hover: Candle | null;
  marketStatus: MarketStatus;
  livePrice: number | null;
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onToggleBottom: () => void;
  onFocus: () => void;
}

export function ChartToolbar({
  symbol,
  tf,
  onSymbol,
  onTf,
  status,
  count,
  hover,
  marketStatus,
  livePrice,
  leftOpen,
  rightOpen,
  bottomOpen,
  onToggleLeft,
  onToggleRight,
  onToggleBottom,
  onFocus,
}: Props) {
  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <SymbolSelector value={symbol} onChange={onSymbol} />
        <TimeframeSelector value={tf} onChange={onTf} />
      </div>
      <div className="toolbar-center">
        <CrosshairInfo candle={hover} />
      </div>
      <div className="toolbar-right">
        {livePrice != null && (
          <span className="badge live-price" title="Último precio">
            {formatPrice(livePrice)}
          </span>
        )}
        <span className={`badge mkt mkt-${marketStatus.toLowerCase()}`} title="Estado del mercado en vivo">
          {marketStatus}
        </span>
        <span className="badge">{count} velas</span>
        <span className={`badge status-${status}`}>{status}</span>
        <div className="panel-toggles">
          <button
            type="button"
            className={leftOpen ? 'toggle active' : 'toggle'}
            title="Panel de capas"
            onClick={onToggleLeft}
          >
            ◧
          </button>
          <button
            type="button"
            className={rightOpen ? 'toggle active' : 'toggle'}
            title="Inspector"
            onClick={onToggleRight}
          >
            ◨
          </button>
          <button
            type="button"
            className={bottomOpen ? 'toggle active' : 'toggle'}
            title="Panel inferior"
            onClick={onToggleBottom}
          >
            ▭
          </button>
          <button type="button" className="toggle" title="Modo focus (solo gráfica)" onClick={onFocus}>
            ⛶
          </button>
        </div>
      </div>
    </div>
  );
}
