// config.js — Thai Trading Simulator
// ⚠️ UPDATE these values after setting up Cloudflare Workers and KV/D1
// Never put secret keys here — those go in Cloudflare Worker environment variables

const config = {
  // ── App ──────────────────────────────────────────────────────────
  app: {
    name: "Thai Trading Simulator",
    version: "0.1.0",
    defaultBalance: 1000000,      // 1,000,000 THB starting virtual balance
    currency: "THB",
    locale: "en-US",
  },

  // ── Cloudflare Worker Endpoints ──────────────────────────────────
  // Replace with your actual Workers subdomain after deployment
  workers: {
    base: "https://tts-workers.csmittee.workers.dev",
    routes: {
      gold:     "/api/gold",          // metals.live + Thai gold price
      set:      "/api/set",           // Yahoo Finance SET proxy
      intel:    "/api/intel",         // Anthropic insider intel (cached)
      strategy: "/api/strategy",      // Anthropic AI strategy assist
      settings: "/api/settings",      // KV read/write for dashboard settings
      portfolio: "/api/portfolio",    // KV read/write for portfolio state
      trades:   "/api/trades",        // D1 trade history
      logs:     "/api/logs",          // D1 activity log
    }
  },

  // ── Market Data ──────────────────────────────────────────────────
  data: {
    gold: {
      refreshIntervalMs: 60000,       // refresh gold price every 60 seconds
      symbols: {
        xauusd: "XAUUSD",
        thbGold: "THAI_GOLD_BAHT",
      },
      thaiGoldPurity: 0.965,          // 96.5% purity (standard Thai gold bar)
      bahtWeightGrams: 15.244,        // 1 Thai baht weight = 15.244 grams
      troyOzGrams: 31.1035,
    },
    set: {
      refreshIntervalMs: 60000,       // 15-min delayed data, refresh every 60s
      yahooSuffix: ".BK",             // Yahoo Finance suffix for SET stocks
      watchlistDefault: [             // default stocks shown on load
        "PTT.BK",
        "AOT.BK",
        "ADVANC.BK",
        "KBANK.BK",
        "SCB.BK",
        "CPF.BK",
        "TRUE.BK",
        "GULF.BK",
      ],
    },
  },

  // ── Market Hours (ICT, UTC+7) ────────────────────────────────────
  marketHours: {
    set: {
      timezone: "Asia/Bangkok",
      sessions: [
        { open: "10:00", close: "12:30" },
        { open: "14:30", close: "17:00" },
      ],
      tradingDays: [1, 2, 3, 4, 5],   // Mon–Fri (0=Sun, 6=Sat)
    },
    gold: {
      // Gold trades 24x5 — closed Sat 05:00 to Sun 05:00 ICT
      timezone: "Asia/Bangkok",
      tradingDays: [1, 2, 3, 4, 5],
    },
  },

  // ── Simulation Engine ────────────────────────────────────────────
  sim: {
    randomWalkMaxPct: 0.003,          // ±0.3% per hour when market hours OFF
    priceDecimalsSET: 2,
    priceDecimalsGold: 2,
  },

  // ── AI / Anthropic ───────────────────────────────────────────────
  ai: {
    model: "claude-sonnet-4-20250514", // always use this — update masterseed if changed
    intelMaxTokens: 150,
    strategyMaxTokens: 500,
    intelCacheTtlHours: 24,
    hoverDelayMs: 1500,               // 1.5s hover before intel fetch triggers
  },

  // ── Strategy Presets ─────────────────────────────────────────────
  // defaultDuration: intended holding period in minutes
  // durationOptions: choices shown in StrategyPanel duration selector
  strategies: {
    presets: [
      {
        id: "ma_crossover",
        name: "MA Crossover",
        description: "Buy when MA5 crosses above MA20. Sell when MA5 crosses below MA20.",
        params: { shortPeriod: 5, longPeriod: 20 },
        defaultDuration: 1440,        // 1 day (in minutes)
        durationOptions: [240, 480, 1440, 4320],   // 4h, 8h, 1d, 3d
      },
      {
        id: "rsi_reversion",
        name: "RSI Mean Reversion",
        description: "Buy when RSI < 30 (oversold). Sell when RSI > 70 (overbought).",
        params: { period: 14, oversold: 30, overbought: 70 },
        defaultDuration: 240,         // 4 hours
        durationOptions: [60, 120, 240, 480],      // 1h, 2h, 4h, 8h
      },
      {
        id: "breakout_volume",
        name: "Volume Breakout",
        description: "Buy when price breaks 20-day high with volume > 1.5x average.",
        params: { lookback: 20, volumeMultiplier: 1.5 },
        defaultDuration: 4320,        // 3 days
        durationOptions: [1440, 4320, 10080, 20160], // 1d, 3d, 1w, 2w
      },
      {
        id: "golden_cross",
        name: "Golden / Death Cross",
        description: "Buy on MA50/MA200 golden cross. Sell on death cross.",
        params: { shortPeriod: 50, longPeriod: 200 },
        defaultDuration: 4320,        // 3 days
        durationOptions: [1440, 4320, 10080, 20160], // 1d, 3d, 1w, 2w
      },
      {
        id: "support_bounce",
        name: "Support / Resistance Bounce",
        description: "Buy near support levels. Sell near resistance levels.",
        params: { lookback: 30, tolerancePct: 0.02 },
        defaultDuration: 240,         // 4 hours
        durationOptions: [60, 120, 240, 480],      // 1h, 2h, 4h, 8h
      },
    ],

    // Duration label lookup (minutes → display string)
    durationLabels: {
      60:    "1h",
      120:   "2h",
      240:   "4h",
      480:   "8h",
      1440:  "1d",
      4320:  "3d",
      10080: "1w",
      20160: "2w",
    },
  },

  // ── UI / Tooltip ─────────────────────────────────────────────────
  ui: {
    chartDefaultTimeframe: "1D",      // 1D | 1W | 1M
    chartTypes: ["candlestick", "line"],
    riskLevels: {
      low:    { maxPortfolioPct: 0.02, color: "#22c55e" },   // 2% per trade
      medium: { maxPortfolioPct: 0.05, color: "#f59e0b" },   // 5% per trade
      high:   { maxPortfolioPct: 0.10, color: "#ef4444" },   // 10% per trade
    },
  },
};

export default config;
