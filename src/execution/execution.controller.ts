import { Body, Controller, Get, Headers, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionService } from './execution.service';
import { ExecutionOrderRepository } from './execution-order.repository';

// Control de la ejecución real acotada (P.5.3/P.5.4). El kill-switch es la salvaguarda MANUAL
// (EXECUTION-SPEC §5). Estos endpoints solo existen cuando EXECUTION_ENABLED carga el módulo.
// Si EXEC_API_TOKEN está seteado (OBLIGATORIO en real: el puerto es público), exigen el header
// x-exec-token — sin token correcto, 401.
@Controller('api/exec')
export class ExecutionController {
  private readonly token: string | undefined;

  constructor(
    private readonly exec: ExecutionService,
    private readonly orders: ExecutionOrderRepository,
    config: ConfigService,
  ) {
    this.token = config.get<string>('EXEC_API_TOKEN') || undefined;
  }

  private check(token?: string): void {
    if (this.token && token !== this.token) throw new UnauthorizedException('x-exec-token inválido');
  }

  @Get('status')
  status(@Headers('x-exec-token') token?: string): unknown {
    this.check(token);
    return this.exec.status();
  }

  // Historial de la EJECUCIÓN REAL (execution_orders) para la vista "Real" del dashboard.
  @Get('trades')
  async trades(
    @Headers('x-exec-token') token?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    this.check(token);
    const rows = await this.orders.findAll(Math.min(parseInt(limit ?? '500', 10) || 500, 2000));
    return { count: rows.length, trades: rows };
  }

  @Post('kill')
  async kill(
    @Headers('x-exec-token') token?: string,
    @Body() body?: { reason?: string },
  ): Promise<{ ok: boolean }> {
    this.check(token);
    await this.exec.killAll(body?.reason ?? 'kill-switch manual');
    return { ok: true };
  }

  // Inyector de prueba (TESTNET-ONLY, validado por el servicio): dispara un intent sintético que llena
  // de inmediato para verificar el lifecycle completo sin esperar una señal natural.
  @Post('test-intent')
  testIntent(
    @Headers('x-exec-token') token: string | undefined,
    @Body() body: { symbol: string; direction?: 'LONG' | 'SHORT'; stopPct?: number; rMultiple?: number },
  ): Promise<unknown> {
    this.check(token);
    return this.exec.injectTestIntent(body.symbol, body.direction ?? 'LONG', body.stopPct, body.rMultiple);
  }
}
