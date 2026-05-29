interface Props {
  value: string;
  onChange: (symbol: string) => void;
}

// Por ahora un símbolo (BTCUSDT). La lista se ampliará cuando el backend exponga símbolos.
const SYMBOLS = ['BTCUSDT'];

export function SymbolSelector({ value, onChange }: Props) {
  return (
    <label className="selector">
      <span>Símbolo</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {SYMBOLS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </label>
  );
}
