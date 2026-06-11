import { formatUtc } from '../../lib/time';

interface Props {
  cursorIdx: number;
  maxIdx: number;
  cursorTime: number | null; // openTime de la vela del cursor
  playing: boolean;
  speed: number; // velas por segundo
  bias: string; // sesgo HTF vigente al cierre del cursor
  onSeek: (idx: number) => void;
  onStep: (delta: number) => void;
  onPlayPause: () => void;
  onSpeed: (s: number) => void;
}

const SPEEDS = [1, 4, 10, 25];

/** Controles del replay: el tiempo avanza por VELAS CERRADAS (así decide el motor), nunca por ticks. */
export function ReplayControls({
  cursorIdx,
  maxIdx,
  cursorTime,
  playing,
  speed,
  bias,
  onSeek,
  onStep,
  onPlayPause,
  onSpeed,
}: Props) {
  const biasClass = bias === 'bullish' ? 'bias-bull' : bias === 'bearish' ? 'bias-bear' : 'bias-neutral';
  return (
    <div className="replay-controls">
      <button className="rc-btn" onClick={() => onStep(-1)} disabled={cursorIdx <= 0} title="Una vela atrás">
        ‹
      </button>
      <button className="rc-btn rc-play" onClick={onPlayPause} title={playing ? 'Pausa' : 'Reproducir'}>
        {playing ? '⏸' : '▶'}
      </button>
      <button className="rc-btn" onClick={() => onStep(1)} disabled={cursorIdx >= maxIdx} title="Una vela adelante">
        ›
      </button>
      <select className="rc-speed" value={speed} onChange={(e) => onSpeed(Number(e.target.value))} title="Velas por segundo">
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s} v/s
          </option>
        ))}
      </select>
      <input
        className="rc-slider"
        type="range"
        min={0}
        max={Math.max(maxIdx, 0)}
        value={Math.min(cursorIdx, maxIdx)}
        onChange={(e) => onSeek(Number(e.target.value))}
      />
      <span className="rc-time">{cursorTime != null ? formatUtc(cursorTime) : '—'}</span>
      <span className={`rc-bias ${biasClass}`} title="Sesgo estructural 4H vigente (BOS por cuerpo) al cierre del cursor">
        4H {bias}
      </span>
    </div>
  );
}
