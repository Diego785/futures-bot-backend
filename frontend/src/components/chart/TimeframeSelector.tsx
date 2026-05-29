import { TIMEFRAMES, type Timeframe } from '../../features/candles/candles.types';

interface Props {
  value: Timeframe;
  onChange: (tf: Timeframe) => void;
}

export function TimeframeSelector({ value, onChange }: Props) {
  return (
    <div className="tf-selector">
      {TIMEFRAMES.map((tf) => (
        <button
          key={tf}
          type="button"
          className={tf === value ? 'tf-btn active' : 'tf-btn'}
          onClick={() => onChange(tf)}
        >
          {tf}
        </button>
      ))}
    </div>
  );
}
