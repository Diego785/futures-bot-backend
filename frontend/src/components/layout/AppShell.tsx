import type { ReactNode } from 'react';

interface Props {
  topBar: ReactNode;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  bottom: ReactNode;
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
}

/**
 * Shell del Trading Cockpit. Paneles colapsables: cuando se cierran, su columna/fila
 * se reduce a 0 y la gráfica (centro) gana espacio (Lightweight Charts auto-redimensiona).
 */
export function AppShell({
  topBar,
  left,
  center,
  right,
  bottom,
  leftOpen,
  rightOpen,
  bottomOpen,
}: Props) {
  const gridTemplateColumns = `${leftOpen ? '200px' : '0'} 1fr ${rightOpen ? '280px' : '0'}`;
  const gridTemplateRows = `48px 1fr ${bottomOpen ? '160px' : '0'}`;

  return (
    <div className="app-shell" style={{ gridTemplateColumns, gridTemplateRows }}>
      <header className="shell-topbar">{topBar}</header>
      <aside className="shell-left" style={{ display: leftOpen ? undefined : 'none' }}>
        {left}
      </aside>
      <main className="shell-center">{center}</main>
      <aside className="shell-right" style={{ display: rightOpen ? undefined : 'none' }}>
        {right}
      </aside>
      <footer className="shell-bottom" style={{ display: bottomOpen ? undefined : 'none' }}>
        {bottom}
      </footer>
    </div>
  );
}
