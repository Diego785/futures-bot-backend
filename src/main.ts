// Cargar .env ANTES de importar AppModule: los gates de módulos (DB_ENABLED) se
// evalúan al importar app.module, por lo que el .env debe estar en process.env ya.
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { existsSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  const logger = app.get(Logger);
  app.useLogger(logger);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors({ origin: true, credentials: true });
  app.enableShutdownHooks();

  // ─── Dashboard (frontend Vite) servido desde el MISMO origen, si existe el build ───
  // El front usa URLs relativas en producción (ver apiClient): API y WS (/paper, /market) van al
  // mismo puerto. express.static sirve index.html en '/' y los assets; para rutas sin archivo
  // (/api/*, /health, /socket.io) cae a next() → las maneja Nest. La app no tiene routing de
  // cliente (pestañas en estado), así que no hace falta un fallback SPA. Es opcional: si el build
  // no está, el backend sirve solo la API (no rompe el gate del paper-test).
  const frontendDist = join(__dirname, '..', 'frontend', 'dist');
  if (existsSync(frontendDist)) {
    app.useStaticAssets(frontendDist);
    logger.log(`Dashboard servido desde ${frontendDist}`, 'Bootstrap');
  } else {
    logger.warn(`Frontend build ausente (${frontendDist}) — sirvo solo la API`, 'Bootstrap');
  }

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3300);
  await app.listen(port);
}
bootstrap();
