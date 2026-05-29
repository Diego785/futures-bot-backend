// Placeholder de arquitectura (slice futuro): marcas manuales del usuario sobre las velas.
// Serán el golden dataset para validar el motor SMC. Aún sin implementación.
export type ManualMarkKind = 'OB' | 'Imbalance' | 'Liquidity' | 'Entry' | 'SL' | 'TP';

export interface ManualMark {
  id: string;
  kind: ManualMarkKind;
  tf: string;
  high: number;
  low: number;
  timeStart: number;
  timeEnd: number;
  notes?: string;
}
