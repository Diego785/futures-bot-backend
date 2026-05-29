import type { ReactNode } from 'react';

interface Props {
  topBar: ReactNode;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  bottom: ReactNode;
}

/**
 * Shell del Trading Cockpit: topbar / [izquierda | centro | derecha] / inferior.
 * Las zonas laterales e inferior ya existen para alojar capas, inspector y journal
 * en slices futuros, aunque hoy estén casi vacías.
 */
export function AppShell({ topBar, left, center, right, bottom }: Props) {
  return (
    <div className="app-shell">
      <header className="shell-topbar">{topBar}</header>
      <aside className="shell-left">{left}</aside>
      <main className="shell-center">{center}</main>
      <aside className="shell-right">{right}</aside>
      <footer className="shell-bottom">{bottom}</footer>
    </div>
  );
}
