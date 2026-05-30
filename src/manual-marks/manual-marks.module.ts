import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ManualMarkEntity } from './entities/manual-mark.entity';
import { ManualMarkRepository } from './manual-mark.repository';
import { ManualMarksController } from './manual-marks.controller';

/**
 * Marcas manuales (Slice 3B). Persistencia CRUD de la capa MyManualMarks. Requiere TypeORM
 * (DB_ENABLED=true en app.module). Sin dependencia del exchange: las marcas no tocan mercado.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ManualMarkEntity])],
  controllers: [ManualMarksController],
  providers: [ManualMarkRepository],
  exports: [ManualMarkRepository],
})
export class ManualMarksModule {}
