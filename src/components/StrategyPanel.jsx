/**
 * StrategyPanel.jsx
 * Phase 3 patch — Full feature set:
 *   - Auto Execute toggle (per session, not per strategy)
 *   - Approaching alert with Arm It button (predictable strategies only)
 *   - Armed state → auto-executes when signal fires IF size allows
 *   - Size-based execution tiers: auto < 5% | confirm 5–20% | block > 20%
 *   - 5-min disarm timeout
 *   - Fix: strategy name in positions (passed via order.strategy)
 *   - 📌 Tactic Card — pinned rules reminder, collapsible
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { runStrategy, getExecutionTier } from "../injectors/strategy-injector.js";
import { suggestPositionSize } from "../core/portfolio-engine.js";
import Tooltip, { TooltipIcon } from "./Tooltip.jsx";
import config from "../../config.js";

const PRESETS        = config.strategies.presets;
const DISARM_MS      = 5 * 60 * 1000; // 5 minutes

// Strategies that support approaching alert
const APPROACHING_SUPPORTED = new Set(["ma_crossover", "golden_cross", "support_bounce"]);

// Tactic rules — pinned in UI, not in repo
const TACTIC_RULES = [
  { icon: "⚡", text: "Auto-execute only fires if trade < 5% of balance. Bigger trades always need your confirm." },
  { icon: "🚫", text: "Trades > 20% of balance are blocked regardless of strategy or armed state." },
  { icon: "⚠️", text: "Approaching alert only shown for strategies with ~1hr leadtime (MA Crossover, Golden Cross, Support/Resistance). RSI and Volume Breakout are too sudden." },
  { icon: "🎯", text: "Arm It = pre-authorize the next crossover. System fires automatically when the condition hits." },
  { icon: "⏱", text: "Armed state auto-disarms after 5 minutes if no signal fires." },
  { icon: "📏", text: "Gold minimum: 1 baht-weight. SET minimum: 100 shares. No fractional units." },
];

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
  const [signal,        setSignal]        = useState(null);
  const [pendingTrade,  setPendingTrade]  = useState(null);
  const [lastSignalId,  setLastSignalId]  = useState(null);
  const [notification,  setNotification]  = useState(null);
  const [isExpanded,    setIsExpanded]    = useState(true);
  const [tacticOpen,    setTacticOpen]    = useState(false);

  // Auto-execute toggle — user's choice for this session
  const [autoExecute,   setAutoExecute]   = useState(false);

  // Armed state — user clicked "Arm It" on an approaching alert
  const [armed,         setArmed]         = useState(false);
  const [armedAt,       setArmedAt]       = useState(null);
  const [armedSignal,   setArmedSignal]   = useState(null); // which direction was armed

  const disarmTimerRef  = useRef(null);
  const signalRef       = useRef(null);

  // ── Run strategy on every price tick ───────────────────────────────────────
  useEffect(() => {
    if (!activeStrategy || !currentPrice || !priceHistory?.length) {
      setSignal(null);
      return;
    }

    const result = runStrategy({ priceHistory, currentPrice, strategyId: activeStrategy, portfolio, market });
    setSignal(result);
    signalRef.current = result;

    if (!result) return;

    // ── Check armed state first ──────────────────────────────────────────────
    if (armed && (result.signal === "buy" || result.signal === "sell")) {
      // Armed + signal fired → check size tier
      const qty = suggestPositionSize(portfolio?.balance || 0, currentPrice, result.suggestedStop, "medium", market);
      const tradeValue = qty * currentPrice;
      const tier = getExecutionTier(tradeValue, portfolio?.balance);

      if (tier === "block") {
        disarm();
        showNotification(`🚫 Trade blocked — size exceeds 20% of balance (฿${tradeValue.toLocaleString("en-US", {maximumFractionDigits:0})}). Adjust manually.`, "error");
        return;
      }

      if (tier === "auto" && autoExecute) {
        // Full auto — fire immediately
        fireExecution(result, qty, "auto");
        disarm();
        return;
      }

      // confirm tier OR autoExecute is off → show confirm card
      const sigId = `${result.signal}-${currentPrice}`;
      if (sigId !== lastSignalId) {
        setLastSignalId(sigId);
        stagePendingTrade(result, qty);
      }
      return;
    }

    // ── Not armed — surface actionable signals as confirm card ───────────────
    if (result.signal === "buy" || result.signal === "sell") {
      const sigId = `${result.signal}-${currentPrice}`;
      if (sigId !== lastSignalId) {
        setLastSignalId(sigId);
        const qty = suggestPositionSize(portfolio?.balance || 0, currentPrice, result.suggestedStop, "medium", market);
        const tradeValue = qty * currentPrice;
        const tier = getExecutionTier(tradeValue, portfolio?.balance);

        if (tier === "block") {
          showNotification(`🚫 Signal fired but trade size (฿${tradeValue.toLocaleString("en-US",{maximumFractionDigits:0})}) exceeds 20% of balance. Place manually.`, "error");
          return;
        }
        stagePendingTrade(result, qty);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPrice, activeStrategy, priceHistory, armed]);

  // ── Arm / Disarm ──────────────────────────────────────────────────────────
  function armStrategy(direction) {
    setArmed(true);
    setArmedAt(Date.now());
    setArmedSignal(direction);
    showNotification(`🎯 Armed for ${direction === "buy" ? "BUY" : "SELL"} crossover — auto-fires when condition hits (5 min timeout)`, "info");

    // Auto-disarm after 5 minutes
    if (disarmTimerRef.current) clearTimeout(disarmTimerRef.current);
    disarmTimerRef.current = setTimeout(() => {
      disarm();
      showNotification("⏱ Armed state expired — no crossover within 5 minutes. Re-arm to try again.", "info");
    }, DISARM_MS);
  }

  function disarm() {
    setArmed(false);
    setArmedAt(null);
    setArmedSignal(null);
    if (disarmTimerRef.current) clearTimeout(disarmTimerRef.current);
  }

  // ── Stage a pending confirm card ──────────────────────────────────────────
  function stagePendingTrade(result, qty) {
    if (result.signal === "buy") {
      setPendingTrade({ type: "buy", qty, signal: result });
    } else if (result.signal === "sell") {
      const position = portfolio?.positions?.find(p => p.symbol === symbol && p.market === market);
      if (position) setPendingTrade({ type: "sell", positionId: position.id, signal: result });
    }
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  function fireExecution(result, qty, mode) {
    if (result.signal === "buy") {
      onExecuteBuy({
        symbol,
        market,
        qty,
        price:      currentPrice,
        stopLoss:   result.suggestedStop,
        takeProfit: result.suggestedTP,
        strategy:   PRESETS.find(p => p.id === activeStrategy)?.name || activeStrategy,
      });
      showNotification(`✅ ${mode === "auto" ? "AUTO" : ""} BUY executed: ${qty} × ${symbol?.replace(".BK","")} @ ฿${currentPrice?.toLocaleString()}`, "success");
    } else if (result.signal === "sell") {
      const position = portfolio?.positions?.find(p => p.symbol === symbol && p.market === market);
      if (position) {
        onExecuteSell(position.id, currentPrice);
        showNotification(`✅ ${mode === "auto" ? "AUTO" : ""} SELL executed: closed ${symbol?.replace(".BK","")} @ ฿${currentPrice?.toLocaleString()}`, "success");
      }
    }
    setPendingTrade(null);
  }

  const handleConfirm = () => {
    if (!pendingTrade) return;
    fireExecution(pendingTrade.signal, pendingTrade.qty, "manual");
  };

  const handleDismiss = () => {
    setPendingTrade(null);
    showNotification("Signal dismissed.", "info");
  };

  function showNotification(text, type) {
    setNotification({ text, type });
    setTimeout(() => setNotification(null), 5000);
  }

  // ── Arm countdown display ─────────────────────────────────────────────────
  const [armedCountdown, setArmedCountdown] = useState(null);
  useEffect(() => {
    if (!armed || !armedAt) { setArmedCountdown(null); return; }
    const interval = setInterval(() => {
      const remaining = DISARM_MS - (Date.now() - armedAt);
      if (remaining <= 0) { setArmedCountdown(null); clearInterval(interval); return; }
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      setArmedCountdown(`${mins}:${String(secs).padStart(2,"0")}`);
    }, 1000);
    return () => clearInterval(interval);
  }, [armed, armedAt]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const activePreset  = PRESETS.find(p => p.id === activeStrategy);
  const signalColor   = { buy: "#22c55e", sell: "#ef4444", hold: "#f59e0b" }[signal?.signal] || "#6b7280";
  const signalIcon    = { buy: "▲", sell: "▼", hold: "◆" }[signal?.signal] || "—";
  const supportsApproaching = APPROACHING_SUPPORTED.has(activeStrategy);

  return (
    <div className="strategy-panel">

      {/* ── Header ── */}
      <div className="strategy-header" onClick={() => setIsExpanded(e => !e)}>
        <span className="strategy-title">
          🤖 Auto-Strategy
          <TooltipIcon content="Select a preset strategy. The system watches prices every 60 seconds. You control whether it auto-fires or asks for confirmation first." />
          {armed && <span className="armed-badge">🎯 ARMED {armedCountdown}</span>}
        </span>
        <span className="strategy-toggle-btn">{isExpanded ? "▲" : "▼"}</span>
      </div>

      {isExpanded && (
        <div className="strategy-body">

          {/* ── 📌 Tactic Card ── */}
          <div className="tactic-card">
            <div className="tactic-header" onClick={() => setTacticOpen(o => !o)}>
              <span>📌 Tactic Rules</span>
              <span className="tactic-toggle">{tacticOpen ? "▲ hide" : "▼ show"}</span>
            </div>
            {tacticOpen && (
              <div className="tactic-body">
                {TACTIC_RULES.map((rule, i) => (
                  <div key={i} className="tactic-rule">
                    <span className="tactic-icon">{rule.icon}</span>
                    <span className="tactic-text">{rule.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Auto Execute Toggle ── */}
          <div className="auto-execute-row">
            <span className="auto-execute-label">
              Auto Execute
              <TooltipIcon content="When ON + Armed: trades under 5% of balance fire automatically the moment a signal hits. Trades 5–20% always need your confirm. Trades over 20% are always blocked." />
            </span>
            <button
              className={`auto-toggle-btn ${autoExecute ? "on" : "off"}`}
              onClick={() => setAutoExecute(v => !v)}
            >
              {autoExecute ? "ON" : "OFF"}
            </button>
          </div>

          {/* ── Strategy Selector ── */}
          <div className="strategy-selector">
            <div className="strategy-label">Preset Strategy</div>
            <div className="strategy-options">
              <button
                className={`strategy-opt ${!activeStrategy ? "active" : ""}`}
                onClick={() => { onStrategyChange(null); setSignal(null); setPendingTrade(null); disarm(); }}
              >
                Off
              </button>
              {PRESETS.map(preset => (
                <button
                  key={preset.id}
                  className={`strategy-opt ${activeStrategy === preset.id ? "active" : ""}`}
                  onClick={() => { onStrategyChange(preset.id); setPendingTrade(null); disarm(); }}
                  title={preset.description}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </div>

          {/* ── Active strategy description ── */}
          {activePreset && (
            <div className="strategy-description">{activePreset.description}</div>
          )}

          {/* ── Live Signal Display ── */}
          {activeStrategy && signal && (
            <div className="signal-display">
              <div className="signal-row">
                <span className="signal-badge" style={{ background: signalColor }}>
                  {signalIcon} {signal.signal?.toUpperCase()}
                </span>
                <span className="signal-symbol">{symbol?.replace(".BK","")}</span>
                <span className="signal-price">฿{currentPrice?.toLocaleString()}</span>
              </div>
              <div className="signal-reason">{signal.reason}</div>
              {(signal.suggestedStop || signal.suggestedTP) && (
                <div className="signal-levels">
                  {signal.suggestedStop && <span className="sl-level">SL: ฿{signal.suggestedStop?.toLocaleString()}</span>}
                  {signal.suggestedTP   && <span className="tp-level">TP: ฿{signal.suggestedTP?.toLocaleString()}</span>}
                </div>
              )}

              {/* ── Approaching Alert ── */}
              {signal.approaching && supportsApproaching && (
                <div className="approaching-alert">
                  <div className="approaching-title">⚠️ {signal.approachingReason}</div>
                  <div className="approaching-eta">ETA: {signal.approachingEta}</div>
                  {!armed ? (
                    <button
                      className="arm-btn"
                      onClick={() => armStrategy(signal.suggestedStop ? "buy" : "sell")}
                    >
                      🎯 Arm It — fire when condition hits
                    </button>
                  ) : (
                    <div className="armed-state">
                      <span>🎯 ARMED — will {autoExecute ? "auto-execute" : "prompt you"} when signal fires</span>
                      <button className="disarm-btn" onClick={disarm}>Disarm</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeStrategy && !signal && (
            <div className="signal-waiting">⏳ Watching {symbol?.replace(".BK","")} for signals...</div>
          )}
          {!activeStrategy && (
            <div className="signal-waiting">Select a strategy above to start monitoring.</div>
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
                    <div>Strategy: <strong>{activePreset?.name}</strong></div>
                    <div>Qty: <strong>{pendingTrade.qty} {market === "gold" ? "baht-weight" : "shares"}</strong></div>
                    <div>Entry: <strong>฿{currentPrice?.toLocaleString()}</strong></div>
                    {pendingTrade.signal.suggestedStop && <div>Stop Loss: <strong>฿{pendingTrade.signal.suggestedStop?.toLocaleString()}</strong></div>}
                    {pendingTrade.signal.suggestedTP   && <div>Take Profit: <strong>฿{pendingTrade.signal.suggestedTP?.toLocaleString()}</strong></div>}
                    <div className="confirm-cost">Est. cost: ฿{(pendingTrade.qty * currentPrice)?.toLocaleString("en-US",{maximumFractionDigits:0})}</div>
                  </>
                )}
                {pendingTrade.type === "sell" && (
                  <div>Close {symbol?.replace(".BK","")} @ ฿{currentPrice?.toLocaleString()}</div>
                )}
              </div>
              <div className="confirm-actions">
                <button className="confirm-btn confirm-yes" onClick={handleConfirm}>✓ Execute</button>
                <button className="confirm-btn confirm-no"  onClick={handleDismiss}>✗ Dismiss</button>
              </div>
            </div>
          )}

          {/* ── Notification Toast ── */}
          {notification && (
            <div className={`strategy-notification ${notification.type}`}>{notification.text}</div>
          )}

        </div>
      )}
    </div>
  );
}
