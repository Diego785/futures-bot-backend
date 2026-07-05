import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * v2 (Ciclo 4): la pierna TP1 REAL del executor partial-runner en execution_orders —
 * tp1ClientId (orden LIMIT reduceOnly), tp1Filled y su fill real (precio/hora). null/false en v1.
 */
export class AddExecTp11783100000000 implements MigrationInterface {
  name = 'AddExecTp11783100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('execution_orders', [
      new TableColumn({ name: 'tp1ClientId', type: 'varchar', length: '40', isNullable: true }),
      new TableColumn({ name: 'tp1Filled', type: 'boolean', isNullable: false, default: false }),
      new TableColumn({ name: 'tp1FillPrice', type: 'double precision', isNullable: true }),
      new TableColumn({ name: 'tp1FillTime', type: 'bigint', isNullable: true }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumns('execution_orders', ['tp1ClientId', 'tp1Filled', 'tp1FillPrice', 'tp1FillTime']);
  }
}
