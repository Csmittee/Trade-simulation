/**
 * Tooltip.jsx
 * Bubble assist system — wraps any element and shows a contextual explanation.
 * Usage: <Tooltip id="tooltip-order-buy" content="Place a buy order at current price">
 *          <button>BUY</button>
 *        </Tooltip>
 */

import { useState, useRef, useEffect } from "react";

// ── Tooltip Content Library ───────────────────────────────────────────────────
// All bubble text lives here — single source of truth for all UI hints.

export const TOOLTIPS = {
  // Header
  "tooltip-header-balance":       "Your total virtual cash available to place new trades. Does not include value of open positions.",
  "tooltip-header-equity":        "Total portfolio value = cash balance + current market value of all open positions.",
  "tooltip-header-day-pnl":       "Today's profit or loss from all closed trades in this session.",
  "tooltip-header-market-hours":  "Toggle ON to restrict trades to real market hours (SET: 10:00–12:30, 14:30–17:00 ICT). Toggle OFF to trade any time using simulated prices.",
  "tooltip-header-reset":         "Game Over & Restart — resets your balance to your chosen starting amount and clears all open positions. Your trade history is kept so you can review past decisions.",

  // Chart
  "tooltip-chart-candlestick":    "Candlestick chart shows open, high, low, and close price for each time period. Green = price went up. Red = price went down.",
  "tooltip-chart-line":           "Simple line chart showing closing price over time. Easier to read the overall trend.",
  "tooltip-chart-ma5":            "Moving Average 5 — average price of the last 5 periods. A short-term trend indicator.",
  "tooltip-chart-ma20":           "Moving Average 20 — average price of the last 20 periods. A medium-term trend indicator. When MA5 crosses above MA20, it's a bullish signal.",
  "tooltip-chart-timeframe-1D":   "Show price data for the last 1 day in hourly intervals.",
  "tooltip-chart-timeframe-1W":   "Show price data for the last 7 days.",
  "tooltip-chart-timeframe-1M":   "Show price data for the last 30 days.",
  "tooltip-chart-insider":        "Hover over any candle or price point for 1.5 seconds to get AI-generated intel explaining what news or events may have caused that price movement.",

  // Order Panel
  "tooltip-order-buy":            "Open a LONG position — you profit if the price goes UP after you buy.",
  "tooltip-order-sell":           "Close an existing position and take your profit or loss at the current market price.",
  "tooltip-order-qty":            "How many units to buy. For gold: measured in baht-weight (บาทหนัก). For SET stocks: measured in shares (minimum 1 lot = 100 shares).",
  "tooltip-order-price":          "Entry price for your order. Defaults to current market price. You can set a limit price to wait for a better entry.",
  "tooltip-order-stoploss":       "Stop Loss — if the price falls to this level, your position is automatically sold to limit your loss. Recommended: 2–5% below entry.",
  "tooltip-order-takeprofit":     "Take Profit — if the price rises to this level, your position is automatically sold to lock in your gain.",
  "tooltip-order-size-suggest":   "Auto-calculate a safe position size based on your balance, entry price, stop loss, and chosen risk level.",

  // Strategy
  "tooltip-strategy-manual":      "You control everything — enter your own price, quantity, stop loss, and take profit manually.",
  "tooltip-strategy-preset":      "Choose from a list of classic trading tactics (MA Crossover, RSI, Breakout, etc.). The system watches the rules and signals when conditions are met.",
  "tooltip-strategy-ai":          "Describe your market view in plain English. Claude analyses current price data and your portfolio, then recommends a trade with reasoning. You approve before it executes.",
  "tooltip-strategy-ma-cross":    "Moving Average Crossover — buys when the short-term average (MA5) crosses above the long-term average (MA20), sells on the reverse.",
  "tooltip-strategy-rsi":         "RSI Mean Reversion — buys when the market is oversold (RSI < 30), sells when overbought (RSI > 70). RSI measures momentum on a 0–100 scale.",
  "tooltip-strategy-breakout":    "Volume Breakout — buys when price breaks above a recent high AND trading volume is unusually high, confirming real demand.",
  "tooltip-strategy-golden-cross": "Golden Cross / Death Cross — uses slower MA50 and MA200. A golden cross (MA50 crosses above MA200) is a strong long-term bullish signal.",
  "tooltip-strategy-support":     "Support & Resistance — buys near price floors (support) where buyers historically step in. Sells near price ceilings (resistance).",

  // Risk Meter
  "tooltip-risk-low":             "Low risk — this trade uses less than 2% of your starting balance. Suitable for beginners or uncertain markets.",
  "tooltip-risk-medium":          "Medium risk — 2–5% of starting balance. Standard position sizing for active traders.",
  "tooltip-risk-high":            "High risk — over 5% of starting balance. One bad trade can significantly impact your portfolio. Use stop losses.",
  "tooltip-risk-drawdown":        "Maximum Drawdown — the largest peak-to-trough decline in your portfolio value during this session. Lower is better.",
  "tooltip-risk-winrate":         "Win Rate — percentage of closed trades that were profitable. Even a 40% win rate can be profitable if your average win is bigger than your average loss.",

  // Trade Log
  "tooltip-log-pnl":              "Profit or Loss on this individual trade in THB and as a percentage of the trade cost.",
  "tooltip-log-strategy":         "Which strategy mode was active when this trade was placed.",

  // Market Status
  "tooltip-market-set-open":      "SET market is currently open for trading (Mon–Fri, 10:00–12:30 and 14:30–17:00 ICT).",
  "tooltip-market-set-closed":    "SET market is closed. Enable 'Market Hours OFF' toggle to simulate trades outside real hours.",
  "tooltip-market-gold-open":     "Gold market is open for trading (24×5, Monday–Friday).",
  "tooltip-market-gold-closed":   "Gold market is closed on weekends.",
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function Tooltip({ id, content, children, position = "top", width = 220 }) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const wrapperRef = useRef(null);
  const timerRef = useRef(null);

  // Allow content to be passed directly or looked up by ID
  const text = content || TOOLTIPS[id] || "No description available.";

  const showTooltip = (e) => {
    timerRef.current = setTimeout(() => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (rect) {
        setCoords({ x: rect.left + rect.width / 2, y: rect.top });
        setVisible(true);
      }
    }, 400); // 400ms delay before showing — feels natural
  };

  const hideTooltip = () => {
    clearTimeout(timerRef.current);
    setVisible(false);
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <span
      ref={wrapperRef}
      className="relative inline-flex"
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
    >
      {children}

      {visible && (
        <span
          className="tooltip-bubble"
          style={{
            position: "fixed",
            left: coords.x,
            top: coords.y - 8,
            transform: "translate(-50%, -100%)",
            width: `${width}px`,
            zIndex: 9999,
            pointerEvents: "none",
          }}
        >
          {text}
          <span className="tooltip-arrow" />
        </span>
      )}
    </span>
  );
}

/**
 * Inline tooltip icon — shows a ⓘ that reveals help text on hover.
 * Usage: <TooltipIcon id="tooltip-risk-drawdown" />
 */
export function TooltipIcon({ id, content, position = "top" }) {
  return (
    <Tooltip id={id} content={content} position={position} width={240}>
      <span
        className="tooltip-icon"
        aria-label="Help"
        role="tooltip"
        tabIndex={0}
      >
        ⓘ
      </span>
    </Tooltip>
  );
}
