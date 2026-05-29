import type { IChartApi, ISeriesApi } from 'lightweight-charts';

/**
 * Contrato de una capa de overlay sobre la gráfica (OB, FVG, liquidez, señales, marcas...).
 * Slice futuro: cada capa dibujará sus primitivas sobre el chart de Lightweight Charts y
 * podrá activarse/desactivarse desde el panel de capas. Placeholder de arquitectura —
 * todavía sin implementaciones concretas.
 */
export interface OverlayLayer {
  readonly id: string;
  readonly label: string;
  attach(chart: IChartApi, series: ISeriesApi<'Candlestick'>): void;
  detach(): void;
  setVisible(visible: boolean): void;
}
