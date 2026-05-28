import { Controller, Get } from '@nestjs/common';

/**
 * v2 skeleton — single status endpoint.
 *
 * Endpoints de mercado, zonas, señales y journal se añadirán en las fases:
 *  - Fase 3 Market data
 *  - Fase 4 Visor
 *  - Fase 6 Motor SMC offline
 *  - Fase 7 Journal
 *
 * Hasta entonces, este controller existe sólo para confirmar que el backend
 * arranca y responde tras la demolición del v1.
 */
@Controller('api')
export class DashboardController {
  @Get('status')
  getStatus() {
    return {
      ok: true,
      version: 'v2-skeleton',
      timestamp: Date.now(),
    };
  }
}
