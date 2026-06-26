import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExchangeModule } from '../exchange/exchange.module';
import { PaperTradingModule } from '../paper-trading/paper-trading.module';
import { ExecutionOrderEntity } from './entities/execution-order.entity';
import { ExecutionOrderRepository } from './execution-order.repository';
import { OrderExecutorService } from './order-executor.service';
import { ExecutionService } from './execution.service';
import { ExecutionController } from './execution.controller';

// Capa de ejecución real ACOTADA (P.5, docs/EXECUTION-SPEC.md). Se carga SOLO con
// DB_ENABLED && EXECUTION_ENABLED (app.module); además el ExecutionService re-chequea EXECUTION_ENABLED
// antes de tocar una orden (defensa en profundidad). Es la EXCEPCIÓN consciente y gateada a la Regla
// Cero: el paper-trading sigue shadow read-only (su test de invarianza estructural no se ve afectado —
// el código de órdenes vive aquí, no allí). Importa el paper SOLO para suscribirse a sus intents.
@Module({
  imports: [ExchangeModule, TypeOrmModule.forFeature([ExecutionOrderEntity]), PaperTradingModule],
  controllers: [ExecutionController],
  providers: [OrderExecutorService, ExecutionOrderRepository, ExecutionService],
  exports: [OrderExecutorService, ExecutionService],
})
export class ExecutionModule {}
