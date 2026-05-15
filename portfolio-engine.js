/**
 * portfolio-engine.js
 * Core trading logic: balance, positions, P&L, risk metrics.
 * Pure functions — no API calls, no side effects.
 * All state is passed in and returned out (easy to test, easy to persist to KV).
 */

import config from "../../config.js";

// ── Balance ───────────────────────────────────────────────────────────────────

/**
 * Create a fresh portfolio state (used on first load or game reset)
 */
export function createPortfolio(startingBalance = config.app.defaultBalance) {
  return {
    balance: startingBalance,           // available cash in THB
    startingBalance,                    // reference point for total return calc
    positions: [],                      // open positions array
    closedTrades: [],                   // completed trades (session only; full history in D1)
    sessionStartedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

/**
 * Reset portfolio — wipes positions and balance, keeps nothing in memory.
 * D1 trade history is preserved (by design — learning ground).
 */
export function resetPortfolio(newBalance = config.app.defaultBalance) {
  return createPortfolio(newBalance);
}

// ── Orders ────────────────────────────────────────────────────────────────────

/**
 * Execute a BUY order. Returns { portfolio, trade, error }.
 * @param {object} portfolio  - current portfolio state
 * @param {object} order      - { symbol, market, qty, price, stopLoss, takeProfit, strategy }
 */
export function executeBuy(portfolio, order) {
  const { symbol, market, qty, price, stopLoss, takeProfit, strategy = "manual" } = order;

  if (!qty || qty <= 0)    return { error: "Quantity must be greater than zero" };
  if (!price || price <= 0) return { error: "Price must be greater than zero" };

  const totalCost = calculateOrderCost(qty, price, market);

  if (totalCost > portfolio.balance) {
    return { error: `Insufficient balance. Need ฿${fmt(totalCost)}, have ฿${fmt(portfolio.balance)}` };
  }

  // Risk check
  const riskPct = totalCost / portfolio.startingBalance;
  const riskWarning = riskPct > config.ui.riskLevels.high.maxPortfolioPct
    ? `High risk: this trade uses ${(riskPct * 100).toFixed(1)}% of starting balance`
    : null;

  const trade = {
    id: generateTradeId(),
    type: "buy",
    symbol,
    market,                             // "gold" | "set"
    qty,
    entryPrice: price,
    stopLoss:   stopLoss   || null,
    takeProfit: takeProfit || null,
    strategy,
    totalCost,
    openedAt: new Date().toISOString(),
    status: "open",
  };

  const position = {
    ...trade,
    currentPrice: price,
    unrealisedPnL: 0,
    unrealisedPnLPct: 0,
  };

  const updatedPortfolio = {
    ...portfolio,
    balance: portfolio.balance - totalCost,
    positions: [...portfolio.positions, position],
    lastUpdatedAt: new Date().toISOString(),
  };

  return { portfolio: updatedPortfolio, trade, warning: riskWarning, error: null };
}

/**
 * Execute a SELL / CLOSE order on an existing position.
 * @param {object} portfolio  - current portfolio state
 * @param {string} positionId - trade ID to close
 * @param {number} currentPrice - current market price
 */
export function executeSell(portfolio, positionId, currentPrice) {
  const posIndex = portfolio.positions.findIndex(p => p.id === positionId);
  if (posIndex === -1) return { error: "Position not found" };

  const position = portfolio.positions[posIndex];
  const proceeds = calculateProceeds(position.qty, currentPrice, position.market);
  const pnl = proceeds - position.totalCost;
  const pnlPct = (pnl / position.totalCost) * 100;

  const closedTrade = {
    ...position,
    exitPrice: currentPrice,
    proceeds,
    pnl,
    pnlPct,
    closedAt: new Date().toISOString(),
    status: "closed",
  };

  const updatedPositions = portfolio.positions.filter((_, i) => i !== posIndex);

  const updatedPortfolio = {
    ...portfolio,
    balance: portfolio.balance + proceeds,
    positions: updatedPositions,
    closedTrades: [...portfolio.closedTrades, closedTrade],
    lastUpdatedAt: new Date().toISOString(),
  };

  return { portfolio: updatedPortfolio, trade: closedTrade, error: null };
}

// ── Price Updates ─────────────────────────────────────────────────────────────

/**
 * Update all open positions with latest prices.
 * Call this on every price refresh tick.
 */
export function updatePositionPrices(portfolio, priceMap) {
  // priceMap: { "XAUUSD": 2350.50, "PTT.BK": 42.75, ... }
  const updatedPositions = portfolio.positions.map(pos => {
    const currentPrice = priceMap[pos.symbol];
    if (!currentPrice) return pos;

    const currentValue = calculateProceeds(pos.qty, currentPrice, pos.market);
    const unrealisedPnL = currentValue - pos.totalCost;
    const unrealisedPnLPct = (unrealisedPnL / pos.totalCost) * 100;

    // Auto-trigger stop loss or take profit
    let autoClose = null;
    if (pos.stopLoss && currentPrice <= pos.stopLoss) {
      autoClose = { reason: "stop_loss", price: currentPrice };
    } else if (pos.takeProfit && currentPrice >= pos.takeProfit) {
      autoClose = { reason: "take_profit", price: currentPrice };
    }

    return { ...pos, currentPrice, unrealisedPnL, unrealisedPnLPct, autoClose };
  });

  return { ...portfolio, positions: updatedPositions };
}

// ── P&L Analytics ─────────────────────────────────────────────────────────────

/**
 * Calculate full portfolio summary for display.
 */
export function calcPortfolioSummary(portfolio, priceMap = {}) {
  const updated = updatePositionPrices(portfolio, priceMap);

  const totalUnrealisedPnL = updated.positions.reduce(
    (sum, p) => sum + (p.unrealisedPnL || 0), 0
  );

  const totalPositionValue = updated.positions.reduce((sum, p) => {
    const price = priceMap[p.symbol] || p.entryPrice;
    return sum + calculateProceeds(p.qty, price, p.market);
  }, 0);

  const totalEquity = updated.balance + totalPositionValue;
  const totalReturn = totalEquity - portfolio.startingBalance;
  const totalReturnPct = (totalReturn / portfolio.startingBalance) * 100;

  // Session P&L from closed trades
  const realisedPnL = portfolio.closedTrades.reduce((sum, t) => sum + t.pnl, 0);

  // Win rate
  const winners = portfolio.closedTrades.filter(t => t.pnl > 0);
  const winRate = portfolio.closedTrades.length > 0
    ? (winners.length / portfolio.closedTrades.length) * 100
    : 0;

  // Avg gain vs avg loss
  const avgGain = winners.length > 0
    ? winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length
    : 0;
  const losers = portfolio.closedTrades.filter(t => t.pnl < 0);
  const avgLoss = losers.length > 0
    ? losers.reduce((s, t) => s + t.pnlPct, 0) / losers.length
    : 0;

  // Max drawdown (from peak equity across closed trades)
  const maxDrawdown = calcMaxDrawdown(portfolio.closedTrades, portfolio.startingBalance);

  return {
    balance: updated.balance,
    totalPositionValue,
    totalEquity,
    totalReturn,
    totalReturnPct,
    totalUnrealisedPnL,
    realisedPnL,
    winRate,
    avgGain,
    avgLoss,
    maxDrawdown,
    openPositionCount: updated.positions.length,
    closedTradeCount: portfolio.closedTrades.length,
  };
}

/**
 * Calculate hourly P&L breakdown for the current session.
 * Returns array of { hour: "10:00", pnl: number } for chart display.
 */
export function calcHourlyPnL(closedTrades) {
  const hourlyMap = {};

  closedTrades.forEach(trade => {
    const closedAt = new Date(trade.closedAt);
    const hourKey = `${String(closedAt.getHours()).padStart(2, "0")}:00`;
    if (!hourlyMap[hourKey]) hourlyMap[hourKey] = 0;
    hourlyMap[hourKey] += trade.pnl;
  });

  return Object.entries(hourlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, pnl]) => ({ hour, pnl }));
}

