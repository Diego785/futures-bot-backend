import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Crea las tablas del VISOR DE BACKTESTS (V.1): `backtest_runs` (corrida registrada reproducible:
 * params + paramsHash + comando exacto + métricas + serie HTF congelada) y `backtest_signals`
 * (el embudo completo de la corrida: rejected/cancelled/expired/filled, con el porqué causal).
 * Las escribe SOLO el CLI (`--register`); el dashboard las lee (read-only). Columnas camelCase
 * (citadas) para coincidir con las entities, igual que `candles`/`manual_marks`.
 */
export class CreateBacktestRuns1781200000000 implements MigrationInterface {
  name = 'CreateBacktestRuns1781200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'backtest_runs',
        columns: [
          { name: 'id', type: 'varchar', length: '40', isPrimary: true },
          { name: 'createdAt', type: 'bigint', isNullable: false },
          { name: 'symbol', type: 'varchar', length: '20', isNullable: false },
          { name: 'tf', type: 'varchar', length: '5', isNullable: false },
          { name: 'fromTime', type: 'bigint', isNullable: true },
          { name: 'toTime', type: 'bigint', isNullable: true },
          { name: 'candleCount', type: 'int', isNullable: false },
          { name: 'engineVersion', type: 'varchar', length: '40', isNullable: false },
          { name: 'paramsHash', type: 'varchar', length: '16', isNullable: false },
          { name: 'command', type: 'text', isNullable: false },
          { name: 'params', type: 'jsonb', isNullable: false },
          { name: 'metrics', type: 'jsonb', isNullable: false },
          { name: 'biasPoints', type: 'jsonb', isNullable: true },
          { name: 'note', type: 'text', default: "''" },
        ],
      }),
      true,
    );
    await queryRunner.createIndex(
      'backtest_runs',
      new TableIndex({ name: 'idx_backtest_runs_createdat', columnNames: ['createdAt'] }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'backtest_signals',
        columns: [
          { name: 'runId', type: 'varchar', length: '40', isPrimary: true },
          { name: 'intentId', type: 'varchar', length: '80', isPrimary: true },
          { name: 'direction', type: 'varchar', length: '5', isNullable: false },
          { name: 'signalBarTime', type: 'bigint', isNullable: false },
          { name: 'outcome', type: 'varchar', length: '10', isNullable: false },
          { name: 'reason', type: 'varchar', length: '16', isNullable: true },
          { name: 'endTime', type: 'bigint', isNullable: true },
          { name: 'zoneLow', type: 'double precision', isNullable: true },
          { name: 'zoneHigh', type: 'double precision', isNullable: true },
          { name: 'sweptLevel', type: 'double precision', isNullable: true },
          { name: 'wickExtreme', type: 'double precision', isNullable: true },
          { name: 'sweptSwingTime', type: 'bigint', isNullable: true },
          { name: 'entry', type: 'double precision', isNullable: true },
          { name: 'stopLoss', type: 'double precision', isNullable: true },
          { name: 'takeProfit', type: 'double precision', isNullable: true },
          { name: 'invalidationPrice', type: 'double precision', isNullable: true },
          { name: 'cancelBeyond', type: 'double precision', isNullable: true },
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
        ],
      }),
      true,
    );
    await queryRunner.createIndex(
      'backtest_signals',
      new TableIndex({ name: 'idx_backtest_signals_run_time', columnNames: ['runId', 'signalBarTime'] }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('backtest_signals');
    await queryRunner.dropTable('backtest_runs');
  }
}
