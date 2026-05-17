/**
 * tts-workers — Cloudflare Worker (single file, all routes)
 * GET  /api/gold              — XAUUSD + Thai baht gold price
 * GET  /api/history           — Historical OHLC for chart (GC=F or SET symbol)
 * GET  /api/set?symbol=PTT.BK — Yahoo Finance proxy for SET/MAI stocks (15-min delayed)
 * GET  /api/portfolio         — read portfolio state from KV
 * POST /api/portfolio         — write portfolio state to KV
 * GET  /api/settings?key=     — read a settings key from KV
 * POST /api/settings          — write a settings key to KV
 * POST /api/trades            — log a completed trade to D1 (Phase 3)
 * GET  /api/trades            — fetch trade history from D1 (Phase 3)
 *
 * KV binding: TTS_KV — Cloudflare Worker → Settings → Variables → KV Namespace Bindings
 * D1 binding: TTS_DB — Cloudflare Worker → Settings → Variables → D1 Database Bindings
 *
 * ⚠️ KNOWN LIMITATION — Historical THB conversion:
 * /api/history converts historical USD OHLC to THB using the CURRENT live rate,
 * not the historical rate for each candle. Acceptable for sim purposes.
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
    if (url.pathname === "/api/trades")    return handleTrades(request, env);
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
    let thaiGold  = null;
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
// Query params: symbol, range (1d|5d|1mo), interval (5m|15m|1h|1d), market (gold|set)
async function handleHistory(request, env) {
  const url      = new URL(request.url);
  const symbol   = url.searchParams.get("symbol")   || "GC=F";
  const range    = url.searchParams.get("range")    || "1d";
  const interval = url.searchParams.get("interval") || "5m";
  const market   = url.searchParams.get("market")   || "gold";

  try {
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

    let thbRate = null;
    if (market === "gold") thbRate = await fetchTHBRate();

    // Yahoo Finance returns unreliable intraday data for SET stocks at 1h interval.
    // For SET 1M view, force daily candles (interval=1d) for accurate OHLC.
    // Gold 1M stays at 1h — futures data is reliable at that interval.
    const effectiveInterval = (market === "set" && range === "1mo") ? "1d" : interval;
    // Re-fetch with corrected interval if needed
    let finalTimestamps = timestamps;
    let finalOpens = opens, finalHighs = highs, finalLows = lows, finalCloses = closes;
    if (effectiveInterval !== interval) {
      try {
        const fixUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?interval=${effectiveInterval}&range=${range}`;
        const fixRes = await fetch(fixUrl, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
        if (fixRes.ok) {
          const fixData = await fixRes.json();
          const fixResult = fixData?.chart?.result?.[0];
          if (fixResult) {
            finalTimestamps = fixResult.timestamps || fixResult.timestamp || timestamps;
            const fixQuote  = fixResult.indicators?.quote?.[0];
            if (fixQuote) {
              finalOpens  = fixQuote.open;
              finalHighs  = fixQuote.high;
              finalLows   = fixQuote.low;
              finalCloses = fixQuote.close;
            }
          }
        }
      } catch(e) { /* fallback to original data */ }
    }
    // Use final (possibly corrected) arrays
    const ts_arr = finalTimestamps;
    const op_arr = finalOpens;
    const hi_arr = finalHighs;
    const lo_arr = finalLows;
    const cl_arr = finalCloses;

    // Label format depends on range:
    //   1d  → "HH:MM"         (time only)
    //   5d  → "ddd DD HH:MM"  (day + time, e.g. "Mon 12 09:30")
    //   1mo → "MMM DD"        (date only, e.g. "May 12")
    const DAYS  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const MONTHS= ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    function formatLabel(ts) {
      const hh  = String(ts.getHours()).padStart(2,"0");
      const mm  = String(ts.getMinutes()).padStart(2,"0");
      const day = DAYS[ts.getDay()];
      const dd  = ts.getDate();
      const mon = MONTHS[ts.getMonth()];
      if (range === "1d")  return `${hh}:${mm}`;
      if (range === "5d")  return `${day} ${dd} ${hh}:${mm}`;
      return `${mon} ${dd}`;
    }

    const candles = [];
    let prevDay = null;

    for (let i = 0; i < ts_arr.length; i++) {
      const ts  = new Date(ts_arr[i] * 1000);
      const day = ts.toDateString();

      // Insert a gap marker when day changes — visible blank space on chart
      // Only for multi-day views
      if (range !== "1d" && prevDay && prevDay !== day) {
        candles.push({ time:"", label:"", open:null, high:null, low:null, close:null, isGap:true });
      }
      prevDay = day;

      if (cl_arr[i] == null || op_arr[i] == null) continue;

      const time  = formatTime(ts);
      const label = formatLabel(ts);

      if (market === "gold" && thbRate) {
        candles.push({
          time, label,
          open:   usdToThaiGold(op_arr[i], thbRate),
          high:   usdToThaiGold(hi_arr[i], thbRate),
          low:    usdToThaiGold(lo_arr[i], thbRate),
          close:  usdToThaiGold(cl_arr[i], thbRate),
          xauusd: parseFloat(cl_arr[i].toFixed(2)),
        });
      } else {
        candles.push({
          time, label,
          open:  parseFloat(op_arr[i].toFixed(2)),
          high:  parseFloat(hi_arr[i].toFixed(2)),
          low:   parseFloat(lo_arr[i].toFixed(2)),
          close: parseFloat(cl_arr[i].toFixed(2)),
          volume: quote.volume?.[i] || 0,
        });
      }
    }

    // For 1D gold: cap to last 78 candles (6.5 hours) — avoids overnight compression
    const finalCandles = (range === "1d") ? candles.slice(-78) : candles;

    return jsonResponse({
      success: true, symbol, range, interval,
      count: finalCandles.length, thbRateUsed: thbRate, data: finalCandles,
    });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message, data: [] }, 500);
  }
}

