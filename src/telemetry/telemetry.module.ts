import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DailyTelemetry } from '../trading/entities/daily-telemetry.entity';
import { TelemetryService } from '../trading/telemetry.service';

@Module({
  imports: [TypeOrmModule.forFeature([DailyTelemetry])],
  providers: [TelemetryService],
  exports: [TelemetryService],
})
export class TelemetryModule {}
