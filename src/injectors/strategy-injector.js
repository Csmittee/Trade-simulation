/**
 * strategy-injector.js
 * Phase 3 — Preset strategy signal engine.
 * Pure functions: receives price history + portfolio, returns a signal.
 * No API calls, no side effects. Wired into GoldMarket + SetMarket.
 *
 * Signal shape:
 *   { signal: "buy"|"sell"|"hold"|null, reason: string,
 *     suggestedEntry: number, suggestedStop: number, suggestedTP: number }
 *
 * L006: Market-specific logic stays isolated in this file.
 *       Cross-market logic stays in portfolio-engine.js.
 */

import config from "../../config.js";

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the active strategy against current price history.
 * @param {object} params
 * @param {Array}  params.priceHistory   - OHLC array from injector (may include gap candles)
 * @param {number} params.currentPrice   - latest tick price
 * @param {string} params.strategyId     - one of config.strategies.presets[].id
 * @param {object} params.portfolio      - current portfolio state (for position awareness)
 * @param {string} params.market         - "gold" | "set"
 * @returns {{ signal, reason, suggestedEntry, suggestedStop, suggestedTP } | null}
 */
export function runStrategy({ priceHistory, currentPrice, strategyId, portfolio, market }) {
  if (!strategyId || !priceHistory?.length || !currentPrice) return null;

  // Strip gap candles — strategy math only on real candles (L020/L021)
  const candles = priceHistory.filter(c => !c.isGap && c.close != null);
  if (candles.length < 5) return null; // not enough data

  const preset = config.strategies.presets.find(p => p.id === strategyId);
  if (!preset) return null;

  switch (strategyId) {
    case "ma_crossover":    return maCrossover(candles, currentPrice, preset.params);
    case "rsi_reversion":   return rsiReversion(candles, currentPrice, preset.params);
    case "breakout_volume": return breakoutVolume(candles, currentPrice, preset.params);
    case "golden_cross":    return goldenCross(candles, currentPrice, preset.params);
    case "support_bounce":  return supportBounce(candles, currentPrice, preset.params);
    default:                return null;
  }
}

// ── Strategy 1: MA Crossover ──────────────────────────────────────────────────
// Buy when MA5 crosses above MA20. Sell when MA5 crosses below MA20.

