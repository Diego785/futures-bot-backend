import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Añade `phase` a paper_trades: separa el histórico rehidratado (contexto) del forward-test real
 * del gate #7. Las filas existentes quedan como 'backfill' (no eran el forward-test). El reloj
 * oficial lo fija PAPER_CLOCK_START en el deploy; a partir de ahí las señales nuevas son 'live'.
 */
export class AddPaperPhase1781400000000 implements MigrationInterface {
  name = 'AddPaperPhase1781400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'paper_trades',
      new TableColumn({ name: 'phase', type: 'varchar', length: '10', isNullable: false, default: "'backfill'" }),
    );
    await queryRunner.createIndex(
      'paper_trades',
      new TableIndex({ name: 'idx_paper_trades_phase', columnNames: ['phase'] }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('paper_trades', 'idx_paper_trades_phase');
    await queryRunner.dropColumn('paper_trades', 'phase');
  }
}
