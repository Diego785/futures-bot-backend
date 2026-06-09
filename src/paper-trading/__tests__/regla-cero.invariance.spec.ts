import * as fs from 'fs';
import * as path from 'path';

// REGLA CERO — invarianza ESTRUCTURAL: ningún archivo del módulo paper-trading puede referenciar el
// write-API del exchange. Si alguien añade un placeOrder/cancelOrder/etc., este test FALLA. Es la
// salvaguarda que garantiza, por construcción, que el paper-trader es shadow READ-ONLY (no toca órdenes).

const MODULE_DIR = path.join(__dirname, '..');

// Métodos de escritura de IExchangeRest (colocar/modificar/cancelar órdenes, leverage) + el puerto mismo.
const FORBIDDEN = [
  'placeOrder',
  'cancelOrder',
  'cancelAllOpenOrders',
  'placeStopLoss',
  'placeTakeProfit',
  'placeConditional',
  'cancelConditional',
  'cancelAllConditionals',
  'changeLeverage',
  'IExchangeRest',
];

function sourceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts'))
    .map((e) => path.join(dir, e.name));
}

describe('Regla Cero — invarianza del módulo paper-trading', () => {
  it('ningún archivo referencia el write-API del exchange (shadow read-only por construcción)', () => {
    const files = sourceFiles(MODULE_DIR);
    expect(files.length).toBeGreaterThan(0); // hay al menos un archivo que vigilar
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const bad of FORBIDDEN) {
        // toEqual da un mensaje legible (qué archivo, qué token) si alguna vez se viola.
        expect({ file: path.basename(file), token: bad, found: src.includes(bad) }).toEqual({
          file: path.basename(file),
          token: bad,
          found: false,
        });
      }
    }
  });
});
