import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Crea `execution_orders` (P.5.3): el registro de la EJECUCIÓN REAL acotada del candidato congelado —
 * ciclo de vida real de cada intent (límite → fill → SL/TP → cierre) con precios/fees reales, separando
 * testnet de real. Join 1:1 con `paper_trades` por intentId para la comparación real-vs-paper.
 */
export class CreateExecutionOrders1782800000000 implements MigrationInterface {
  name = 'CreateExecutionOrders1782800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'execution_orders',
        columns: [
          { name: 'intentId', type: 'varchar', length: '80', isPrimary: true },
          { name: 'symbol', type: 'varchar', length: '20', isNullable: false },
          { name: 'direction', type: 'varchar', length: '5', isNullable: false },
          { name: 'signalBarTime', type: 'bigint', isNullable: false },
          { name: 'state', type: 'varchar', length: '12', isNullable: false },
          { name: 'testnet', type: 'boolean', isNullable: false, default: true },
          { name: 'entry', type: 'double precision', isNullable: false },
          { name: 'stopLoss', type: 'double precision', isNullable: false },
          { name: 'takeProfit', type: 'double precision', isNullable: false },
          { name: 'cancelBeyond', type: 'double precision', isNullable: true },
          { name: 'quantity', type: 'double precision', isNullable: false },
          { name: 'notionalUsd', type: 'double precision', isNullable: false },
          { name: 'riskUsd', type: 'double precision', isNullable: false },
          { name: 'entryClientId', type: 'varchar', length: '40', isNullable: false },
          { name: 'entryOrderId', type: 'varchar', length: '32', isNullable: true },
          { name: 'slClientId', type: 'varchar', length: '40', isNullable: true },
          { name: 'slAlgoId', type: 'varchar', length: '32', isNullable: true },
          { name: 'tpClientId', type: 'varchar', length: '40', isNullable: true },
          { name: 'tpAlgoId', type: 'varchar', length: '32', isNullable: true },
          { name: 'entryFillTime', type: 'bigint', isNullable: true },
          { name: 'entryFillPrice', type: 'double precision', isNullable: true },
          { name: 'entryFeeUsd', type: 'double precision', isNullable: true },
          { name: 'movedToBE', type: 'boolean', isNullable: false, default: false },
          { name: 'exitTime', type: 'bigint', isNullable: true },
          { name: 'exitPrice', type: 'double precision', isNullable: true },
          { name: 'exitFeeUsd', type: 'double precision', isNullable: true },
          { name: 'exitReason', type: 'varchar', length: '10', isNullable: true },
          { name: 'realizedR', type: 'double precision', isNullable: true },
          { name: 'realizedUsd', type: 'double precision', isNullable: true },
          { name: 'cancelReason', type: 'varchar', length: '16', isNullable: true },
          { name: 'engineVersion', type: 'varchar', length: '40', isNullable: false },
          { name: 'createdAt', type: 'bigint', isNullable: false },
          { name: 'updatedAt', type: 'bigint', isNullable: false },
        ],
      }),
      true,
    );
    await queryRunner.createIndex(
      'execution_orders',
      new TableIndex({ name: 'idx_execution_orders_state', columnNames: ['state'] }),
    );
    await queryRunner.createIndex(
      'execution_orders',
      new TableIndex({ name: 'idx_execution_orders_symbol', columnNames: ['symbol'] }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('execution_orders');
  }
}
