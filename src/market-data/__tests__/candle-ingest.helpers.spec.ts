import { tfToMs, reconcileFrom } from '../candle-ingest.service';

describe('tfToMs', () => {
  it('convierte los 4 timeframes del alcance', () => {
    expect(tfToMs('15m')).toBe(900_000);
    expect(tfToMs('1h')).toBe(3_600_000);
    expect(tfToMs('4h')).toBe(14_400_000);
    expect(tfToMs('1d')).toBe(86_400_000);
  });
  it('soporta 1m y 1w', () => {
    expect(tfToMs('1m')).toBe(60_000);
    expect(tfToMs('1w')).toBe(604_800_000);
  });
  it('lanza con timeframe inválido', () => {
    expect(() => tfToMs('raro')).toThrow(/inválido/);
  });
});

describe('reconcileFrom (solape de 2 velas)', () => {
  const NOW = 10_000_000_000;

  it('con última vela persistida → last - 2*tfMs (solape)', () => {
    expect(reconcileFrom(5_000_000, '15m', NOW)).toBe(5_000_000 - 2 * 900_000);
    expect(reconcileFrom(5_000_000, '1h', NOW)).toBe(5_000_000 - 2 * 3_600_000);
  });

  it('sin velas previas → now - lookback*tfMs', () => {
    expect(reconcileFrom(null, '1h', NOW, 500)).toBe(NOW - 500 * 3_600_000);
  });

  it('el solape garantiza re-pedir la última vela (no perder cierres)', () => {
    const last = 5_000_000;
    const from = reconcileFrom(last, '15m', NOW);
    expect(from).toBeLessThan(last); // arranca antes de la última → la reincluye
  });
});
