import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DailyTelemetry } from '../trading/entities/daily-telemetry.entity';
import { StrategyStateSnapshot } from '../trading/entities/strategy-state-snapshot.entity';
import { TelemetryService } from '../trading/telemetry.service';
import { StateSnapshotService } from './state-snapshot.service';

@Module({
  imports: [TypeOrmModule.forFeature([DailyTelemetry, StrategyStateSnapshot])],
  providers: [TelemetryService, StateSnapshotService],
  exports: [TelemetryService, StateSnapshotService],
})
export class TelemetryModule {}
