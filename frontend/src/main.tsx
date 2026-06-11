import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import './styles/theme.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('No se encontró #root');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
