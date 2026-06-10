// bigint en Postgres vuelve como string en TypeORM (para no perder precisión). Los epoch ms
// (~1.7e12) están muy por debajo de Number.MAX_SAFE_INTEGER, así que convertimos a number al leer
// para respetar el modelo canónico (API-CONTRACT). Mismo criterio que CandleEntity.
export const bigintToNumber = {
  to: (v?: number | null): number | null | undefined => v,
  from: (v?: string | null): number | null | undefined =>
    v == null ? (v as null | undefined) : Number(v),
};
