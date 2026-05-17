/**
 * StrategyPanel.jsx
 * Phase 4 patch — Revised execution model:
 *
 * AUTO EXECUTE ON  = strategy watches + shows confirm card for every signal
 *                    (with beep pattern and 60s countdown before auto-dismiss)
 * AUTO EXECUTE OFF = strategy watches + approaching alert only, arm required to surface card
 *
 * Tier logic (affects beep + card color, NOT whether card appears):
 *   Small  < 5%  → 1 beep,  green card
 *   Medium 5–20% → 3 beeps, yellow-orange card  "LARGE TRADE"
 *   Large  > 20% → 2 low beeps, orange-red card "OVERSIZED — needs approval"
 *   (no tier is silently auto-fired — user always approves)
 *
 * Fixed: strategy name always shows preset name, never "preset" or blank
 * Fixed: armed state shows correct tooltip
 * Updated: tactic rules updated to match new model
 */

import { useState, useEffect, useRef } from "react";
import { runStrategy, getExecutionTier } from "../injectors/strategy-injector.js";
import { suggestPositionSize } from "../core/portfolio-engine.js";
import Tooltip, { TooltipIcon } from "./Tooltip.jsx";
import config from "../../config.js";

const PRESETS        = config.strategies.presets;
const DISARM_MS      = 5 * 60 * 1000; // 5 minutes
const CARD_TIMEOUT   = 60;             // seconds before confirm card auto-dismisses

// Strategies that support approaching alert
const APPROACHING_SUPPORTED = new Set(["ma_crossover", "golden_cross", "support_bounce"]);

// Updated tactic rules to match new model
const TACTIC_RULES = [
  { icon: "🤖", text: "Auto Execute ON = strategy watches and shows you a confirm card every time a signal fires. You always approve." },
  { icon: "🔕", text: "Auto Execute OFF = strategy watches silently. You get approaching alerts only. Use Arm It to allow a card to appear on next signal." },
  { icon: "🔔", text: "Beep pattern: 1 beep = small trade (<5%), 3 beeps = large trade (5–20%), 2 low beeps = oversized trade (>20%)." },
  { icon: "⏱",  text: "Confirm cards auto-dismiss after 60 seconds if you don't respond." },
  { icon: "🎯", text: "Arm It = pre-authorize the next signal when Auto Execute is OFF. Card appears once when condition hits, then disarms." },
  { icon: "⏱",  text: "Armed state auto-disarms after 5 minutes if no signal fires." },
  { icon: "📏", text: "Gold minimum: 1 baht-weight. SET minimum: 100 shares. No fractional units." },
];

// ── Beep function (AudioContext, no library) ──────────────────────────────────
function beep(pattern = "small") {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const configs = {
      small:    [{ freq: 880, dur: 0.12, vol: 0.3, delay: 0 }],
      large:    [
        { freq: 660, dur: 0.15, vol: 0.6, delay: 0 },
        { freq: 660, dur: 0.15, vol: 0.6, delay: 0.25 },
        { freq: 660, dur: 0.15, vol: 0.6, delay: 0.50 },
      ],
      blocked:  [
        { freq: 220, dur: 0.25, vol: 0.5, delay: 0 },
        { freq: 180, dur: 0.25, vol: 0.5, delay: 0.35 },
      ],
    };
    const tones = configs[pattern] || configs.small;
    tones.forEach(({ freq, dur, vol, delay }) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.setValueAtTime(vol, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + dur);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + dur + 0.05);
    });
  } catch {
    // AudioContext not available — silent fail
  }
}

function getTier(tradeValue, balance) {
  return getExecutionTier(tradeValue, balance);
}

function tierBeep(tier) {
  if (tier === "auto")    beep("small");
  else if (tier === "confirm") beep("large");
  else if (tier === "block")   beep("blocked");
}

function tierCardClass(tier) {
  if (tier === "auto")    return "confirm-buy";        // green
  if (tier === "confirm") return "confirm-large";      // yellow-orange
  if (tier === "block")   return "confirm-oversized";  // orange-red
  return "confirm-buy";
}

