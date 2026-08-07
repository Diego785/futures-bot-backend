// Núcleo de lectura del Journal Vivo — SOLO peticiones GET firmadas (key de solo lectura).
// Lo comparten: server.js (website), refresh.js (artifact) y cualquier consumidor futuro.
// NUNCA opera, NUNCA escribe en la cuenta, NUNCA expone la key al cliente.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const META_PATH = path.join(DIR, 'journal-meta.json');
const FAPI = 'https://fapi.binance.com';

function loadKeys() {
  if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
    return { KEY: process.env.BINANCE_API_KEY, SEC: process.env.BINANCE_API_SECRET };
  }
  const file = process.env.BINANCE_KEY_FILE || 'C:/Yo/automation/data/binance-readonly.env';
  const raw = fs.readFileSync(file, 'utf8');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!env.BINANCE_API_KEY || !env.BINANCE_API_SECRET) throw new Error('key no encontrada (env ni archivo)');
  return { KEY: env.BINANCE_API_KEY, SEC: env.BINANCE_API_SECRET };
}
const { KEY, SEC } = loadKeys();

let clockOffset = 0, clockSyncAt = 0;
async function syncClock() {
  if (Date.now() - clockSyncAt < 10 * 60 * 1000) return;
  const st = await fetch(FAPI + '/fapi/v1/time').then(r => r.json());
  clockOffset = st.serverTime - Date.now();
  clockSyncAt = Date.now();
}

async function signed(pathname, params = {}) {
  await syncClock();
  const qs = new URLSearchParams({ ...params, timestamp: Date.now() + clockOffset, recvWindow: 10000 }).toString();
  const sig = crypto.createHmac('sha256', SEC).update(qs).digest('hex');
  const r = await fetch(`${FAPI}${pathname}?${qs}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': KEY } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${pathname} → ${r.status} ${JSON.stringify(body).slice(0, 140)}`);
  return body;
}

