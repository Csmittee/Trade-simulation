/**
 * StrategyPanel.jsx
 * Phase 3 — Strategy selector, live signal display, and semi-auto execution.
 *
 * Props:
 *   market        "gold" | "set"
 *   priceHistory  OHLC array (from injector)
 *   currentPrice  number
 *   portfolio     portfolio state object
 *   activeStrategy string | null  (controlled by parent)
 *   onStrategyChange fn(id | null)
 *   onExecuteBuy  fn({ symbol, qty, price, stopLoss, takeProfit, strategy })
 *   onExecuteSell fn(positionId, price)  — closes first matching position
 *   symbol        string — active symbol (e.g. "THAI_GOLD_BAHT", "PTT.BK")
 */

import { useState, useEffect, useRef } from "react";
import { runStrategy } from "../injectors/strategy-injector.js";
import { suggestPositionSize } from "../core/portfolio-engine.js";
import Tooltip, { TooltipIcon } from "./Tooltip.jsx";
import config from "../../config.js";

const PRESETS = config.strategies.presets;

export default function StrategyPanel({
  market,
  priceHistory,
  currentPrice,
  portfolio,
  activeStrategy,
  onStrategyChange,
  onExecuteBuy,
  onExecuteSell,
  symbol,
}) {
  const [signal,       setSignal]       = useState(null);   // latest signal object
  const [pendingTrade, setPendingTrade] = useState(null);   // waiting for user confirm
  const [lastSignalId, setLastSignalId] = useState(null);   // prevent duplicate fires
  const [notification, setNotification] = useState(null);   // { text, type: "success"|"error" }
  const [isExpanded,   setIsExpanded]   = useState(true);

  const signalRef = useRef(null);

  // ── Run strategy on every price tick ───────────────────────────────────────
  useEffect(() => {
    if (!activeStrategy || !currentPrice || !priceHistory?.length) {
      setSignal(null);
      return;
    }

    const result = runStrategy({
      priceHistory,
      currentPrice,
      strategyId: activeStrategy,
      portfolio,
      market,
    });

    setSignal(result);
    signalRef.current = result;

    // Only surface actionable signals (buy/sell) — not hold
    if (result?.signal === "buy" || result?.signal === "sell") {
      // De-duplicate: same signal+price shouldn't re-trigger
      const sigId = `${result.signal}-${currentPrice}`;
      if (sigId !== lastSignalId) {
        setLastSignalId(sigId);
        // Auto-stage confirmation prompt (don't execute yet)
        if (result.signal === "buy") {
          const qty = suggestPositionSize(
            portfolio?.balance || 0,
            currentPrice,
            result.suggestedStop,
            "medium",
            market
          );
          setPendingTrade({ type: "buy", qty, signal: result });
        } else if (result.signal === "sell") {
          // Find the first open position for this symbol
          const position = portfolio?.positions?.find(p => p.symbol === symbol && p.market === market);
          if (position) {
            setPendingTrade({ type: "sell", positionId: position.id, signal: result });
          }
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPrice, activeStrategy, priceHistory]);

  // ── Confirm execution ───────────────────────────────────────────────────────
  const handleConfirm = () => {
    if (!pendingTrade) return;

    if (pendingTrade.type === "buy") {
      onExecuteBuy({
        symbol,
        market,
        qty: pendingTrade.qty,
        price: currentPrice,
        stopLoss:   pendingTrade.signal.suggestedStop,
        takeProfit: pendingTrade.signal.suggestedTP,
        strategy:   activeStrategy,
      });
      showNotification(`✅ BUY executed: ${pendingTrade.qty} × ${symbol} @ ฿${currentPrice?.toLocaleString()}`, "success");
    }

    if (pendingTrade.type === "sell") {
      onExecuteSell(pendingTrade.positionId, currentPrice);
      showNotification(`✅ SELL executed: closed ${symbol} @ ฿${currentPrice?.toLocaleString()}`, "success");
    }

    setPendingTrade(null);
  };

  const handleDismiss = () => {
    setPendingTrade(null);
    showNotification("Signal dismissed.", "info");
  };

  const showNotification = (text, type) => {
    setNotification({ text, type });
    setTimeout(() => setNotification(null), 4000);
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const signalColor = {
    buy:  "#22c55e",
    sell: "#ef4444",
    hold: "#f59e0b",
    null: "#6b7280",
  }[signal?.signal || null];

  const signalIcon = {
    buy:  "▲",
    sell: "▼",
    hold: "◆",
  }[signal?.signal] || "—";

  const activePreset = PRESETS.find(p => p.id === activeStrategy);

  return (
    <div className="strategy-panel">

      {/* ── Header ── */}
      <div className="strategy-header" onClick={() => setIsExpanded(e => !e)}>
        <span className="strategy-title">
          🤖 Auto-Strategy
          <TooltipIcon content="Select a preset trading strategy. The system watches prices and alerts you when conditions are met. You confirm before each trade executes." />
        </span>
        <span className="strategy-toggle-btn">{isExpanded ? "▲" : "▼"}</span>
      </div>

      {isExpanded && (
        <div className="strategy-body">

          {/* ── Strategy Selector ── */}
          <div className="strategy-selector">
            <div className="strategy-label">Preset Strategy</div>
            <div className="strategy-options">
              <button
                className={`strategy-opt ${!activeStrategy ? "active" : ""}`}
                onClick={() => { onStrategyChange(null); setSignal(null); setPendingTrade(null); }}
              >
                Off
              </button>
              {PRESETS.map(preset => (
                <button
                  key={preset.id}
                  className={`strategy-opt ${activeStrategy === preset.id ? "active" : ""}`}
                  onClick={() => { onStrategyChange(preset.id); setPendingTrade(null); }}
                  title={preset.description}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </div>

          {/* ── Active strategy description ── */}
          {activePreset && (
            <div className="strategy-description">
              {activePreset.description}
            </div>
          )}

          {/* ── Live Signal Display ── */}
          {activeStrategy && signal && (
            <div className="signal-display">
              <div className="signal-row">
                <span className="signal-badge" style={{ background: signalColor }}>
                  {signalIcon} {signal.signal?.toUpperCase() || "—"}
                </span>
                <span className="signal-symbol">{symbol?.replace(".BK","")}</span>
                <span className="signal-price">฿{currentPrice?.toLocaleString()}</span>
              </div>
              <div className="signal-reason">{signal.reason}</div>
              {signal.suggestedStop && (
                <div className="signal-levels">
                  <span className="sl-level">SL: ฿{signal.suggestedStop?.toLocaleString()}</span>
                  {signal.suggestedTP && (
                    <span className="tp-level">TP: ฿{signal.suggestedTP?.toLocaleString()}</span>
                  )}
                </div>
              )}
            </div>
          )}

          {activeStrategy && !signal && (
            <div className="signal-waiting">
              ⏳ Watching {symbol?.replace(".BK","")} for signals...
            </div>
          )}

          {!activeStrategy && (
            <div className="signal-waiting">
              Select a strategy above to start monitoring.
            </div>
          )}

          {/* ── Pending Trade Confirmation ── */}
          {pendingTrade && (
            <div className={`trade-confirm ${pendingTrade.type === "buy" ? "confirm-buy" : "confirm-sell"}`}>
              <div className="confirm-title">
                {pendingTrade.type === "buy" ? "📈 BUY Signal" : "📉 SELL Signal"} — Confirm?
              </div>
              <div className="confirm-details">
                {pendingTrade.type === "buy" && (
                  <>
                    <div>Qty: <strong>{pendingTrade.qty} {market === "gold" ? "baht-weight" : "shares"}</strong></div>
                    <div>Entry: <strong>฿{currentPrice?.toLocaleString()}</strong></div>
                    {pendingTrade.signal.suggestedStop && (
                      <div>Stop Loss: <strong>฿{pendingTrade.signal.suggestedStop?.toLocaleString()}</strong></div>
                    )}
                    {pendingTrade.signal.suggestedTP && (
                      <div>Take Profit: <strong>฿{pendingTrade.signal.suggestedTP?.toLocaleString()}</strong></div>
                    )}
                    <div className="confirm-cost">
                      Est. cost: ฿{(pendingTrade.qty * currentPrice)?.toLocaleString("en-US",{maximumFractionDigits:0})}
                    </div>
                  </>
                )}
                {pendingTrade.type === "sell" && (
                  <div>Close open {symbol?.replace(".BK","")} position at ฿{currentPrice?.toLocaleString()}</div>
                )}
              </div>
              <div className="confirm-actions">
                <button className="confirm-btn confirm-yes" onClick={handleConfirm}>
                  ✓ Execute
                </button>
                <button className="confirm-btn confirm-no" onClick={handleDismiss}>
                  ✗ Dismiss
                </button>
              </div>
            </div>
          )}

          {/* ── Notification Toast ── */}
          {notification && (
            <div className={`strategy-notification ${notification.type}`}>
              {notification.text}
            </div>
          )}

        </div>
      )}
    </div>
  );
}
