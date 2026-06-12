import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Crea `paper_trades` (P.2 del gate #7): el registro mecánico del paper-test — cada señal del
 * candidato CONGELADO en vivo con su desenlace simulado + instrumentación touched-vs-crossed.
 * La escribe SOLO PaperTradingService (shadow read-only, Regla Cero); el dashboard la lee.
 */
export class CreatePaperTrades1781300000000 implements MigrationInterface {
  name = 'CreatePaperTrades1781300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'paper_trades',
        columns: [
          { name: 'intentId', type: 'varchar', length: '80', isPrimary: true },
          { name: 'symbol', type: 'varchar', length: '20', isNullable: false },
          { name: 'tf', type: 'varchar', length: '5', isNullable: false },
          { name: 'direction', type: 'varchar', length: '5', isNullable: false },
          { name: 'signalBarTime', type: 'bigint', isNullable: false },
          { name: 'state', type: 'varchar', length: '10', isNullable: false },
          { name: 'entry', type: 'double precision', isNullable: false },
          { name: 'stopLoss', type: 'double precision', isNullable: false },
          { name: 'takeProfit', type: 'double precision', isNullable: false },
          { name: 'tpSource', type: 'varchar', length: '20', isNullable: true },
          { name: 'invalidationPrice', type: 'double precision', isNullable: true },
          { name: 'cancelBeyond', type: 'double precision', isNullable: true },
          { name: 'zoneLow', type: 'double precision', isNullable: true },
          { name: 'zoneHigh', type: 'double precision', isNullable: true },
          { name: 'sweptLevel', type: 'double precision', isNullable: true },
          { name: 'wickExtreme', type: 'double precision', isNullable: true },
          { name: 'sweptSwingTime', type: 'bigint', isNullable: true },
          { name: 'entryTime', type: 'bigint', isNullable: true },
          { name: 'entryPrice', type: 'double precision', isNullable: true },
          { name: 'exitTime', type: 'bigint', isNullable: true },
          { name: 'exitPrice', type: 'double precision', isNullable: true },
          { name: 'exitReason', type: 'varchar', length: '10', isNullable: true },
          { name: 'grossR', type: 'double precision', isNullable: true },
          { name: 'costR', type: 'double precision', isNullable: true },
          { name: 'rMultiple', type: 'double precision', isNullable: true },
          { name: 'movedToBE', type: 'boolean', isNullable: true },
          { name: 'barsToFill', type: 'int', isNullable: true },
          { name: 'barsHeld', type: 'int', isNullable: true },
          { name: 'cancelReason', type: 'varchar', length: '16', isNullable: true },
          { name: 'entryPenetration', type: 'double precision', isNullable: true },
          { name: 'tpPenetration', type: 'double precision', isNullable: true },
          { name: 'engineVersion', type: 'varchar', length: '40', isNullable: false },
          { name: 'paramsHash', type: 'varchar', length: '16', isNullable: false },
          { name: 'createdAt', type: 'bigint', isNullable: false },
          { name: 'updatedAt', type: 'bigint', isNullable: false },
        ],
      }),
      true,
    );
    await queryRunner.createIndex(
      'paper_trades',
      new TableIndex({
        name: 'uq_paper_trades_sym_time_dir',
        columnNames: ['symbol', 'signalBarTime', 'direction'],
        isUnique: true,
      }),
    );
    await queryRunner.createIndex(
      'paper_trades',
      new TableIndex({ name: 'idx_paper_trades_state', columnNames: ['state'] }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('paper_trades');
  }
}
