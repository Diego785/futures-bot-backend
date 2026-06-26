import { Body, Controller, Get, Post } from '@nestjs/common';
import { ExecutionService } from './execution.service';

// Control de la ejecución real acotada (P.5.3). El kill-switch es la salvaguarda MANUAL (EXECUTION-SPEC
// §5): cancela TODAS las órdenes, aplana posiciones y detiene. Estos endpoints solo existen cuando
// EXECUTION_ENABLED carga el ExecutionModule.
@Controller('api/exec')
export class ExecutionController {
  constructor(private readonly exec: ExecutionService) {}

  @Get('status')
  status(): unknown {
    return this.exec.status();
  }

  @Post('kill')
  async kill(@Body() body?: { reason?: string }): Promise<{ ok: boolean }> {
    await this.exec.killAll(body?.reason ?? 'kill-switch manual');
    return { ok: true };
  }

  // Inyector de prueba (TESTNET-ONLY, validado por el servicio): dispara un intent sintético que llena
  // de inmediato para verificar el lifecycle completo sin esperar una señal natural.
  @Post('test-intent')
  testIntent(
    @Body() body: { symbol: string; direction?: 'LONG' | 'SHORT'; stopPct?: number; rMultiple?: number },
  ): Promise<unknown> {
    return this.exec.injectTestIntent(body.symbol, body.direction ?? 'LONG', body.stopPct, body.rMultiple);
  }
}