function maCrossover(candles, currentPrice, { shortPeriod = 5, longPeriod = 20 }) {
  if (candles.length < longPeriod + 1) {
    return { signal: "hold", reason: `Need ${longPeriod + 1} candles — only ${candles.length} available`, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
  }

  const closes = candles.map(c => c.close);

  // Current MAs
  const maShortNow = sma(closes, shortPeriod);
  const maLongNow  = sma(closes, longPeriod);

  // Previous MAs (one candle back)
  const prevCloses  = closes.slice(0, -1);
  const maShortPrev = sma(prevCloses, shortPeriod);
  const maLongPrev  = sma(prevCloses, longPeriod);

  const crossedAbove = maShortPrev <= maLongPrev && maShortNow > maLongNow;
  const crossedBelow = maShortPrev >= maLongPrev && maShortNow < maLongNow;

  if (crossedAbove) {
    const stop = currentPrice * 0.98;  // 2% below entry
    const tp   = currentPrice * 1.04;  // 4% above entry
    return { signal: "buy", reason: `MA${shortPeriod} crossed above MA${longPeriod} — bullish momentum`, suggestedEntry: currentPrice, suggestedStop: parseFloat(stop.toFixed(2)), suggestedTP: parseFloat(tp.toFixed(2)) };
  }

  if (crossedBelow) {
    return { signal: "sell", reason: `MA${shortPeriod} crossed below MA${longPeriod} — bearish momentum`, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
  }

  const trend = maShortNow > maLongNow ? "above" : "below";
  return { signal: "hold", reason: `MA${shortPeriod} (${maShortNow?.toFixed(2)}) is ${trend} MA${longPeriod} (${maLongNow?.toFixed(2)}) — waiting for crossover`, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
}

// ── Strategy 2: RSI Mean Reversion ───────────────────────────────────────────
// Buy when RSI < 30 (oversold). Sell when RSI > 70 (overbought).

function rsiReversion(candles, currentPrice, { period = 14, oversold = 30, overbought = 70 }) {
  if (candles.length < period + 1) {
    return { signal: "hold", reason: `Need ${period + 1} candles for RSI — only ${candles.length} available`, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
  }

  const closes = candles.map(c => c.close);
  const rsi    = calcRSI(closes, period);

  if (rsi < oversold) {
    const stop = currentPrice * 0.97;
    const tp   = currentPrice * 1.06;
    return { signal: "buy", reason: `RSI ${rsi.toFixed(1)} — oversold below ${oversold}. Mean reversion entry.`, suggestedEntry: currentPrice, suggestedStop: parseFloat(stop.toFixed(2)), suggestedTP: parseFloat(tp.toFixed(2)) };
  }

  if (rsi > overbought) {
    return { signal: "sell", reason: `RSI ${rsi.toFixed(1)} — overbought above ${overbought}. Exit / take profit.`, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
  }

  return { signal: "hold", reason: `RSI ${rsi.toFixed(1)} — neutral zone (${oversold}–${overbought}). No signal.`, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
}

// ── Strategy 3: Volume Breakout ───────────────────────────────────────────────
// Buy when price breaks 20-day high with volume > 1.5x average.

function breakoutVolume(candles, currentPrice, { lookback = 20, volumeMultiplier = 1.5 }) {
  if (candles.length < lookback) {
    return { signal: "hold", reason: `Need ${lookback} candles — only ${candles.length} available`, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
  }

  const recent = candles.slice(-lookback);
  const prevCandles = recent.slice(0, -1); // exclude current candle for the high calculation

  const prevHigh   = Math.max(...prevCandles.map(c => c.high));
  const avgVolume  = prevCandles.reduce((s, c) => s + (c.volume || 0), 0) / prevCandles.length;
  const lastCandle = candles[candles.length - 1];
  const lastVolume = lastCandle?.volume || 0;

  const priceBreakout  = currentPrice > prevHigh;
  const volumeBreakout = avgVolume > 0 && lastVolume > avgVolume * volumeMultiplier;

  if (priceBreakout && volumeBreakout) {
    const stop = prevHigh * 0.99; // just below the broken level
    const tp   = currentPrice + (currentPrice - prevHigh) * 2; // 2:1 R/R
    return { signal: "buy", reason: `Price broke ${lookback}-bar high (฿${prevHigh.toFixed(2)}) with ${(lastVolume / avgVolume).toFixed(1)}x avg volume`, suggestedEntry: currentPrice, suggestedStop: parseFloat(stop.toFixed(2)), suggestedTP: parseFloat(tp.toFixed(2)) };
  }

  if (priceBreakout && !volumeBreakout) {
    return { signal: "hold", reason: `Price above ${lookback}-bar high but volume too low (${(lastVolume / avgVolume || 0).toFixed(1)}x vs ${volumeMultiplier}x needed)`, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
  }

  const gap = ((prevHigh - currentPrice) / prevHigh * 100).toFixed(2);
  return { signal: "hold", reason: `Watching for breakout above ฿${prevHigh.toFixed(2)} (${gap}% away)`, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
}

// ── Strategy 4: Golden Cross / Death Cross ────────────────────────────────────
// Buy on MA50/MA200 golden cross. Sell on death cross.

function goldenCross(candles, currentPrice, { shortPeriod = 50, longPeriod = 200 }) {
  if (candles.length < longPeriod + 1) {
    return { signal: "hold", reason: `Need ${longPeriod + 1} candles for Golden Cross — only ${candles.length} available (needs daily 1M data)`, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
  }

  const closes = candles.map(c => c.close);

  const maShortNow  = sma(closes, shortPeriod);
  const maLongNow   = sma(closes, longPeriod);
  const prevCloses  = closes.slice(0, -1);
  const maShortPrev = sma(prevCloses, shortPeriod);
  const maLongPrev  = sma(prevCloses, longPeriod);

  const goldenCross = maShortPrev <= maLongPrev && maShortNow > maLongNow;
  const deathCross  = maShortPrev >= maLongPrev && maShortNow < maLongNow;

  if (goldenCross) {
    const stop = currentPrice * 0.95;
    const tp   = currentPrice * 1.10;
    return { signal: "buy", reason: `Golden Cross: MA${shortPeriod} crossed above MA${longPeriod} — major bullish signal`, suggestedEntry: currentPrice, suggestedStop: parseFloat(stop.toFixed(2)), suggestedTP: parseFloat(tp.toFixed(2)) };
  }

  if (deathCross) {
    return { signal: "sell", reason: `Death Cross: MA${shortPeriod} crossed below MA${longPeriod} — major bearish signal`, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
  }

  const trend = maShortNow > maLongNow ? "bullish (MA50 above MA200)" : "bearish (MA50 below MA200)";
  return { signal: "hold", reason: `Trend is ${trend} — waiting for cross`, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
}

// ── Strategy 5: Support / Resistance Bounce ───────────────────────────────────
// Buy near support levels. Sell near resistance levels.

function supportBounce(candles, currentPrice, { lookback = 30, tolerancePct = 0.02 }) {
  if (candles.length < lookback) {
    return { signal: "hold", reason: `Need ${lookback} candles — only ${candles.length} available`, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
  }

  const recent    = candles.slice(-lookback);
  const lows      = recent.map(c => c.low);
  const highs     = recent.map(c => c.high);
  const support   = Math.min(...lows);
  const resistance= Math.max(...highs);
  const tolerance = currentPrice * tolerancePct;

  const nearSupport    = Math.abs(currentPrice - support)    <= tolerance;
  const nearResistance = Math.abs(currentPrice - resistance) <= tolerance;

  if (nearSupport) {
    const stop = support * (1 - tolerancePct); // just below support
    const tp   = resistance;                    // aim for resistance
    return { signal: "buy", reason: `Price near ${lookback}-bar support ฿${support.toFixed(2)} (within ${(tolerancePct*100)}%)`, suggestedEntry: currentPrice, suggestedStop: parseFloat(stop.toFixed(2)), suggestedTP: parseFloat(tp.toFixed(2)) };
  }

  if (nearResistance) {
    return { signal: "sell", reason: `Price near ${lookback}-bar resistance ฿${resistance.toFixed(2)} (within ${(tolerancePct*100)}%) — consider taking profit`, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
  }

  const midpoint = (support + resistance) / 2;
  const zone     = currentPrice < midpoint ? "lower half (closer to support)" : "upper half (closer to resistance)";
  return { signal: "hold", reason: `Support: ฿${support.toFixed(2)} | Resistance: ฿${resistance.toFixed(2)} | Price in ${zone}`, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
}

// ── Math Helpers ──────────────────────────────────────────────────────────────

/** Simple moving average of last `period` values in `arr` */
function sma(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

/** Wilder's RSI */
function calcRSI(closes, period) {
  if (closes.length < period + 1) return 50; // fallback neutral

  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  const initial = changes.slice(0, period);
  let avgGain = initial.filter(c => c > 0).reduce((s, c) => s + c, 0) / period;
  let avgLoss = initial.filter(c => c < 0).reduce((s, c) => s + Math.abs(c), 0) / period;

  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.abs(Math.min(change, 0))) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}
