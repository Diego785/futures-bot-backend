import 'reflect-metadata';
import 'dotenv/config'; // lee el .env (DB_*) — sin esto `npm run migration:run` exige exportar las vars a mano
import { DataSource } from 'typeorm';

/**
 * DataSource para el CLI de TypeORM (migraciones). Independiente del runtime de Nest.
 * Lee credenciales de process.env (se pasan en la línea de comando). synchronize:false
 * SIEMPRE — el esquema solo cambia vía migraciones explícitas, nunca automáticamente.
 *
 * Uso (tras `npm run build`):
 *   typeorm migration:run    -d dist/data-source.js
 *   typeorm migration:revert -d dist/data-source.js
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  synchronize: false,
  logging: ['error', 'warn'],
  entities: ['dist/**/*.entity.js'],
  migrations: ['dist/migrations/*.js'],
});