// ── /api/set ──────────────────────────────────────────────────────────────────
// Proxies Yahoo Finance for SET/MAI stocks.
// L002: Never call Yahoo Finance directly from frontend — CORS blocked.
// Query params:
//   symbol  = "PTT.BK"               (single symbol mode)
//   symbols = "PTT.BK,AOT.BK,..."    (batch mode, comma-separated, max 8)
// Returns 15-min delayed data. UI must always show "15-min delayed" notice.
async function handleSet(request, env) {
  const url     = new URL(request.url);
  const symbol  = url.searchParams.get("symbol");
  const symbols = url.searchParams.get("symbols");

  // Batch mode — fetch multiple symbols for watchlist
  if (symbols) {
    const list    = symbols.split(",").slice(0, 8).map(s => s.trim()).filter(Boolean);
    const results = await Promise.allSettled(list.map(s => fetchSetQuote(s)));
    const data    = {};
    list.forEach((s, i) => {
      data[s] = results[i].status === "fulfilled" ? results[i].value : null;
    });
    return jsonResponse({ success: true, data, delayed: true, delayMinutes: 15 });
  }

  // Single symbol mode
  if (!symbol) return jsonResponse({ success: false, error: "symbol or symbols param required" }, 400);
  try {
    const quote = await fetchSetQuote(symbol);
    return jsonResponse({ success: true, data: quote, delayed: true, delayMinutes: 15 });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message, data: null }, 500);
  }
}

