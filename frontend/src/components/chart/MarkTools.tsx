import type { ManualTool } from '../../features/manual-marks/manualMarks.types';

const TOOLS: { tool: ManualTool; label: string; title: string }[] = [
  { tool: 'Select', label: '⌖', title: 'Seleccionar / mover gráfica' },
  { tool: 'OB', label: 'OB', title: 'Order Block (zona)' },
  { tool: 'FVG', label: 'FVG', title: 'Fair Value Gap / imbalance (zona)' },
  { tool: 'Liquidity', label: 'Liq', title: 'Liquidez (nivel)' },
  { tool: 'Long', label: 'Long', title: 'Long Position (Entry + SL + TP)' },
  { tool: 'Short', label: 'Short', title: 'Short Position (Entry + SL + TP)' },
];

interface Props {
  value: ManualTool;
  onChange: (tool: ManualTool) => void;
}

export function MarkTools({ value, onChange }: Props) {
  return (
    <div className="mark-tools">
      {TOOLS.map(({ tool, label, title }) => (
        <button
          key={tool}
          type="button"
          className={`tool-btn${tool === value ? ' active' : ''}${tool === 'Long' ? ' long' : ''}${tool === 'Short' ? ' short' : ''}`}
          title={title}
          onClick={() => onChange(tool)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
