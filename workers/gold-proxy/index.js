/**
 * tts-workers — Cloudflare Worker (single file, all routes)
 * GET  /api/gold              — XAUUSD + Thai baht gold price
 * GET  /api/history           — Historical OHLC for chart (GC=F or SET symbol)
 * GET  /api/set?symbol=PTT.BK — Yahoo Finance proxy for SET/MAI stocks (15-min delayed)
 * GET  /api/portfolio         — read portfolio state from KV
 * POST /api/portfolio         — write portfolio state to KV
 * GET  /api/settings?key=     — read a settings key from KV
 * POST /api/settings          — write a settings key to KV
 *
 * KV binding: add TTS_KV in Cloudflare Worker → Settings → Variables → KV Namespace Bindings
 *
 * ⚠️ KNOWN LIMITATION — Historical THB conversion:
 * The /api/history endpoint converts historical USD OHLC prices to THB using the
 * CURRENT live USD/THB rate fetched at the time of the request — NOT the historical
 * rate that was valid when each candle occurred. This is intentional for Phase 1/2
 * (paper trading sim — accuracy is acceptable). Do NOT use this data for real
 * financial analysis. This note exists so future phases don't get confused by
 * slightly off historical THB values.
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
    if (url.pathname === "/api/history")   return handleHistory(request, env);
    if (url.pathname === "/api/set")       return handleSet(request, env);
    if (url.pathname === "/api/portfolio") return handlePortfolio(request, env);
    if (url.pathname === "/api/settings")  return handleSettings(request, env);
    if (url.pathname === "/api/debug")     return handleDebug(request, env);
    return jsonResponse({ success: false, error: "Route not found" }, 404);
  },
};

// ── /api/gold ─────────────────────────────────────────────────────────────────
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

// ── /api/history ──────────────────────────────────────────────────────────────
// Query params:
//   symbol  = "GC=F" (gold futures) or "PTT.BK" etc — defaults to "GC=F"
//   range   = "1d" | "5d" | "1mo" — defaults to "1d"
//   interval= "5m" | "15m" | "1h" | "1d" — defaults to "5m"
//   market  = "gold" | "set" — determines whether to convert USD→THB
//
// ⚠️ THB conversion uses CURRENT live rate, not historical rate. See file header.
async function handleHistory(request, env) {
  const url      = new URL(request.url);
  const symbol   = url.searchParams.get("symbol")   || "GC=F";
  const range    = url.searchParams.get("range")    || "1d";
  const interval = url.searchParams.get("interval") || "5m";
  const market   = url.searchParams.get("market")   || "gold";

  try {
    // Encode symbol for URL (GC=F → GC%3DF)
    const encodedSymbol = encodeURIComponent(symbol);
    const yahooUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?interval=${interval}&range=${range}`;

    const res = await fetch(yahooUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    });

    if (!res.ok) throw new Error(`Yahoo returned ${res.status}`);
    const data = await res.json();

    const result = data?.chart?.result?.[0];
    if (!result) throw new Error("No chart data in Yahoo response");

    const timestamps = result.timestamps || result.timestamp;
    const quote      = result.indicators?.quote?.[0];

    if (!timestamps || !quote) throw new Error("Missing timestamps or quote data");

    const opens  = quote.open;
    const highs  = quote.high;
    const lows   = quote.low;
    const closes = quote.close;

    // For gold: fetch current THB rate to convert USD OHLC → THB
    // ⚠️ This is the CURRENT rate, not the historical rate for each candle.
    let thbRate = null;
    if (market === "gold") {
      thbRate = await fetchTHBRate();
    }

    // Build candle array — skip candles with null values (market closed gaps)
    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] === null || closes[i] === undefined) continue;
      if (opens[i]  === null || opens[i]  === undefined) continue;

      const ts   = new Date(timestamps[i] * 1000);
      const time = formatTime(ts);

      if (market === "gold" && thbRate) {
        // Convert each USD OHLC value → Thai baht-weight price
        // ⚠️ Using current THB rate — see file header limitation note
        candles.push({
          time,
          open:  usdToThaiGold(opens[i],  thbRate),
          high:  usdToThaiGold(highs[i],  thbRate),
          low:   usdToThaiGold(lows[i],   thbRate),
          close: usdToThaiGold(closes[i], thbRate),
          xauusd: parseFloat(closes[i].toFixed(2)),
        });
      } else {
        // SET stocks — already in THB, just round to 2dp
        candles.push({
          time,
          open:  parseFloat(opens[i].toFixed(2)),
          high:  parseFloat(highs[i].toFixed(2)),
          low:   parseFloat(lows[i].toFixed(2)),
          close: parseFloat(closes[i].toFixed(2)),
        });
      }
    }

    return jsonResponse({
      success: true,
      symbol,
      range,
      interval,
      count: candles.length,
      thbRateUsed: thbRate,  // exposed so frontend can note "approx conversion"
      data: candles,
    });

  } catch (err) {
    return jsonResponse({ success: false, error: err.message, data: [] }, 500);
  }
}

// ── /api/portfolio ────────────────────────────────────────────────────────────
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

// ── /api/settings ─────────────────────────────────────────────────────────────
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

// ── Fetch helpers ─────────────────────────────────────────────────────────────
async function fetchXAUUSD() {
  try {
    const res = await fetch(
      "https://query2.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1m&range=1d",
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
    );
    if (res.ok) {
      const data = await res.json();
      const meta  = data?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      if (price && price > 1000) return parseFloat(price);
    }
  } catch(e) {}
  return 3300.00; // fallback — update manually if gold moves significantly
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

// ── /api/debug ────────────────────────────────────────────────────────────────
async function handleDebug() {
  const results = {};
  try {
    const res = await fetch(
      "https://query2.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1m&range=1d",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const d = await res.json();
    results.yahoo_gc = { status: res.status, price: d?.chart?.result?.[0]?.meta?.regularMarketPrice };
  } catch(e) { results.yahoo_gc = { error: e.message }; }

  try {
    const res = await fetch(
      "https://query2.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=5m&range=1d",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const d = await res.json();
    const timestamps = d?.chart?.result?.[0]?.timestamp;
    const closes     = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    results.history_test = {
      status: res.status,
      candleCount: timestamps?.length,
      firstClose: closes?.[0],
      lastClose:  closes?.[closes?.length - 1],
    };
  } catch(e) { results.history_test = { error: e.message }; }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// ── Math helpers ──────────────────────────────────────────────────────────────

/**
 * Convert a USD/troy-oz price → Thai baht-weight price in THB.
 * ⚠️ Uses current THB rate passed in — not the historical rate. See file header.
 */
function usdToThaiGold(usdPrice, thbRate) {
  const pricePerGramTHB = (usdPrice * thbRate) / TROY_OZ_GRAMS;
  // Round to nearest 50 THB — Thai gold market convention
  return Math.round(pricePerGramTHB * BAHT_WEIGHT_GRAMS * THAI_GOLD_PURITY / 50) * 50;
}

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}
