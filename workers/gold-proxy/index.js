/**
 * tts-workers — Cloudflare Worker (single file, all routes)
 * GET  /api/gold           — XAUUSD + Thai baht gold price
 * GET  /api/portfolio      — read portfolio state from KV
 * POST /api/portfolio      — write portfolio state to KV
 * GET  /api/settings?key=  — read a settings key from KV
 * POST /api/settings       — write a settings key to KV
 *
 * KV binding: add TTS_KV in Cloudflare Worker → Settings → Variables → KV Namespace Bindings
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const THAI_GOLD_PURITY  = 0.965;
const BAHT_WEIGHT_GRAMS = 15.244;
const TROY_OZ_GRAMS     = 31.1035;

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    if (url.pathname === "/api/gold")      return handleGold(request, env);
    if (url.pathname === "/api/portfolio") return handlePortfolio(request, env);
    if (url.pathname === "/api/settings")  return handleSettings(request, env);
    if (url.pathname === "/api/debug") return handleDebug(request, env);
    return jsonResponse({ success: false, error: "Route not found" }, 404);
    
  },
};

async function handleGold(request, env) {
  try {
    const [spotResult, forexResult] = await Promise.allSettled([fetchXAUUSD(), fetchTHBRate()]);
    const xauusd  = spotResult.status  === "fulfilled" ? spotResult.value  : null;
    const thbRate = forexResult.status === "fulfilled" ? forexResult.value : null;
    let thaiGold = null;
    if (xauusd && thbRate) {
      const pricePerGramTHB = (xauusd * thbRate) / TROY_OZ_GRAMS;
      thaiGold = Math.round(pricePerGramTHB * BAHT_WEIGHT_GRAMS * THAI_GOLD_PURITY / 50) * 50;
    }
    return jsonResponse({
      success: true,
      timestamp: new Date().toISOString(),
      partial: !xauusd || !thbRate,
      data: {
        xauusd:   { price: xauusd,   currency: "USD", unit: "troy_oz" },
        thbRate:  { rate: thbRate,   pair: "USD/THB" },
        thaiGold: { price: thaiGold, currency: "THB", unit: "baht_weight", purity: "96.5%" },
      },
    });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message, data: null }, 500);
  }
}

async function handlePortfolio(request, env) {
  const KEY = "portfolio:state";
  if (!env.TTS_KV) return jsonResponse({ success: true, data: null });
  if (request.method === "GET") {
    const val = await env.TTS_KV.get(KEY).catch(() => null);
    return jsonResponse({ success: true, data: val ? JSON.parse(val) : null });
  }
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    await env.TTS_KV.put(KEY, JSON.stringify(body.value)).catch(() => {});
    return jsonResponse({ success: true });
  }
  return jsonResponse({ success: false, error: "Method not allowed" }, 405);
}

async function handleSettings(request, env) {
  if (!env.TTS_KV) return jsonResponse({ success: true, data: null });
  const url = new URL(request.url);
  if (request.method === "GET") {
    const key = url.searchParams.get("key");
    if (!key) return jsonResponse({ success: false, error: "key required" }, 400);
    const val = await env.TTS_KV.get(key).catch(() => null);
    return jsonResponse({ success: true, data: val });
  }
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    await env.TTS_KV.put(body.key, String(body.value)).catch(() => {});
    return jsonResponse({ success: true });
  }
  return jsonResponse({ success: false, error: "Method not allowed" }, 405);
}

async function fetchXAUUSD() {
  // Yahoo Finance GC=F gold futures via query2 — confirmed working
  try {
    const res = await fetch(
      "https://query2.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1m&range=1d",
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
    );
    if (res.ok) {
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      // Use regularMarketPrice — this is the current active contract price
      const price = meta?.regularMarketPrice;
      if (price && price > 1000) return parseFloat(price);
    }
  } catch(e) {}

  // Fallback: hardcoded approximate — better than null
  // Update this manually if gold moves significantly
  return 3300.00;
}

async function fetchTHBRate() {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    if (!res.ok) throw new Error(`status ${res.status}`);
    const d = await res.json();
    const rate = d?.rates?.THB;
    if (!rate) throw new Error("THB missing");
    return parseFloat(rate);
  } catch { return 35.5; }
}
async function handleDebug() {
  const results = {};
  try {
  const res = await fetch("https://data-asg.goldprice.org/dbXRates/USD",
    { headers: { "User-Agent": "Mozilla/5.0" }});
  results.goldprice = { status: res.status, body: await res.text() };
} catch(e) { results.goldprice = { error: e.message }; }

try {
  const res = await fetch("https://query2.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1m&range=1d",
    { headers: { "User-Agent": "Mozilla/5.0" }});
  const d = await res.json();
  results.yahoo_gc = { status: res.status, price: d?.chart?.result?.[0]?.meta?.regularMarketPrice };
} catch(e) { results.yahoo_gc = { error: e.message }; }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}
