/**
 * OrderPanel.jsx
 * Phase 4 patch: `mode` (manual|ai) lifted to parent so StrategyPanel
 * can be hidden when AI tab is active. Parent passes orderMode + onOrderModeChange.
 */

import { useState, useEffect } from "react";
import Tooltip, { TooltipIcon } from "./Tooltip.jsx";
import { suggestPositionSize, getRiskLabel, calcPortfolioSummary } from "../core/portfolio-engine.js";

export default function OrderPanel({
  market, currentPrice, portfolio,
  onBuy, onSell, marketOpen, enforceHours, onAIStrategy,
  // Phase 4: mode lifted to parent
  orderMode, onOrderModeChange,
}) {
  const [side, setSide]             = useState("buy");
  const [qty, setQty]               = useState("");
  const [price, setPrice]           = useState("");
  const [stopLoss, setStopLoss]     = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [aiPrompt, setAiPrompt]     = useState("");
  const [aiResponse, setAiResponse] = useState(null);
  const [aiLoading, setAiLoading]   = useState(false);
  const [riskLevel, setRiskLevel]   = useState("medium");
  const [error, setError]           = useState(null);
  const [warning, setWarning]       = useState(null);

  useEffect(() => {
    if (currentPrice) setPrice(currentPrice.toFixed(2));
  }, [currentPrice]);

  const summary   = calcPortfolioSummary(portfolio);
  const tradeCost = (parseFloat(qty) || 0) * (parseFloat(price) || 0);
  const riskLabel = tradeCost > 0 ? getRiskLabel(tradeCost, portfolio.startingBalance) : null;

  const simMode     = !enforceHours;
  const canTrade    = simMode || marketOpen;
  const statusLabel = simMode ? "⚡ SIM MODE — Trading 24/7 with live prices"
    : marketOpen ? "● MARKET OPEN" : "● MARKET CLOSED";
  const statusClass = simMode ? "sim" : marketOpen ? "open" : "closed";
  const closedHint  = market === "gold"
    ? "Gold market closed on weekends. Turn off Market Hours to trade in sim mode."
    : "SET market hours: 10:00–12:30 and 14:30–17:00 ICT (Mon–Fri).";

  function handleSuggestSize() {
    const suggested = suggestPositionSize(portfolio.balance, parseFloat(price), parseFloat(stopLoss), riskLevel, market);
    setQty(suggested.toString());
  }

  function handleSubmit() {
    setError(null); setWarning(null);
    if (!qty || !price) { setError("Please enter quantity and price."); return; }
    if (!canTrade) { setError(closedHint); return; }
    if (side === "buy") {
      const result = onBuy({ symbol: market === "gold" ? "THAI_GOLD_BAHT" : "SELECTED_STOCK", market, qty: parseFloat(qty), price: parseFloat(price), stopLoss: parseFloat(stopLoss) || null, takeProfit: parseFloat(takeProfit) || null, strategy: "manual", simMode });
      if (result?.error) { setError(`Order rejected: ${result.error}`); return; }
      if (result?.warning) setWarning(result.warning);
      setQty(""); setStopLoss(""); setTakeProfit("");
    } else {
      const result = onSell(null, parseFloat(price));
      if (result?.error) setError(result.error);
    }
  }

  async function handleAIAssist() {
    if (!aiPrompt.trim()) return;
    setAiLoading(true); setAiResponse(null);
    try {
      const result = await onAIStrategy({ prompt: aiPrompt, market, currentPrice, portfolio: summary });
      setAiResponse(result);
    } catch { setError("AI request failed. Worker not yet configured for Phase 4."); }
    finally { setAiLoading(false); }
  }

  const unitLabel = market === "gold" ? "baht-weight" : "shares";
  const minUnit   = market === "gold" ? 1 : 100;
  const mode      = orderMode || "manual";

  return (
    <div className="order-panel">

      {/* ── Tabs: Manual | AI Assist ── */}
      <div className="mode-selector">
        <Tooltip id="tooltip-strategy-manual">
          <button className={`mode-btn ${mode === "manual" ? "active" : ""}`} onClick={() => onOrderModeChange("manual")}>
            Manual
          </button>
        </Tooltip>
        <Tooltip id="tooltip-strategy-ai">
          <button className={`mode-btn ${mode === "ai" ? "active" : ""}`} onClick={() => onOrderModeChange("ai")}>
            ✦ AI Assist
          </button>
        </Tooltip>
      </div>

      {/* ── Buy / Sell (always visible) ── */}
      <div className="side-toggle">
        <Tooltip id="tooltip-order-buy">
          <button className={`side-btn buy ${side === "buy" ? "active" : ""}`} onClick={() => setSide("buy")}>▲ BUY</button>
        </Tooltip>
        <Tooltip id="tooltip-order-sell">
          <button className={`side-btn sell ${side === "sell" ? "active" : ""}`} onClick={() => setSide("sell")}>▼ SELL</button>
        </Tooltip>
      </div>

      {/* ── AI Assist Tab ── */}
      {mode === "ai" && (
        <div className="ai-panel">
          <div className="ai-phase4-badge">✦ Phase 4 — Coming Soon</div>
          <p className="ai-phase4-hint">
            Tell the AI your market view in plain language. It will analyse the chart,
            suggest entry/exit levels, and optionally execute the trade for you.
          </p>
          <label className="field-label">Your Market Thesis</label>
          <textarea
            className="field-input ai-prompt"
            rows={3}
            placeholder="e.g. Gold looks strong — USD weakening and Fed pause expected. What's your read?"
            value={aiPrompt}
            onChange={e => setAiPrompt(e.target.value)}
          />
          <button
            className="ai-submit-btn"
            onClick={handleAIAssist}
            disabled={aiLoading || !aiPrompt.trim()}
          >
            {aiLoading ? "Analysing..." : "✦ Get AI Recommendation"}
          </button>
          {aiResponse && (
            <div className="ai-response">
              <div className={`ai-sentiment ${aiResponse.sentiment}`}>{aiResponse.sentiment?.toUpperCase()} — {aiResponse.action}</div>
              <p className="ai-reasoning">{aiResponse.reasoning}</p>
              <div className="ai-trade-params">
                {aiResponse.suggestedEntry && <span>Entry: ฿{aiResponse.suggestedEntry}</span>}
                {aiResponse.suggestedStop  && <span>Stop: ฿{aiResponse.suggestedStop}</span>}
                {aiResponse.suggestedTP    && <span>Target: ฿{aiResponse.suggestedTP}</span>}
              </div>
              <button className="ai-apply-btn" onClick={() => {
                setPrice(aiResponse.suggestedEntry || price);
                setStopLoss(aiResponse.suggestedStop || "");
                setTakeProfit(aiResponse.suggestedTP || "");
                onOrderModeChange("manual");
              }}>
                Apply to Order →
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Manual Tab ── */}
      {mode === "manual" && (
        <>
          <div className="field-row">
            <label className="field-label">Price (THB)<TooltipIcon id="tooltip-order-price" /></label>
            <input type="number" className="field-input" value={price} onChange={e => setPrice(e.target.value)} placeholder={currentPrice?.toFixed(2)} step="0.01" />
          </div>

          <div className="field-row">
            <label className="field-label">Quantity ({unitLabel})<TooltipIcon id="tooltip-order-qty" /></label>
            <div className="qty-row">
              <input type="number" className="field-input" value={qty} onChange={e => setQty(e.target.value)} placeholder={`min ${minUnit}`} min={minUnit} step={minUnit} />
              <Tooltip id="tooltip-order-size-suggest">
                <button className="suggest-btn" onClick={handleSuggestSize}>Auto Size</button>
              </Tooltip>
            </div>
            <div className="risk-level-select">
              {["low","medium","high"].map(lvl => (
                <Tooltip key={lvl} id={`tooltip-risk-${lvl}`}>
                  <button className={`risk-btn ${riskLevel === lvl ? "active" : ""} ${lvl}`} onClick={() => setRiskLevel(lvl)}>{lvl}</button>
                </Tooltip>
              ))}
            </div>
          </div>

          <div className="field-row">
            <label className="field-label">Stop Loss<TooltipIcon id="tooltip-order-stoploss" /></label>
            <input type="number" className="field-input" value={stopLoss} onChange={e => setStopLoss(e.target.value)} placeholder="Optional — auto-closes if price falls here" step="0.01" />
          </div>

          <div className="field-row">
            <label className="field-label">Take Profit<TooltipIcon id="tooltip-order-takeprofit" /></label>
            <input type="number" className="field-input" value={takeProfit} onChange={e => setTakeProfit(e.target.value)} placeholder="Optional — auto-closes if price rises here" step="0.01" />
          </div>

          {tradeCost > 0 && (
            <div className="order-summary">
              <span>Est. Cost: <strong>฿{tradeCost.toLocaleString()}</strong></span>
              {riskLabel && (
                <span style={{ color: riskLabel === "low" ? "#22c55e" : riskLabel === "medium" ? "#f59e0b" : "#ef4444" }}>
                  Risk: {riskLabel.toUpperCase()}<TooltipIcon id={`tooltip-risk-${riskLabel}`} />
                </span>
              )}
            </div>
          )}

          {(() => {
            const q = parseFloat(qty)||0, p = parseFloat(price)||0, sl = parseFloat(stopLoss)||0, tp = parseFloat(takeProfit)||0;
            if (!q || !p) return null;
            const maxLoss = sl > 0 ? ((sl-p)*q).toFixed(0) : null;
            const maxGain = tp > 0 ? ((tp-p)*q).toFixed(0) : null;
            if (!maxLoss && !maxGain) return null;
            return (
              <div className="pnl-helper">
                <span className="pnl-helper-title">P&L at targets</span>
                {maxLoss !== null && <span className="pnl-loss">Max loss: ฿{parseInt(maxLoss).toLocaleString()}{sl > 0 && <span className="pnl-sub"> if hits ฿{sl.toLocaleString()}</span>}</span>}
                {maxGain !== null && <span className="pnl-gain">Max gain: +฿{parseInt(maxGain).toLocaleString()}{tp > 0 && <span className="pnl-sub"> if hits ฿{tp.toLocaleString()}</span>}</span>}
              </div>
            );
          })()}

          {error   && <div className="order-error">⚠ {error}</div>}
          {warning && <div className="order-warning">⚡ {warning}</div>}

          <div className={`market-status ${statusClass}`}>
            <span>{statusLabel}</span>
            {simMode && <span className="sim-mode-note">Market Hours OFF — prices are live but hours not enforced</span>}
            {!simMode && !marketOpen && <span className="sim-mode-note">{closedHint}</span>}
          </div>

          <button className={`submit-btn ${side}`} onClick={handleSubmit} disabled={!canTrade}>
            {!canTrade ? "⊘ MARKET CLOSED" : side === "buy" ? `▲ ${simMode?"[SIM] ":""}PLACE BUY ORDER` : `▼ ${simMode?"[SIM] ":""}CLOSE POSITION`}
          </button>
        </>
      )}
    </div>
  );
}
