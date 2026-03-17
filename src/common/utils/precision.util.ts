export function countDecimals(numStr: string): number {
  if (!numStr.includes('.')) return 0;
  return numStr.split('.')[1].replace(/0+$/, '').length;
}

export function roundToTickSize(value: number, tickSize: string): string {
  const tick = parseFloat(tickSize);
  const precision = countDecimals(tickSize);
  const rounded = Math.round(value / tick) * tick;
  return rounded.toFixed(precision);
}

export function roundToStepSize(value: number, stepSize: string): string {
  const step = parseFloat(stepSize);
  const precision = countDecimals(stepSize);
  // Floor for quantity — never round up to avoid insufficient balance
  const rounded = Math.floor(value / step) * step;
  return rounded.toFixed(precision);
}
