import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Slice 3C: añade estado de revisión + notas estructuradas a manual_marks.
 * status NOT NULL DEFAULT 'DRAFT' (las filas existentes quedan en DRAFT).
 */
export class AddMarkReview1780400000000 implements MigrationInterface {
  name = 'AddMarkReview1780400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('manual_marks', [
      new TableColumn({ name: 'status', type: 'varchar', length: '12', default: "'DRAFT'" }),
      new TableColumn({ name: 'context', type: 'text', isNullable: true }),
      new TableColumn({ name: 'reason', type: 'text', isNullable: true }),
      new TableColumn({ name: 'doubt', type: 'text', isNullable: true }),
      new TableColumn({ name: 'outcome', type: 'text', isNullable: true }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumns('manual_marks', ['status', 'context', 'reason', 'doubt', 'outcome']);
  }
}
