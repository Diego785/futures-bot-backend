import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * v2 (Ciclo 4, CYCLE-4-PREREG §8): columnas de las PIERNAS del motor partial-runner en paper_trades —
 * tp1Filled/tp1Time/tp1ExitPrice (el parcial 50 % @ +1R) y runnerTp (el TP2 efectivo del resto).
 * null en las filas del candidato v1 (modo full). Capturadas desde el día uno del gate v2.
 */
export class AddPaperTp11782950000000 implements MigrationInterface {
  name = 'AddPaperTp11782950000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('paper_trades', [
      new TableColumn({ name: 'tp1Filled', type: 'boolean', isNullable: true }),
      new TableColumn({ name: 'tp1Time', type: 'bigint', isNullable: true }),
      new TableColumn({ name: 'tp1ExitPrice', type: 'double precision', isNullable: true }),
      new TableColumn({ name: 'runnerTp', type: 'double precision', isNullable: true }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumns('paper_trades', ['tp1Filled', 'tp1Time', 'tp1ExitPrice', 'runnerTp']);
  }
}
