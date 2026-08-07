// Journal Vivo — servidor web. Sirve el dashboard y expone la cuenta vía API (solo lectura).
// Endpoints: GET /  ·  GET /api/journal  ·  GET /api/price  ·  GET /api/health
// Deploy-ready: claves por env (BINANCE_API_KEY/SECRET), auth opcional por token (JOURNAL_TOKEN),
// caché server-side para respetar los límites de Binance. Cero dependencias npm.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getSnapshot, getPrice } = require('./lib-binance');

const PORT = Number(process.env.PORT || 3400);
const TOKEN = process.env.JOURNAL_TOKEN || ''; // vacío = sin auth (uso local)
const INDEX = path.join(__dirname, 'public', 'index.html');

function authorized(req, url) {
  if (!TOKEN) return true;
  const q = url.searchParams.get('t');
  const h = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  return q === TOKEN || h === TOKEN;
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, {
    'Content-Type': type + '; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = url.pathname;

  if (req.method !== 'GET') return send(res, 405, JSON.stringify({ error: 'solo GET' }));
  if (route === '/api/health') return send(res, 200, JSON.stringify({ ok: true, ts: Date.now() }));
  if (!authorized(req, url)) return send(res, 401, JSON.stringify({ error: 'token requerido (?t=...)' }));

  try {
    if (route === '/' || route === '/index.html') {
      return send(res, 200, fs.readFileSync(INDEX, 'utf8'), 'text/html');
    }
    if (route === '/api/journal') {
      const snap = await getSnapshot({ maxAgeMs: 20000 });
      return send(res, 200, JSON.stringify(snap));
    }
    if (route === '/api/price') {
      const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const px = await getPrice(symbol);
      return send(res, 200, JSON.stringify({ symbol, price: px, ts: Date.now() }));
    }
    return send(res, 404, JSON.stringify({ error: 'no existe' }));
  } catch (e) {
    console.error(new Date().toISOString(), route, 'ERROR:', e.message);
    return send(res, 503, JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Journal Vivo web → http://localhost:${PORT}${TOKEN ? '/?t=***' : ''} (auth ${TOKEN ? 'ON' : 'off'})`);
});