function tierLabel(tier) {
  if (tier === "confirm") return "⚠️ LARGE TRADE";
  if (tier === "block")   return "🚨 OVERSIZED — Your approval needed";
  return null;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function StrategyPanel({
  market,
  priceHistory,
  currentPrice,
  portfolio,
  activeStrategy,
  onStrategyChange,
  onExecuteBuy,
  onExecuteSell,
  onStrategyEvent,
  symbol,
}) {
  const [signal,        setSignal]        = useState(null);
  const [pendingTrade,  setPendingTrade]  = useState(null);
  const [lastSignalId,  setLastSignalId]  = useState(null);
  const [notification,  setNotification]  = useState(null);
  const [isExpanded,    setIsExpanded]    = useState(true);
  const [tacticOpen,    setTacticOpen]    = useState(false);
  const [autoExecute,   setAutoExecute]   = useState(false);
  const [armed,         setArmed]         = useState(false);
  const [armedAt,       setArmedAt]       = useState(null);
  const [cardCountdown, setCardCountdown] = useState(null); // seconds remaining on confirm card

  const disarmTimerRef  = useRef(null);
  const cardTimerRef    = useRef(null);
  const cardIntervalRef = useRef(null);

  // ── Run strategy on every price tick ───────────────────────────────────────
  useEffect(() => {
    if (!activeStrategy || !currentPrice || !priceHistory?.length) {
      setSignal(null);
      return;
    }

    const result = runStrategy({ priceHistory, currentPrice, strategyId: activeStrategy, portfolio, market });
    setSignal(result);

    if (!result) return;

    const isActionable = result.signal === "buy" || result.signal === "sell";
    if (!isActionable) return;

    const sigId = `${result.signal}-${Math.round(currentPrice)}`;
    if (sigId === lastSignalId) return; // already handled this signal

    // ── Auto Execute ON → always surface card ──────────────────────────────
    if (autoExecute) {
      setLastSignalId(sigId);
      const qty        = suggestPositionSize(portfolio?.balance || 0, currentPrice, result.suggestedStop, "medium", market);
      const tradeValue = qty * currentPrice;
      const tier       = getTier(tradeValue, portfolio?.balance);
      tierBeep(tier);
      stageCard(result, qty, tier);
      return;
    }

    // ── Auto Execute OFF → only surface card if armed ──────────────────────
    if (armed) {
      setLastSignalId(sigId);
      const qty        = suggestPositionSize(portfolio?.balance || 0, currentPrice, result.suggestedStop, "medium", market);
      const tradeValue = qty * currentPrice;
      const tier       = getTier(tradeValue, portfolio?.balance);
      tierBeep(tier);
      stageCard(result, qty, tier);
      disarm();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPrice, activeStrategy, priceHistory, armed, autoExecute]);

  // ── Stage confirm card with 60s countdown ─────────────────────────────────
  function stageCard(result, qty, tier) {
    clearCardTimers();

    if (result.signal === "buy") {
      setPendingTrade({ type: "buy", qty, signal: result, tier });
    } else if (result.signal === "sell") {
      const position = portfolio?.positions?.find(p => p.symbol === symbol && p.market === market);
      if (!position) return;
      setPendingTrade({ type: "sell", positionId: position.id, qty: position.qty, signal: result, tier });
    }

    // Countdown display
    setCardCountdown(CARD_TIMEOUT);
    cardIntervalRef.current = setInterval(() => {
      setCardCountdown(prev => {
        if (prev <= 1) { clearCardTimers(); return null; }
        return prev - 1;
      });
    }, 1000);

    // Auto-dismiss after 60s
    cardTimerRef.current = setTimeout(() => {
      setPendingTrade(null);
      setCardCountdown(null);
      const stratName = PRESETS.find(p => p.id === activeStrategy)?.name || activeStrategy || "Strategy";
      showNotification(`⏱ Card timed out — signal dismissed (${stratName})`, "info");
      onStrategyEvent?.({
        type: "signal_timeout",
        market,
        message: `⏱ Card timed out — ${result.signal?.toUpperCase()} signal dismissed`,
        strategy: stratName,
      });
    }, CARD_TIMEOUT * 1000);
  }

  function clearCardTimers() {
    if (cardTimerRef.current)    clearTimeout(cardTimerRef.current);
    if (cardIntervalRef.current) clearInterval(cardIntervalRef.current);
    cardTimerRef.current    = null;
    cardIntervalRef.current = null;
  }

  // ── Arm / Disarm ──────────────────────────────────────────────────────────
  function armStrategy() {
    setArmed(true);
    setArmedAt(Date.now());
    showNotification("🎯 Armed — confirm card will appear on next signal (5 min timeout)", "info");
    if (disarmTimerRef.current) clearTimeout(disarmTimerRef.current);
    disarmTimerRef.current = setTimeout(() => {
      disarm();
      showNotification("⏱ Armed state expired — no signal within 5 minutes.", "info");
    }, DISARM_MS);
  }

  function disarm() {
    setArmed(false);
    setArmedAt(null);
    if (disarmTimerRef.current) clearTimeout(disarmTimerRef.current);
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  function fireExecution(pendingTrade) {
    const stratName = PRESETS.find(p => p.id === activeStrategy)?.name || activeStrategy || "Manual";
    const { signal: result, qty, tier } = pendingTrade;

    if (pendingTrade.type === "buy") {
      onExecuteBuy({
        symbol,
        market,
        qty,
        price:      currentPrice,
        stopLoss:   result.suggestedStop,
        takeProfit: result.suggestedTP,
        strategy:   stratName,
      });
      const sizeLabel = tier === "confirm" ? "LARGE " : tier === "block" ? "OVERSIZED " : "";
      const logMsg = `✅ ${sizeLabel}AUTO BUY — ${qty} × ${symbol?.replace(".BK","")} @ ฿${currentPrice?.toLocaleString()} (${stratName})`;
      showNotification(logMsg, "success");
      onStrategyEvent?.({ type: "buy", market, message: logMsg, strategy: stratName });
    } else if (pendingTrade.type === "sell") {
      const position = portfolio?.positions?.find(p => p.symbol === symbol && p.market === market);
      if (position) {
        onExecuteSell(position.id, currentPrice);
        const logMsg = `✅ AUTO SELL — closed ${symbol?.replace(".BK","")} @ ฿${currentPrice?.toLocaleString()} (${stratName})`;
        showNotification(logMsg, "success");
        onStrategyEvent?.({ type: "sell", market, message: logMsg, strategy: stratName });
      }
    }

    clearCardTimers();
    setPendingTrade(null);
    setCardCountdown(null);
  }

  function handleConfirm() {
    if (!pendingTrade) return;
    fireExecution(pendingTrade);
  }

  function handleDismiss() {
    clearCardTimers();
    setPendingTrade(null);
    setCardCountdown(null);
    showNotification("Signal dismissed.", "info");
  }

  function showNotification(text, type) {
    setNotification({ text, type });
    setTimeout(() => setNotification(null), 6000);
  }

  // ── Armed countdown display ───────────────────────────────────────────────
  const [armedCountdown, setArmedCountdown] = useState(null);
  useEffect(() => {
    if (!armed || !armedAt) { setArmedCountdown(null); return; }
    const interval = setInterval(() => {
      const remaining = DISARM_MS - (Date.now() - armedAt);
      if (remaining <= 0) { setArmedCountdown(null); clearInterval(interval); return; }
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      setArmedCountdown(`${mins}:${String(secs).padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(interval);
  }, [armed, armedAt]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      clearCardTimers();
      if (disarmTimerRef.current) clearTimeout(disarmTimerRef.current);
    };
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const activePreset        = PRESETS.find(p => p.id === activeStrategy);
  const signalColor         = { buy: "#22c55e", sell: "#ef4444", hold: "#f59e0b" }[signal?.signal] || "#6b7280";
  const signalIcon          = { buy: "▲", sell: "▼", hold: "◆" }[signal?.signal] || "—";
  const supportsApproaching = APPROACHING_SUPPORTED.has(activeStrategy);

  return (
    <div className="strategy-panel">

      {/* ── Header ── */}
      <div className="strategy-header" onClick={() => setIsExpanded(e => !e)}>
        <span className="strategy-title">
          🤖 Auto-Strategy
          <TooltipIcon content="Select a preset strategy. Auto Execute ON = confirm card appears on every signal. OFF = alerts only, use Arm It to allow one card." />
          {armed && <span className="armed-badge">🎯 ARMED {armedCountdown}</span>}
          {autoExecute && !armed && <span className="armed-badge" style={{ background: "rgba(96,165,250,0.15)", borderColor: "#60a5fa", color: "#60a5fa" }}>▶ WATCHING</span>}
        </span>
        <span className="strategy-toggle-btn">{isExpanded ? "▲" : "▼"}</span>
      </div>

      {isExpanded && (
        <div className="strategy-body">

          {/* ── Tactic Rules ── */}
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
              <TooltipIcon content="ON = confirm card appears automatically on every signal. OFF = silent watch only — use Arm It to surface a card on next signal." />
            </span>
            <button
              className={`auto-toggle-btn ${autoExecute ? "on" : "off"}`}
              onClick={() => { setAutoExecute(v => !v); setPendingTrade(null); clearCardTimers(); setCardCountdown(null); }}
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
                onClick={() => { onStrategyChange(null); setSignal(null); setPendingTrade(null); clearCardTimers(); setCardCountdown(null); disarm(); }}
              >
                Off
              </button>
              {PRESETS.map(preset => (
                <button
                  key={preset.id}
                  className={`strategy-opt ${activeStrategy === preset.id ? "active" : ""}`}
                  onClick={() => { onStrategyChange(preset.id); setPendingTrade(null); clearCardTimers(); setCardCountdown(null); disarm(); }}
                  title={preset.description}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </div>

          {/* ── Strategy description ── */}
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
                <span className="signal-symbol">{symbol?.replace(".BK", "")}</span>
                <span className="signal-price">฿{currentPrice?.toLocaleString()}</span>
              </div>
              <div className="signal-reason">{signal.reason}</div>
              {(signal.suggestedStop || signal.suggestedTP) && (
                <div className="signal-levels">
                  {signal.suggestedStop && <span className="sl-level">SL: ฿{signal.suggestedStop?.toLocaleString()}</span>}
                  {signal.suggestedTP   && <span className="tp-level">TP: ฿{signal.suggestedTP?.toLocaleString()}</span>}
                </div>
              )}

              {/* ── Approaching Alert (Auto Execute OFF only) ── */}
              {!autoExecute && signal.approaching && supportsApproaching && (
                <div className="approaching-alert">
                  <div className="approaching-title">⚠️ {signal.approachingReason}</div>
                  <div className="approaching-eta">ETA: {signal.approachingEta}</div>
                  {!armed ? (
                    <button className="arm-btn" onClick={armStrategy}>
                      🎯 Arm It — show card when signal hits
                    </button>
                  ) : (
                    <div className="armed-state">
                      <span>🎯 ARMED — confirm card will appear when signal fires</span>
                      <button className="disarm-btn" onClick={disarm}>Disarm</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeStrategy && !signal && (
            <div className="signal-waiting">⏳ Watching {symbol?.replace(".BK", "")} for signals...</div>
          )}
          {!activeStrategy && (
            <div className="signal-waiting">Select a strategy above to start monitoring.</div>
          )}

          {/* ── Confirm Card ── */}
          {pendingTrade && (
            <div className={`trade-confirm ${tierCardClass(pendingTrade.tier)}`}>

              {/* Tier warning label */}
              {tierLabel(pendingTrade.tier) && (
                <div className="confirm-tier-label">{tierLabel(pendingTrade.tier)}</div>
              )}

              <div className="confirm-title">
                {pendingTrade.type === "buy" ? "📈 BUY Signal" : "📉 SELL Signal"} — Confirm?
              </div>

              <div className="confirm-details">
                <div>Strategy: <strong>{activePreset?.name || activeStrategy}</strong></div>
                {pendingTrade.type === "buy" && (
                  <>
                    <div>Qty: <strong>{pendingTrade.qty} {market === "gold" ? "baht-weight" : "shares"}</strong></div>
                    <div>Entry: <strong>฿{currentPrice?.toLocaleString()}</strong></div>
                    {pendingTrade.signal.suggestedStop && <div>Stop Loss: <strong>฿{pendingTrade.signal.suggestedStop?.toLocaleString()}</strong></div>}
                    {pendingTrade.signal.suggestedTP   && <div>Take Profit: <strong>฿{pendingTrade.signal.suggestedTP?.toLocaleString()}</strong></div>}
                    <div className="confirm-cost">
                      Est. cost: ฿{(pendingTrade.qty * currentPrice)?.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                      {portfolio?.balance > 0 && (
                        <span style={{ color: "var(--text-muted)", fontWeight: 400, fontSize: "10px", marginLeft: "8px" }}>
                          ({((pendingTrade.qty * currentPrice / portfolio.balance) * 100).toFixed(1)}% of balance)
                        </span>
                      )}
                    </div>
                  </>
                )}
                {pendingTrade.type === "sell" && (
                  <div>Close {symbol?.replace(".BK", "")} @ ฿{currentPrice?.toLocaleString()}</div>
                )}
              </div>

              {/* Countdown bar */}
              {cardCountdown !== null && (
                <div className="confirm-countdown">
                  <div className="confirm-countdown-bar" style={{ width: `${(cardCountdown / CARD_TIMEOUT) * 100}%` }} />
                  <span className="confirm-countdown-text">Auto-dismisses in {cardCountdown}s</span>
                </div>
              )}

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
