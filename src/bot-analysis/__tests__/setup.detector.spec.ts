import { detectSetups, type SetupCandle } from '../setup.detector';
import type { ConfluenceZone } from '../confluence.scorer';
import type { BotOb } from '../ob.detector';

// Zona de confluencia alcista (demanda) [100, 102], formada en t=10.
const zone = (): ConfluenceZone =>
  ({ id: 'conf1', direction: 'bullish', priceLow: 100, priceHigh: 102, timeStart: 10, rating: 'HIGH', score: 90 } as unknown as ConfluenceZone);
const ob = (id: string, dir: 'bullish' | 'bearish', low: number, high: number, originTime: number): BotOb =>
  ({ id, direction: dir, obLow: low, obHigh: high, originTime, confirmedAtTime: originTime + 1 } as unknown as BotOb);
const c = (openTime: number, high: number, low: number, close: number): SetupCandle => ({ openTime, high, low, close });

describe('detectSetups', () => {
  it('WATCHING: el precio no ha vuelto a la zona', () => {
    const candles = [c(11, 106, 104, 105), c(12, 107, 105, 106)];
    const [s] = detectSetups('BTCUSDT', '15m', [zone()], [], candles, 106);
    expect(s.state).toBe('WATCHING');
    expect(s.direction).toBe('bullish');
    expect(s.mitigatedAtTime).toBeNull();
  });

  it('MITIGATED: el precio entró a la zona pero no hay confirmación', () => {
    const candles = [c(11, 106, 104, 105), c(12, 103, 101, 102.5)];
    const [s] = detectSetups('BTCUSDT', '15m', [zone()], [], candles, 104);
    expect(s.state).toBe('MITIGATED');
    expect(s.mitigatedAtTime).toBe(12);
  });

  it('ARMED: tras la mitigación se forma un OB de confirmación en la zona', () => {
    const candles = [c(11, 106, 104, 105), c(12, 103, 101, 102.5), c(13, 104, 102, 103.5)];
    const obs = [ob('obc', 'bullish', 100.5, 101.5, 13)]; // alcista, tras mitigación (12), solapa la zona
    const [s] = detectSetups('BTCUSDT', '15m', [zone()], obs, candles, 104);
    expect(s.state).toBe('ARMED');
    expect(s.confirmationObId).toBe('obc');
    expect(s.armedAtTime).toBe(14);
  });

  it('un OB de confirmación ANTERIOR a la mitigación no arma el setup', () => {
    const candles = [c(11, 106, 104, 105), c(12, 103, 101, 102.5)];
    const obs = [ob('obPrevio', 'bullish', 100.5, 101.5, 5)]; // antes de la mitigación → no cuenta
    const [s] = detectSetups('BTCUSDT', '15m', [zone()], obs, candles, 104);
    expect(s.state).toBe('MITIGATED');
  });

  it('setup invalidado (cierre bajo el borde distal) se excluye', () => {
    const candles = [c(11, 103, 101, 101), c(12, 101, 98, 98.5)]; // cierra 98.5 < 100 (distal)
    expect(detectSetups('BTCUSDT', '15m', [zone()], [], candles, 99)).toHaveLength(0);
  });
});
