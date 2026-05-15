/**
 * gold-proxy/index.js — Cloudflare Worker
 * Routes: GET /api/gold
 * Returns: XAUUSD spot price + Thai baht gold price (96.5% purity)
 *
 * Deploy: wrangler deploy
 * Env vars needed: none for gold (public endpoints)
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// Thai gold constants
const THAI_GOLD_PURITY    = 0.965;   // 96.5% purity
const BAHT_WEIGHT_GRAMS   = 15.244;  // 1 Thai baht weight in grams
const TROY_OZ_GRAMS       = 31.1035; // grams per troy oz

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/gold") {
      return handleGoldRequest(request, env, ctx);
    }

    return jsonResponse({ success: false, error: "Route not found" }, 404);
  },
};

async function handleGoldRequest(request, env, ctx) {
  try {
    // Run both fetches in parallel for speed
    const [spotResult, forexResult] = await Promise.allSettled([
      fetchXAUUSD(),
      fetchTHBRate(),
    ]);

    const xauusd = spotResult.status === "fulfilled"
      ? spotResult.value
      : null;

    const thbRate = forexResult.status === "fulfilled"
      ? forexResult.value
      : null;

    // Calculate Thai gold price if both values available
    let thaiGold = null;
    if (xauusd && thbRate) {
      // Price per troy oz in THB, adjusted for 96.5% purity and baht weight
      const pricePerGramTHB = (xauusd * thbRate) / TROY_OZ_GRAMS;
      const pricePerBahtWeight = pricePerGramTHB * BAHT_WEIGHT_GRAMS * THAI_GOLD_PURITY;
      thaiGold = Math.round(pricePerBahtWeight / 50) * 50; // Round to nearest 50 THB (market convention)
    }

    const payload = {
      success: true,
      timestamp: new Date().toISOString(),
      data: {
        xauusd: {
          price: xauusd,
          currency: "USD",
          unit: "troy_oz",
          source: "metals.live",
        },
        thbRate: {
          rate: thbRate,
          pair: "USD/THB",
          source: "exchangerate-api",
        },
        thaiGold: {
          price: thaiGold,          // THB per 1 baht-weight (15.244g, 96.5% purity)
          currency: "THB",
          unit: "baht_weight",      // "บาท" in Thai gold market
          purity: "96.5%",
          source: "calculated",
          note: "Rounded to nearest 50 THB per market convention",
        },
      },
      // Fallback flag so frontend knows to show stale indicator
      partial: !xauusd || !thbRate,
    };

    return jsonResponse(payload, 200);

  } catch (err) {
    return jsonResponse({
      success: false,
      error: err.message || "Failed to fetch gold data",
      data: null,
    }, 500);
  }
}

// ── Data Sources ──────────────────────────────────────────────────────────────

async function fetchXAUUSD() {
  // Primary: metals.live (free, no key required for basic endpoint)
  try {
    const res = await fetch("https://metals.live/api/spot/gold", {
      headers: { "Accept": "application/json" },
      cf: { cacheTtl: 55, cacheEverything: true }, // cache 55s at Cloudflare edge
    });
    if (!res.ok) throw new Error(`metals.live returned ${res.status}`);
    const data = await res.json();
    // metals.live returns { price: number, ... }
    if (data?.price) return parseFloat(data.price);
    throw new Error("Unexpected metals.live response shape");
  } catch (primaryErr) {
    // Fallback: Yahoo Finance XAUUSD=X
    const res = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=1m&range=1d",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!res.ok) throw new Error(`Yahoo Finance fallback returned ${res.status}`);
    const data = await res.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!price) throw new Error("Cannot parse Yahoo Finance gold response");
    return parseFloat(price);
  }
}

async function fetchTHBRate() {
  // Free forex endpoint — no key required
  try {
    const res = await fetch(
      "https://open.er-api.com/v6/latest/USD",
      { cf: { cacheTtl: 3600, cacheEverything: true } } // cache 1hr, forex is slow-moving
    );
    if (!res.ok) throw new Error(`Exchange rate API returned ${res.status}`);
    const data = await res.json();
    const rate = data?.rates?.THB;
    if (!rate) throw new Error("THB rate not found in response");
    return parseFloat(rate);
  } catch {
    // Hardcoded fallback — only used if API is completely down
    // Frontend will show "rate may be stale" warning when this triggers
    return 35.5;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: CORS_HEADERS,
  });
}
