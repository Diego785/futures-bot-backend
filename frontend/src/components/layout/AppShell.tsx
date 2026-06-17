import { useState, type ReactNode } from 'react';
import { useMediaQuery } from '../../lib/useMediaQuery';

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
 * Shell de las vistas. DESKTOP: grid de 3 columnas (left | center | right) + barra inferior, con
 * paneles colapsables. MÓVIL/TABLET (≤820px): el centro ocupa todo el ancho y los paneles laterales
 * se vuelven CAJONES deslizables (drawers) que se abren desde la barra superior; la navegación
 * principal pasa a una barra inferior (ver .app-viewtabs). Así se monitorea desde cualquier dispositivo.
 */
export function AppShell({ topBar, left, center, right, bottom, leftOpen, rightOpen, bottomOpen }: Props) {
  const isMobile = useMediaQuery('(max-width: 820px)');
  const [drawer, setDrawer] = useState<null | 'left' | 'right'>(null);

  if (isMobile) {
    const hasLeft = leftOpen && left != null;
    const hasRight = rightOpen && right != null;
    return (
      <div className="shell-m">
        <header className="shell-m-top">
          {hasLeft && (
            <button className="shell-m-toggle" onClick={() => setDrawer('left')} aria-label="Abrir panel izquierdo">
              ☰
            </button>
          )}
          <div className="shell-m-bar">{topBar}</div>
          {hasRight && (
            <button className="shell-m-toggle" onClick={() => setDrawer('right')} aria-label="Abrir panel derecho">
              ⊞
            </button>
          )}
        </header>
        <main className="shell-m-center">{center}</main>
        {bottomOpen && bottom != null && <footer className="shell-m-bottom">{bottom}</footer>}

        {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(null)} />}
        {hasLeft && (
          <aside className={`drawer drawer-left ${drawer === 'left' ? 'open' : ''}`}>
            <button className="drawer-close" onClick={() => setDrawer(null)} aria-label="Cerrar">✕</button>
            {left}
          </aside>
        )}
        {hasRight && (
          <aside className={`drawer drawer-right ${drawer === 'right' ? 'open' : ''}`}>
            <button className="drawer-close" onClick={() => setDrawer(null)} aria-label="Cerrar">✕</button>
            {right}
          </aside>
        )}
      </div>
    );
  }

  // ── DESKTOP (sin cambios) ──
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