// ── Risk Helpers ──────────────────────────────────────────────────────────────

/**
 * Suggest position size based on risk tolerance.
 * @param {number} balance - available balance
 * @param {number} price   - entry price
 * @param {number} stopLoss - stop loss price
 * @param {string} riskLevel - "low" | "medium" | "high"
 * @param {string} market  - "gold" | "set"
 */
export function suggestPositionSize(balance, price, stopLoss, riskLevel = "medium", market) {
  const maxRiskPct = config.ui.riskLevels[riskLevel]?.maxPortfolioPct || 0.05;
  const maxRiskAmount = balance * maxRiskPct;

  if (!stopLoss || stopLoss >= price) {
    // No stop loss — size by max portfolio allocation
    const maxAllocation = balance * maxRiskPct * 10; // 10x the risk % as max position
    const lotSize = getLotSize(market);
    return Math.max(lotSize, Math.floor(maxAllocation / price / lotSize) * lotSize);
  }

  const riskPerUnit = price - stopLoss;
  if (riskPerUnit <= 0) return 0;

  const suggestedQty = Math.floor(maxRiskAmount / riskPerUnit);
  const lotSize = getLotSize(market);
  return Math.max(lotSize, Math.floor(suggestedQty / lotSize) * lotSize);
}

/**
 * Get risk label for a given trade size relative to portfolio.
 */