const short = (sym) => sym.replace('USDT', '');
const fmtTs = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
function laPazNow() {
  // Bolivia = UTC−4 fijo (sin DST) — cálculo manual para no depender del ICU del runtime (Alpine)
  const d = new Date(Date.now() - 4 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

async function buildSnapshot() {
  const META = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  const t0 = Date.parse(META.eraStart);
  const pbStart = Date.parse(META.playbookStart);

  let posAll;
  try { posAll = await signed('/fapi/v3/positionRisk'); } catch { posAll = await signed('/fapi/v2/positionRisk'); }
  const openPos = posAll.filter(p => Number(p.positionAmt) !== 0);

  const bal = await signed('/fapi/v2/balance');
  const usdt = (bal || []).find(b => b.asset === 'USDT') || {};
  const balance = { total: Number(Number(usdt.balance || 0).toFixed(2)), available: Number(Number(usdt.availableBalance || 0).toFixed(2)) };

  const trades = [];
  let incomeNet = 0;

  for (const symbol of META.symbols) {
    // userTrades limita cada consulta a ~7 días → recorrer por ventanas de 6 días (dedup por id)
    const byId = new Map();
    let cursor = t0;
    const nowMs = Date.now() + clockOffset + 60000;
    while (cursor < nowMs) {
      const end = Math.min(cursor + 6 * 24 * 3600 * 1000, nowMs);
      const batch = await signed('/fapi/v1/userTrades', { symbol, startTime: cursor, endTime: end, limit: 1000 });
      for (const f of batch) byId.set(f.id, f);
      cursor = batch.length >= 1000 ? batch[batch.length - 1].time + 1 : end + 1;
    }
    const fills = [...byId.values()];
    fills.sort((a, b) => a.time - b.time || a.id - b.id);
    let net = 0, cur = null;
    for (const f of fills) {
      const q = Number(f.qty) * (f.side === 'BUY' ? 1 : -1);
      if (Math.abs(net) < 1e-9) {
        cur = { symbol, dir: q > 0 ? 'LONG' : 'SHORT', openTime: f.time, closeTime: null,
                openQty: 0, openCost: 0, closeQty: 0, closeCost: 0, realized: 0, fees: 0, qtyMax: 0 };
        trades.push(cur);
      }
      const increases = Math.abs(net + q) > Math.abs(net) + 1e-12;
      if (increases) { cur.openQty += Math.abs(q); cur.openCost += Math.abs(q) * Number(f.price); }
      else { cur.closeQty += Math.abs(q); cur.closeCost += Math.abs(q) * Number(f.price); }
      cur.realized += Number(f.realizedPnl);
      cur.fees += Number(f.commission);
      net += q;
      cur.qtyMax = Math.max(cur.qtyMax, Math.abs(net));
      if (Math.abs(net) < 1e-9) cur.closeTime = f.time;
    }
    const inc = await signed('/fapi/v1/income', { symbol, startTime: t0, limit: 1000 });
    for (const i of inc) incomeNet += Number(i.income);
  }

  const algoBySym = {};
  for (const p of openPos) {
    try {
      const ao = await signed('/fapi/v1/openAlgoOrders', { symbol: p.symbol });
      algoBySym[p.symbol] = ao.orders || ao || [];
    } catch { algoBySym[p.symbol] = []; }
  }

  let btcNow;
  if (openPos.length) btcNow = Number(openPos[0].markPrice);
  else btcNow = Number((await fetch(`${FAPI}/fapi/v1/ticker/price?symbol=${META.symbols[0]}`).then(r => r.json())).price);

  const seen = {};
  const out = trades.map(t => {
    const mmdd = new Date(t.openTime).toISOString().slice(5, 10).replace('-', '');
    let id = `${short(t.symbol)}-${mmdd}`;
    if (seen[id] != null) id += String.fromCharCode(98 + seen[`${short(t.symbol)}-${mmdd}`]++);
    else seen[id] = 0;
    const m = META.trades[id] || {};
    const abierta = t.closeTime == null;
    const entry = t.openQty ? t.openCost / t.openQty : 0;
    const exit = t.closeQty ? t.closeCost / t.closeQty : null;
    const qtyNum = abierta ? Math.abs(Number((openPos.find(p => p.symbol === t.symbol) || {}).positionAmt || t.qtyMax)) : t.qtyMax;

    const algos = algoBySym[t.symbol] || [];
    const closeSide = t.dir === 'SHORT' ? 'BUY' : 'SELL';
    const slLive = algos.find(o => (o.type || '').startsWith('STOP') && o.side === closeSide);
    const tpLimit = algos.find(o => o.type === 'TAKE_PROFIT' && o.side === closeSide);
    const tpMkt = algos.find(o => o.type === 'TAKE_PROFIT_MARKET' && o.side === closeSide);

    const slRisk = m.sl !== undefined ? m.sl : (abierta && slLive ? Number(slLive.triggerPrice) : null);
    const riskUsd = slRisk != null ? Math.abs(entry - slRisk) * t.qtyMax : null;
    const usd = abierta ? null : Number((t.realized - t.fees).toFixed(2));
    const r = !abierta && riskUsd ? Number((usd / riskUsd).toFixed(2)) : null;

    return {
      id, sym: short(t.symbol), dir: t.dir, estado: abierta ? 'abierta' : 'cerrada',
      era: t.openTime >= pbStart ? 'playbook' : 'pre-playbook',
      entry: Number(entry.toFixed(1)), exit: exit != null ? Number(exit.toFixed(1)) : null,
      sl: abierta ? (slLive ? Number(slLive.triggerPrice) : slRisk) : slRisk,
      be: abierta ? Number(entry.toFixed(1)) : undefined,
      tp1: abierta ? (tpLimit ? Number(tpLimit.triggerPrice) : m.tp1) : m.tp1,
      runner: abierta ? (tpMkt ? Number(tpMkt.triggerPrice) : m.runner) : m.runner,
      qty: `${t.qtyMax} ${short(t.symbol)}`, qtyNum,
      riskUsd: riskUsd != null ? Number(riskUsd.toFixed(2)) : null,
      r, usd,
      abierta: fmtTs(t.openTime), cerrada: t.closeTime ? fmtTs(t.closeTime) : null,
      dur: abierta ? 'en curso' : fmtDur(t.closeTime - t.openTime),
      grade: m.grade || '—', planFlag: m.planFlag !== undefined ? m.planFlag : false,
      gates: m.gates || { 'Línea previa': 'bad', 'Sesgo 4H': 'na', 'Liquidez barrida': 'na', 'SL escrito': slRisk != null ? 'ok' : 'bad', 'Tamaño fórmula': 'na', 'Gestión': 'na' },
      gateNote: m.gateNote || {},
      nota: m.nota || '<b>Trade nueva detectada por la API</b> — aún sin audit del copiloto. Pedile el post-mortem en el chat para calificarla.'
    };
  });

  return {
    updatedAt: `${laPazNow()} (La Paz) · leído de tu cuenta ✓`,
    btcNow: Number(btcNow.toFixed(1)),
    incomeNet: Number(incomeNet.toFixed(2)),
    balance,
    trades: out,
  };
}

// ── caché para no golpear los límites de Binance ──
let snapCache = null, snapAt = 0, snapPending = null;
async function getSnapshot({ maxAgeMs = 20000 } = {}) {
  if (snapCache && Date.now() - snapAt < maxAgeMs) return snapCache;
  if (snapPending) return snapPending; // colapsa peticiones concurrentes
  snapPending = buildSnapshot()
    .then(s => { snapCache = s; snapAt = Date.now(); return s; })
    .finally(() => { snapPending = null; });
  return snapPending;
}

let priceCache = {}, pricePending = {};
async function getPrice(symbol) {
  const c = priceCache[symbol];
  if (c && Date.now() - c.at < 3000) return c.px;
  if (pricePending[symbol]) return pricePending[symbol];
  pricePending[symbol] = fetch(`${FAPI}/fapi/v1/ticker/price?symbol=${symbol}`)
    .then(r => r.json())
    .then(j => { const px = Number(j.price); priceCache[symbol] = { px, at: Date.now() }; return px; })
    .finally(() => { delete pricePending[symbol]; });
  return pricePending[symbol];
}

module.exports = { getSnapshot, getPrice };
