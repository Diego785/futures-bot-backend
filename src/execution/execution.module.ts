import { Module } from '@nestjs/common';
import { ExchangeModule } from '../exchange/exchange.module';
import { OrderExecutorService } from './order-executor.service';

// Capa de ejecución real ACOTADA (P.5, docs/EXECUTION-SPEC.md). En P.5.2 solo expone el executor
// (building-block sobre IExchangeRest). El cableado al motor + arnés de riesgo + kill-switch llegan
// en P.5.3. NO se importa en app.module todavía: nada ejecuta sin activación consciente.
@Module({
  imports: [ExchangeModule],
  providers: [OrderExecutorService],
  exports: [OrderExecutorService],
})
export class ExecutionModule {}
