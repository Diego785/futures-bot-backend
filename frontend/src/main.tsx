import React from 'react';
import ReactDOM from 'react-dom/client';
import { TradingCockpit } from './app/TradingCockpit';
import './styles/theme.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('No se encontró #root');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <TradingCockpit />
  </React.StrictMode>,
);
