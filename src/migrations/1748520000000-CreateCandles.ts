import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Crea la tabla `candles` (modelo canónico, ver docs/API-CONTRACT.md).
 * PK compuesta (symbol, tf, openTime) — base del upsert idempotente.
 * Índice (symbol, tf, closeTime) para consultas por rango.
 */
export class CreateCandles1748520000000 implements MigrationInterface {
  name = 'CreateCandles1748520000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'candles',
        columns: [
          { name: 'symbol', type: 'varchar', length: '20', isPrimary: true },
          { name: 'tf', type: 'varchar', length: '5', isPrimary: true },
          { name: 'openTime', type: 'bigint', isPrimary: true },
          { name: 'closeTime', type: 'bigint', isNullable: false },
          { name: 'open', type: 'double precision', isNullable: false },
          { name: 'high', type: 'double precision', isNullable: false },
          { name: 'low', type: 'double precision', isNullable: false },
          { name: 'close', type: 'double precision', isNullable: false },
          { name: 'volume', type: 'double precision', isNullable: false },
          { name: 'quoteVolume', type: 'double precision', isNullable: true },
          { name: 'trades', type: 'int', isNullable: true },
          { name: 'isClosed', type: 'boolean', isNullable: false, default: true },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'candles',
      new TableIndex({
        name: 'idx_candles_symbol_tf_closetime',
        columnNames: ['symbol', 'tf', 'closeTime'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('candles');
  }
}