export function getRiskLabel(tradeCost, portfolioBalance) {
  const pct = tradeCost / portfolioBalance;
  if (pct <= config.ui.riskLevels.low.maxPortfolioPct)    return "low";
  if (pct <= config.ui.riskLevels.medium.maxPortfolioPct) return "medium";
  return "high";
}

// ── Market Hours ──────────────────────────────────────────────────────────────

/**
 * Check if a market is currently open.
 * @param {string} market - "set" | "gold"
 * @param {boolean} enforceHours - from dashboard toggle
 */
export function isMarketOpen(market, enforceHours = true) {
  if (!enforceHours) return true;

  const now = new Date();
  // Convert to ICT (UTC+7)
  const ictOffset = 7 * 60;
  const ictTime = new Date(now.getTime() + (ictOffset + now.getTimezoneOffset()) * 60000);
  const day = ictTime.getDay();   // 0=Sun, 6=Sat
  const hhmm = ictTime.getHours() * 100 + ictTime.getMinutes();

  const tradingDays = config.marketHours[market]?.tradingDays || [1,2,3,4,5];
  if (!tradingDays.includes(day)) return false;

  if (market === "set") {
    return (hhmm >= 1000 && hhmm <= 1230) || (hhmm >= 1430 && hhmm <= 1700);
  }

  if (market === "gold") {
    // Gold 24x5 — only closed on weekends
    return true;
  }

  return false;
}

/**
 * Get time until next market open (in minutes).
 */
export function minutesUntilOpen(market) {
  if (isMarketOpen(market, true)) return 0;

  const now = new Date();
  const ictOffset = 7 * 60;
  const ict = new Date(now.getTime() + (ictOffset + now.getTimezoneOffset()) * 60000);
  const day = ict.getDay();
  const hhmm = ict.getHours() * 100 + ict.getMinutes();

  if (market === "set") {
    if (hhmm < 1000) {
      return (1000 - hhmm) > 100
        ? Math.floor((10 * 60) - (ict.getHours() * 60 + ict.getMinutes()))
        : (10 * 60) - (ict.getHours() * 60 + ict.getMinutes());
    }
    if (hhmm > 1230 && hhmm < 1430) {
      return (14 * 60 + 30) - (ict.getHours() * 60 + ict.getMinutes());
    }
    // After close or weekend — next Monday 10:00
    const daysUntilMonday = day === 0 ? 1 : (8 - day) % 7 || 7;
    return daysUntilMonday * 24 * 60 + (10 * 60) - (ict.getHours() * 60 + ict.getMinutes());
  }

  // Gold: just next Monday
  const daysUntilMonday = day === 0 ? 1 : (8 - day) % 7 || 7;
  return daysUntilMonday * 24 * 60;
}

// ── Internal Helpers ──────────────────────────────────────────────────────────

function calculateOrderCost(qty, price, market) {
  // SET: qty in shares, price in THB — add 0.157% brokerage fee (typical Thai broker)
  // Gold: qty in baht-weight, price in THB — no brokerage, but spread already in price
  const base = qty * price;
  if (market === "set") {
    const commission = Math.max(50, base * 0.00157); // min ฿50 commission
    const vat = commission * 0.07;
    return base + commission + vat;
  }
  return base; // gold dealer spread is baked into quoted price
}

function calculateProceeds(qty, price, market) {
  const base = qty * price;
  if (market === "set") {
    const commission = Math.max(50, base * 0.00157);
    const vat = commission * 0.07;
    const transferFee = base * 0.001; // 0.1% transfer fee on sell
    return base - commission - vat - transferFee;
  }
  return base;
}

function getLotSize(market) {
  if (market === "set") return 100; // SET minimum lot = 100 shares
  if (market === "gold") return 1;  // 1 baht-weight minimum
  return 1;
}

function calcMaxDrawdown(closedTrades, startingBalance) {
  if (!closedTrades.length) return 0;
  let peak = startingBalance;
  let maxDD = 0;
  let running = startingBalance;
  closedTrades.forEach(t => {
    running += t.pnl;
    if (running > peak) peak = running;
    const dd = (peak - running) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  });
  return maxDD;
}

function generateTradeId() {
  return `TRD-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function fmt(n) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
