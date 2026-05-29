# Trading Cockpit (frontend)

Dashboard **final** del copiloto SMC, construido por slices. **No es una maqueta**: este es
el shell definitivo de la SPA (Vite + React + TS + TradingView Lightweight Charts).

## Estado
- **Slice 1 — gráfica base** (actual): app shell + velas reales desde `/api/candles` +
  selector símbolo/timeframe + crosshair + tooltip OHLC + loading/error.
- Próximos slices: navegación fina → marcas manuales → guardar marcas → capas OB/FVG del bot →
  inspector de reglas → señales (SL/TP/BE) → journal y aprendizaje.

## Arquitectura
```
src/
  app/TradingCockpit.tsx        orquestador
  components/
    chart/                      gráfica + toolbar + selectores + crosshair
    layout/                     AppShell + paneles (izq/der/inferior)
  overlays/                     contrato de capas (OB/FVG/señales/marcas) — futuro
  features/
    candles/                    API + tipos de velas (implementado)
    manual-marks/ signals/ journal/   tipos placeholder (slices futuros)
  lib/                          apiClient, time, price-format
  styles/theme.css
```

## Correr
Requiere el backend arriba con datos:
```bash
# backend (raíz del repo), con la DB de desarrollo y velas ya persistidas
DB_ENABLED=true MARKET_DATA_LIVE=false EXCHANGE_PROVIDER=binance \
  BINANCE_FUTURES_BASE_URL=https://fapi.binance.com ... npm run start:prod
```
Frontend:
```bash
cd frontend
cp .env.example .env        # ajusta VITE_API_BASE_URL si el backend no está en :3300
npm install
npm run dev                 # http://localhost:5173
```

## Build / typecheck
```bash
npm run build               # tsc --noEmit + vite build
```
