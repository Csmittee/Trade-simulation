/**
 * strategy-injector.js
 * Phase 3 patch — Added approaching alert + size-based execution rules.
 *
 * Signal shape:
 *   { signal: "buy"|"sell"|"hold"|null,
 *     reason: string,
 *     approaching: boolean,
 *     approachingReason: string,
 *     approachingEta: string,
 *     suggestedEntry: number,
 *     suggestedStop: number,
 *     suggestedTP: number }
 *
 * Approaching alert — only predictable leadtime strategies:
 *   ✅ MA Crossover        — gap < 0.3%
 *   ✅ Golden/Death Cross  — gap < 0.5%
 *   ✅ Support/Resistance  — price within 1% of level
 *   ❌ RSI                 — spikes too fast, no leadtime
 *   ❌ Volume Breakout     — sudden by definition
 *
 * Size-based execution tiers:
 *   < 5%  of balance → auto-execute if armed
 *   5–20% of balance → always force confirm
 *   > 20% of balance → block + warning, manual only
 */

import config from "../../config.js";

export const SIZE_RULES = {
  autoThreshold:    0.05,
  confirmThreshold: 0.20,
};

// ── Main entry point ──────────────────────────────────────────────────────────

export function runStrategy({ priceHistory, currentPrice, strategyId, portfolio, market }) {
  if (!strategyId || !priceHistory?.length || !currentPrice) return null;
  const candles = priceHistory.filter(c => !c.isGap && c.close != null);
  if (candles.length < 5) return null;
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

/**
 * Returns "auto" | "confirm" | "block" based on trade size vs balance.
 */
export function getExecutionTier(tradeValue, portfolioBalance) {
  if (!portfolioBalance || portfolioBalance <= 0) return "confirm";
  const pct = tradeValue / portfolioBalance;
  if (pct > SIZE_RULES.confirmThreshold) return "block";
  if (pct >= SIZE_RULES.autoThreshold)   return "confirm";
  return "auto";
}

// ── Strategy 1: MA Crossover ──────────────────────────────────────────────────

function maCrossover(candles, currentPrice, { shortPeriod = 5, longPeriod = 20 }) {
  if (candles.length < longPeriod + 1) return noSignal(`Need ${longPeriod + 1} candles — only ${candles.length} available`, currentPrice);

  const closes      = candles.map(c => c.close);
  const maShortNow  = sma(closes, shortPeriod);
  const maLongNow   = sma(closes, longPeriod);
  const prevCloses  = closes.slice(0, -1);
  const maShortPrev = sma(prevCloses, shortPeriod);
  const maLongPrev  = sma(prevCloses, longPeriod);

  const crossedAbove = maShortPrev <= maLongPrev && maShortNow > maLongNow;
  const crossedBelow = maShortPrev >= maLongPrev && maShortNow < maLongNow;

  const gap    = Math.abs(maShortNow - maLongNow);
  const gapPct = maLongNow > 0 ? (gap / maLongNow) * 100 : 999;
  const approaching = !crossedAbove && !crossedBelow && gapPct < 0.3;

  if (crossedAbove) {
    return { signal: "buy", reason: `MA${shortPeriod} crossed above MA${longPeriod} — bullish momentum`, approaching: false, approachingReason: null, approachingEta: null, suggestedEntry: currentPrice, suggestedStop: parseFloat((currentPrice * 0.98).toFixed(2)), suggestedTP: parseFloat((currentPrice * 1.04).toFixed(2)) };
  }
  if (crossedBelow) {
    return { signal: "sell", reason: `MA${shortPeriod} crossed below MA${longPeriod} — bearish momentum`, approaching: false, approachingReason: null, approachingEta: null, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
  }
  if (approaching) {
    const bullish = maShortNow < maLongNow; // MA5 rising toward MA20
    return {
      signal: "hold",
      reason: `MA${shortPeriod} (${maShortNow?.toFixed(2)}) and MA${longPeriod} (${maLongNow?.toFixed(2)}) — gap ${gapPct.toFixed(2)}%`,
      approaching: true,
      approachingReason: `Gap ${gapPct.toFixed(2)}% — ${bullish ? "BUY crossover" : "SELL crossover"} imminent`,
      approachingEta: "~1–3 candles",
      suggestedEntry: currentPrice,
      suggestedStop:  bullish ? parseFloat((currentPrice * 0.98).toFixed(2)) : null,
      suggestedTP:    bullish ? parseFloat((currentPrice * 1.04).toFixed(2)) : null,
    };
  }

  const trend = maShortNow > maLongNow ? "above" : "below";
  return noSignal(`MA${shortPeriod} (${maShortNow?.toFixed(2)}) ${trend} MA${longPeriod} (${maLongNow?.toFixed(2)}) — waiting for crossover`, currentPrice);
}

// ── Strategy 2: RSI Mean Reversion ───────────────────────────────────────────

function rsiReversion(candles, currentPrice, { period = 14, oversold = 30, overbought = 70 }) {
  if (candles.length < period + 1) return noSignal(`Need ${period + 1} candles for RSI — only ${candles.length} available`, currentPrice);
  const rsi = calcRSI(candles.map(c => c.close), period);

  if (rsi < oversold) {
    return { signal: "buy", reason: `RSI ${rsi.toFixed(1)} — oversold below ${oversold}. Mean reversion entry.`, approaching: false, approachingReason: null, approachingEta: null, suggestedEntry: currentPrice, suggestedStop: parseFloat((currentPrice * 0.97).toFixed(2)), suggestedTP: parseFloat((currentPrice * 1.06).toFixed(2)) };
  }
  if (rsi > overbought) {
    return { signal: "sell", reason: `RSI ${rsi.toFixed(1)} — overbought above ${overbought}. Take profit.`, approaching: false, approachingReason: null, approachingEta: null, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
  }
  return noSignal(`RSI ${rsi.toFixed(1)} — neutral zone (${oversold}–${overbought})`, currentPrice);
}

// ── Strategy 3: Volume Breakout ───────────────────────────────────────────────

function breakoutVolume(candles, currentPrice, { lookback = 20, volumeMultiplier = 1.5 }) {
  if (candles.length < lookback) return noSignal(`Need ${lookback} candles — only ${candles.length} available`, currentPrice);

  const recent      = candles.slice(-lookback);
  const prevCandles = recent.slice(0, -1);
  const prevHigh    = Math.max(...prevCandles.map(c => c.high));
  const avgVolume   = prevCandles.reduce((s, c) => s + (c.volume || 0), 0) / prevCandles.length;
  const lastVolume  = candles[candles.length - 1]?.volume || 0;

  if (currentPrice > prevHigh && avgVolume > 0 && lastVolume > avgVolume * volumeMultiplier) {
    const stop = parseFloat((prevHigh * 0.99).toFixed(2));
    const tp   = parseFloat((currentPrice + (currentPrice - prevHigh) * 2).toFixed(2));
    return { signal: "buy", reason: `Breakout above ฿${prevHigh.toFixed(2)} with ${(lastVolume/avgVolume).toFixed(1)}x volume`, approaching: false, approachingReason: null, approachingEta: null, suggestedEntry: currentPrice, suggestedStop: stop, suggestedTP: tp };
  }

  const gap = ((prevHigh - currentPrice) / prevHigh * 100).toFixed(2);
  return noSignal(`Watching for breakout above ฿${prevHigh.toFixed(2)} (${gap}% away)`, currentPrice);
}

// ── Strategy 4: Golden Cross / Death Cross ────────────────────────────────────

function goldenCross(candles, currentPrice, { shortPeriod = 50, longPeriod = 200 }) {
  if (candles.length < longPeriod + 1) return noSignal(`Need ${longPeriod + 1} candles — only ${candles.length} available (needs 1M daily data)`, currentPrice);

  const closes      = candles.map(c => c.close);
  const maShortNow  = sma(closes, shortPeriod);
  const maLongNow   = sma(closes, longPeriod);
  const prevCloses  = closes.slice(0, -1);
  const maShortPrev = sma(prevCloses, shortPeriod);
  const maLongPrev  = sma(prevCloses, longPeriod);

  const goldenCross = maShortPrev <= maLongPrev && maShortNow > maLongNow;
  const deathCross  = maShortPrev >= maLongPrev && maShortNow < maLongNow;

  const gap    = Math.abs(maShortNow - maLongNow);
  const gapPct = maLongNow > 0 ? (gap / maLongNow) * 100 : 999;
  const approaching = !goldenCross && !deathCross && gapPct < 0.5;

  if (goldenCross) {
    return { signal: "buy", reason: `Golden Cross: MA${shortPeriod} crossed above MA${longPeriod} — major bullish`, approaching: false, approachingReason: null, approachingEta: null, suggestedEntry: currentPrice, suggestedStop: parseFloat((currentPrice * 0.95).toFixed(2)), suggestedTP: parseFloat((currentPrice * 1.10).toFixed(2)) };
  }
  if (deathCross) {
    return { signal: "sell", reason: `Death Cross: MA${shortPeriod} crossed below MA${longPeriod} — major bearish`, approaching: false, approachingReason: null, approachingEta: null, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
  }
  if (approaching) {
    const bullish = maShortNow < maLongNow;
    return {
      signal: "hold",
      reason: `MA${shortPeriod}/MA${longPeriod} converging — gap ${gapPct.toFixed(2)}%`,
      approaching: true,
      approachingReason: `Gap ${gapPct.toFixed(2)}% — ${bullish ? "Golden Cross (BUY)" : "Death Cross (SELL)"} forming`,
      approachingEta: "~hours to days",
      suggestedEntry: currentPrice,
      suggestedStop:  bullish ? parseFloat((currentPrice * 0.95).toFixed(2)) : null,
      suggestedTP:    bullish ? parseFloat((currentPrice * 1.10).toFixed(2)) : null,
    };
  }

  const trend = maShortNow > maLongNow ? "bullish" : "bearish";
  return noSignal(`${trend} trend (gap ${gapPct.toFixed(2)}%) — waiting for cross`, currentPrice);
}

// ── Strategy 5: Support / Resistance Bounce ───────────────────────────────────

function supportBounce(candles, currentPrice, { lookback = 30, tolerancePct = 0.02 }) {
  if (candles.length < lookback) return noSignal(`Need ${lookback} candles — only ${candles.length} available`, currentPrice);

  const recent      = candles.slice(-lookback);
  const prevCandles = recent.slice(0, -1);
  const support     = Math.min(...prevCandles.map(c => c.low));
  const resistance  = Math.max(...prevCandles.map(c => c.high));
  const tolerance   = currentPrice * tolerancePct;

  const nearSupport    = Math.abs(currentPrice - support)    <= tolerance;
  const nearResistance = Math.abs(currentPrice - resistance) <= tolerance;
  const approachingSupport    = !nearSupport    && Math.abs(currentPrice - support)    <= currentPrice * 0.01;
  const approachingResistance = !nearResistance && Math.abs(currentPrice - resistance) <= currentPrice * 0.01;

  if (nearSupport) {
    return { signal: "buy", reason: `At ${lookback}-bar support ฿${support.toFixed(2)} — bounce entry`, approaching: false, approachingReason: null, approachingEta: null, suggestedEntry: currentPrice, suggestedStop: parseFloat((support * (1 - tolerancePct)).toFixed(2)), suggestedTP: parseFloat(resistance.toFixed(2)) };
  }
  if (nearResistance) {
    return { signal: "sell", reason: `At ${lookback}-bar resistance ฿${resistance.toFixed(2)} — take profit`, approaching: false, approachingReason: null, approachingEta: null, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
  }
  if (approachingSupport) {
    return { signal: "hold", reason: `Drifting toward support ฿${support.toFixed(2)} — within 1%`, approaching: true, approachingReason: `Approaching support ฿${support.toFixed(2)} — BUY zone near`, approachingEta: "~1–5 candles", suggestedEntry: support, suggestedStop: parseFloat((support * (1 - tolerancePct)).toFixed(2)), suggestedTP: parseFloat(resistance.toFixed(2)) };
  }
  if (approachingResistance) {
    return { signal: "hold", reason: `Approaching resistance ฿${resistance.toFixed(2)} — within 1%`, approaching: true, approachingReason: `Approaching resistance ฿${resistance.toFixed(2)} — consider readying SELL`, approachingEta: "~1–5 candles", suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
  }

  const midpoint = (support + resistance) / 2;
  const zone = currentPrice < midpoint ? "lower half — nearer support" : "upper half — nearer resistance";
  return noSignal(`S: ฿${support.toFixed(2)} | R: ฿${resistance.toFixed(2)} | ${zone}`, currentPrice);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function noSignal(reason, currentPrice) {
  return { signal: "hold", reason, approaching: false, approachingReason: null, approachingEta: null, suggestedEntry: currentPrice, suggestedStop: null, suggestedTP: null };
}

function sma(arr, period) {
  if (arr.length < period) return null;
  return arr.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return 50;
  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  const initial = changes.slice(0, period);
  let avgGain = initial.filter(c => c > 0).reduce((s, c) => s + c, 0) / period;
  let avgLoss = initial.filter(c => c < 0).reduce((s, c) => s + Math.abs(c), 0) / period;
  for (let i = period; i < changes.length; i++) {
    const c = changes[i];
    avgGain = (avgGain * (period - 1) + Math.max(c, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.abs(Math.min(c, 0))) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}
