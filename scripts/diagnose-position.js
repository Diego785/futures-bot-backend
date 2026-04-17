/**
 * Diagnostic script: check real state of BTCUSDT position on Binance Futures
 * Verifies: position open, SL/TP protection orders, algo orders, recent fills
 */
const crypto = require('crypto');
const https = require('https');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const BASE_URL = process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com';

if (!API_KEY || !API_SECRET) {
  console.error('Missing BINANCE_API_KEY or BINANCE_API_SECRET');
  process.exit(1);
}

function sign(query) {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

function signedRequest(method, pathUrl, params = {}) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString();
    const allParams = { ...params, timestamp, recvWindow: '10000' };
    const queryString = new URLSearchParams(allParams).toString();
    const signature = sign(queryString);
    const url = new URL(`${BASE_URL}${pathUrl}?${queryString}&signature=${signature}`);

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: { 'X-MBX-APIKEY': API_KEY },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject({ status: res.statusCode, body: json });
          } else {
            resolve(json);
          }
        } catch (e) {
          reject({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const symbol = 'BTCUSDT';
  console.log(`\n=== DIAGNOSTIC: ${symbol} position state at ${new Date().toISOString()} ===\n`);

  // 1. Current position
  try {
    const positions = await signedRequest('GET', '/fapi/v2/positionRisk', { symbol });
    const active = positions.filter(p => parseFloat(p.positionAmt) !== 0);
    console.log('### POSITIONS ###');
    if (active.length === 0) {
      console.log('NO ACTIVE POSITION on Binance');
    } else {
      for (const p of active) {
        console.log({
          symbol: p.symbol,
          positionAmt: p.positionAmt,
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          unRealizedProfit: p.unRealizedProfit,
          leverage: p.leverage,
          marginType: p.marginType,
          liquidationPrice: p.liquidationPrice,
          updateTime: new Date(p.updateTime).toISOString(),
        });
      }
    }
  } catch (e) {
    console.log('positionRisk error:', JSON.stringify(e));
  }

  // 2. Open orders (regular)
  try {
    const openOrders = await signedRequest('GET', '/fapi/v1/openOrders', { symbol });
    console.log(`\n### REGULAR OPEN ORDERS (${openOrders.length}) ###`);
    for (const o of openOrders) {
      console.log({
        orderId: o.orderId,
        clientOrderId: o.clientOrderId,
        side: o.side,
        type: o.type,
        status: o.status,
        price: o.price,
        stopPrice: o.stopPrice,
        origQty: o.origQty,
        executedQty: o.executedQty,
        reduceOnly: o.reduceOnly,
        time: new Date(o.time).toISOString(),
      });
    }
  } catch (e) {
    console.log('openOrders error:', JSON.stringify(e));
  }

  // 3. Open algo orders (STOP_MARKET, TAKE_PROFIT_MARKET)
  try {
    const algoOrders = await signedRequest('GET', '/fapi/v1/algoOrders/open', { symbol });
    console.log(`\n### ALGO OPEN ORDERS (${algoOrders.orders ? algoOrders.orders.length : 'unknown'}) ###`);
    console.log(JSON.stringify(algoOrders, null, 2));
  } catch (e) {
    console.log('algoOrders/open error:', JSON.stringify(e));
  }

  // 4. Recent user trades (last 10 fills)
  try {
    const userTrades = await signedRequest('GET', '/fapi/v1/userTrades', { symbol, limit: '10' });
    console.log(`\n### RECENT USER TRADES (last ${userTrades.length} fills) ###`);
    for (const t of userTrades) {
      console.log({
        time: new Date(t.time).toISOString(),
        orderId: t.orderId,
        side: t.side,
        price: t.price,
        qty: t.qty,
        realizedPnl: t.realizedPnl,
        commission: t.commission,
        commissionAsset: t.commissionAsset,
        maker: t.maker,
      });
    }
  } catch (e) {
    console.log('userTrades error:', JSON.stringify(e));
  }

  // 5. Recent income (last 20 entries) — to see if any realized PnL occurred
  try {
    const fifteenMinsAgo = Date.now() - 2 * 60 * 60 * 1000; // last 2h
    const income = await signedRequest('GET', '/fapi/v1/income', {
      symbol,
      startTime: fifteenMinsAgo.toString(),
      limit: '50',
    });
    console.log(`\n### RECENT INCOME (last 2h, ${income.length} entries) ###`);
    for (const i of income) {
      console.log({
        time: new Date(i.time).toISOString(),
        incomeType: i.incomeType,
        income: i.income,
        asset: i.asset,
        tradeId: i.tradeId,
      });
    }
  } catch (e) {
    console.log('income error:', JSON.stringify(e));
  }

  // 6. Balance
  try {
    const account = await signedRequest('GET', '/fapi/v2/account', {});
    const usdt = account.assets.find(a => a.asset === 'USDT');
    console.log(`\n### BALANCE ###`);
    console.log({
      walletBalance: usdt?.walletBalance,
      unrealizedProfit: usdt?.unrealizedProfit,
      marginBalance: usdt?.marginBalance,
      availableBalance: usdt?.availableBalance,
    });
  } catch (e) {
    console.log('account error:', JSON.stringify(e));
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
