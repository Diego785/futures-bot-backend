import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ManualMarkRepository } from './manual-mark.repository';
import { ManualMarkEntity } from './entities/manual-mark.entity';
import { GetManualMarksQueryDto } from './dto/get-manual-marks-query.dto';
import { CreateManualMarkDto } from './dto/create-manual-mark.dto';
import { UpdateManualMarkDto } from './dto/update-manual-mark.dto';
import { toManualMarkDto } from './manual-mark.presenter';
import { computeRr } from './manual-mark.mapper';

/**
 * API de marcas manuales (Slice 3B). CRUD local de la capa MyManualMarks: OB, FVG,
 * Liquidity y TradePlan (Long/Short). NO llama al exchange, NO usa credenciales, NO crea
 * señales ni convierte un TradePlan en operación real. Solo persiste lo que el usuario dibuja.
 */
@Controller('api/manual-marks')
export class ManualMarksController {
  constructor(private readonly repo: ManualMarkRepository) {}

  @Get()
  async list(@Query() q: GetManualMarksQueryDto) {
    const rows = await this.repo.findBySymbolTf(q.symbol, q.tf);
    return { symbol: q.symbol, tf: q.tf, count: rows.length, marks: rows.map(toManualMarkDto) };
  }

  @Post()
  async create(@Body() dto: CreateManualMarkDto) {
    const now = Date.now();
    const e = new ManualMarkEntity();
    e.id = dto.id ?? randomUUID();
    e.sourceLayer = 'MyManualMarks';
    e.kind = dto.kind;
    e.symbol = dto.symbol;
    e.tf = dto.tf;
    e.timeStart = dto.timeStart ?? null;
    e.timeEnd = dto.timeEnd ?? null;
    e.priceLow = dto.priceLow ?? null;
    e.priceHigh = dto.priceHigh ?? null;
    e.price = dto.price ?? null;
    e.side = dto.side ?? null;
    e.entry = dto.entry ?? null;
    e.stopLoss = dto.stopLoss ?? null;
    e.takeProfit = dto.takeProfit ?? null;
    e.rr = computeRr(dto.kind, e.entry, e.stopLoss, e.takeProfit);
    e.note = dto.note ?? '';
    e.createdAt = now;
    e.updatedAt = now;
    return toManualMarkDto(await this.repo.save(e));
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateManualMarkDto) {
    const e = await this.repo.findById(id);
    if (!e) throw new NotFoundException(`marca ${id} no existe`);
    if (dto.timeStart !== undefined) e.timeStart = dto.timeStart;
    if (dto.timeEnd !== undefined) e.timeEnd = dto.timeEnd;
    if (dto.priceLow !== undefined) e.priceLow = dto.priceLow;
    if (dto.priceHigh !== undefined) e.priceHigh = dto.priceHigh;
    if (dto.price !== undefined) e.price = dto.price;
    if (dto.side !== undefined) e.side = dto.side;
    if (dto.entry !== undefined) e.entry = dto.entry;
    if (dto.stopLoss !== undefined) e.stopLoss = dto.stopLoss;
    if (dto.takeProfit !== undefined) e.takeProfit = dto.takeProfit;
    if (dto.note !== undefined) e.note = dto.note;
    e.rr = computeRr(e.kind, e.entry, e.stopLoss, e.takeProfit);
    e.updatedAt = Date.now();
    return toManualMarkDto(await this.repo.save(e));
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const ok = await this.repo.deleteById(id);
    if (!ok) throw new NotFoundException(`marca ${id} no existe`);
    return { deleted: true, id };
  }
}
