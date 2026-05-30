import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Crea la tabla `manual_marks` (Slice 3B). PK = id (uuid del cliente/servidor).
 * Índice (symbol, tf) para la carga de marcas por gráfica. Columnas camelCase (citadas)
 * para coincidir con la entidad, igual que `candles`.
 */
export class CreateManualMarks1780300000000 implements MigrationInterface {
  name = 'CreateManualMarks1780300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'manual_marks',
        columns: [
          { name: 'id', type: 'varchar', length: '64', isPrimary: true },
          { name: 'sourceLayer', type: 'varchar', length: '32', default: "'MyManualMarks'" },
          { name: 'kind', type: 'varchar', length: '16', isNullable: false },
          { name: 'symbol', type: 'varchar', length: '20', isNullable: false },
          { name: 'tf', type: 'varchar', length: '5', isNullable: false },
          { name: 'timeStart', type: 'bigint', isNullable: true },
          { name: 'timeEnd', type: 'bigint', isNullable: true },
          { name: 'priceLow', type: 'double precision', isNullable: true },
          { name: 'priceHigh', type: 'double precision', isNullable: true },
          { name: 'price', type: 'double precision', isNullable: true },
          { name: 'side', type: 'varchar', length: '5', isNullable: true },
          { name: 'entry', type: 'double precision', isNullable: true },
          { name: 'stopLoss', type: 'double precision', isNullable: true },
          { name: 'takeProfit', type: 'double precision', isNullable: true },
          { name: 'rr', type: 'double precision', isNullable: true },
          { name: 'note', type: 'text', default: "''" },
          { name: 'createdAt', type: 'bigint', isNullable: false },
          { name: 'updatedAt', type: 'bigint', isNullable: false },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'manual_marks',
      new TableIndex({
        name: 'idx_manual_marks_symbol_tf',
        columnNames: ['symbol', 'tf'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('manual_marks');
  }
}