async function fetchSetQuote(symbol) {
  const encoded = encodeURIComponent(symbol);
  const res = await fetch(
    `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1m&range=1d`,
    { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
  );
  if (!res.ok) throw new Error(`Yahoo returned ${res.status} for ${symbol}`);
  const data = await res.json();

  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${symbol}`);

  const meta      = result.meta;
  const quote     = result.indicators?.quote?.[0];
  const closes    = quote?.close  || [];
  const opens     = quote?.open   || [];
  const highs     = quote?.high   || [];
  const lows      = quote?.low    || [];
  const volumes   = quote?.volume || [];
  const timestamps = result.timestamp || [];

  // Get last valid close
  let lastClose = meta?.regularMarketPrice || null;
  let lastOpen = null, lastHigh = null, lastLow = null, lastVol = null;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null) {
      lastClose = lastClose || closes[i];
      lastOpen  = lastOpen  || opens[i];
      lastHigh  = lastHigh  || highs[i];
      lastLow   = lastLow   || lows[i];
      lastVol   = lastVol   || volumes[i];
      break;
    }
  }

  // Build tick array for chart (last 78 points)
  const ticks = [];
  for (let i = Math.max(0, timestamps.length - 78); i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    const ts = new Date(timestamps[i] * 1000);
    ticks.push({
      time:   `${String(ts.getHours()).padStart(2,"0")}:${String(ts.getMinutes()).padStart(2,"0")}`,
      open:   parseFloat((opens[i]  || closes[i]).toFixed(2)),
      high:   parseFloat((highs[i]  || closes[i]).toFixed(2)),
      low:    parseFloat((lows[i]   || closes[i]).toFixed(2)),
      close:  parseFloat(closes[i].toFixed(2)),
      volume: volumes[i] || 0,
    });
  }

  const prevClose = meta?.chartPreviousClose || 0;
  return {
    symbol,
    name:          meta?.longName || meta?.shortName || symbol,
    currency:      meta?.currency || "THB",
    exchange:      meta?.exchangeName || "SET",
    price:         parseFloat((lastClose || 0).toFixed(2)),
    open:          parseFloat((lastOpen  || 0).toFixed(2)),
    high:          parseFloat((lastHigh  || 0).toFixed(2)),
    low:           parseFloat((lastLow   || 0).toFixed(2)),
    volume:        lastVol || 0,
    previousClose: parseFloat(prevClose.toFixed(2)),
    change:        parseFloat(((lastClose - prevClose) || 0).toFixed(2)),
    changePct:     parseFloat((prevClose ? ((lastClose - prevClose) / prevClose * 100) : 0).toFixed(2)),
    ticks,
  };
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

// ── /api/trades ───────────────────────────────────────────────────────────────
// POST — log a trade (called when a strategy-executed trade closes)
// GET  — fetch trade history (limit, market, symbol filters supported)
//
// D1 binding: TTS_DB (set up in Cloudflare Worker settings)
// Table: trades — see masterseed.md Phase 3 for CREATE TABLE statement
async function handleTrades(request, env) {
  if (!env.TTS_DB) {
    // Graceful fallback if D1 not yet configured
    return jsonResponse({ success: false, error: "D1 not configured. Add TTS_DB binding in Worker settings." }, 503);
  }

  // POST — insert a trade record
  if (request.method === "POST") {
    try {
      const body = await request.json();
      const {
        id, symbol, market, side, qty,
        entry_price, exit_price, pnl,
        strategy = "manual",
        opened_at, closed_at,
        sim_mode = 1,
      } = body;

      if (!id || !symbol || !market || !side || !qty || !entry_price || !opened_at) {
        return jsonResponse({ success: false, error: "Missing required trade fields" }, 400);
      }

      await env.TTS_DB.prepare(`
        INSERT INTO trades (id, symbol, market, side, qty, entry_price, exit_price, pnl, strategy, opened_at, closed_at, sim_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, symbol, market, side,
        qty, entry_price,
        exit_price ?? null,
        pnl ?? null,
        strategy,
        opened_at,
        closed_at ?? null,
        sim_mode ? 1 : 0
      ).run();

      return jsonResponse({ success: true, id });
    } catch (err) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // GET — fetch trade history
  if (request.method === "GET") {
    try {
      const url    = new URL(request.url);
      const market = url.searchParams.get("market") || null;
      const symbol = url.searchParams.get("symbol") || null;
      const limit  = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);

      let query  = "SELECT * FROM trades WHERE 1=1";
      const params = [];

      if (market) { query += " AND market = ?"; params.push(market); }
      if (symbol) { query += " AND symbol = ?"; params.push(symbol); }
      query += " ORDER BY opened_at DESC LIMIT ?";
      params.push(limit);

      const { results } = await env.TTS_DB.prepare(query).bind(...params).all();
      return jsonResponse({ success: true, count: results.length, data: results });
    } catch (err) {
      return jsonResponse({ success: false, error: err.message, data: [] }, 500);
    }
  }

  return jsonResponse({ success: false, error: "Method not allowed" }, 405);
}

// ── /api/debug ────────────────────────────────────────────────────────────────
async function handleDebug(request, env) {
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
      "https://query2.finance.yahoo.com/v8/finance/chart/PTT.BK?interval=1m&range=1d",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const d = await res.json();
    results.ptt_test = { status: res.status, price: d?.chart?.result?.[0]?.meta?.regularMarketPrice };
  } catch(e) { results.ptt_test = { error: e.message }; }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fetchXAUUSD() {
  try {
    const res = await fetch(
      "https://query2.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1m&range=1d",
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
    );
    if (res.ok) {
      const data  = await res.json();
      const meta  = data?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      if (price && price > 1000) return parseFloat(price);
    }
  } catch(e) {}
  return 3300.00;
}

async function fetchTHBRate() {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    if (!res.ok) throw new Error(`status ${res.status}`);
    const d    = await res.json();
    const rate = d?.rates?.THB;
    if (!rate) throw new Error("THB missing");
    return parseFloat(rate);
  } catch { return 35.5; }
}

function usdToThaiGold(usdPrice, thbRate) {
  const pricePerGramTHB = (usdPrice * thbRate) / TROY_OZ_GRAMS;
  return Math.round(pricePerGramTHB * BAHT_WEIGHT_GRAMS * THAI_GOLD_PURITY / 50) * 50;
}

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}
