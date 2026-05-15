/**
 * OrderPanel.jsx
 * Buy/sell order entry with manual, preset, and AI strategy modes.
 * Props:
 *   market: "gold" | "set"
 *   currentPrice: number
 *   portfolio: object (from portfolio-engine)
 *   onBuy: (order) => void
 *   onSell: (positionId, price) => void
 *   marketOpen: boolean
 */

import { useState, useEffect } from "react";
import Tooltip, { TooltipIcon } from "./Tooltip.jsx";
import { suggestPositionSize, getRiskLabel, calcPortfolioSummary } from "../core/portfolio-engine.js";
import config from "../../config.js";

const PRESET_STRATEGIES = config.strategies.presets;

export default function OrderPanel({
  market,
  currentPrice,
  portfolio,
  onBuy,
  onSell,
  marketOpen,
  onAIStrategy,
}) {
  const [mode, setMode] = useState("manual");         // "manual" | "preset" | "ai"
  const [side, setSide] = useState("buy");             // "buy" | "sell"
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [selectedPreset, setSelectedPreset] = useState(PRESET_STRATEGIES[0].id);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiResponse, setAiResponse] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [riskLevel, setRiskLevel] = useState("medium");
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState(null);

  // Sync price field with live price on mount
  useEffect(() => {
    if (currentPrice) setPrice(currentPrice.toFixed(2));
  }, [currentPrice]);

  const summary = calcPortfolioSummary(portfolio);
  const tradeCost = (parseFloat(qty) || 0) * (parseFloat(price) || 0);
  const riskLabel = tradeCost > 0 ? getRiskLabel(tradeCost, portfolio.startingBalance) : null;

  const riskColors = {
    low:    "text-green-400",
    medium: "text-yellow-400",
    high:   "text-red-400",
  };

  function handleSuggestSize() {
    const suggested = suggestPositionSize(
      portfolio.balance,
      parseFloat(price),
      parseFloat(stopLoss),
      riskLevel,
      market
    );
    setQty(suggested.toString());
  }

  function handleSubmit() {
    setError(null);
    setWarning(null);

    if (!qty || !price) {
      setError("Please enter quantity and price.");
      return;
    }
    if (!marketOpen) {
      setError("Market is closed. Turn off market hours enforcement to trade in sim mode.");
      return;
    }

    if (side === "buy") {
      onBuy({
        symbol: market === "gold" ? "XAUUSD" : "SELECTED_STOCK", // injector sets real symbol
        market,
        qty: parseFloat(qty),
        price: parseFloat(price),
        stopLoss: parseFloat(stopLoss) || null,
        takeProfit: parseFloat(takeProfit) || null,
        strategy: mode,
      });
    } else {
      // Sell closes an open position — parent handles position selection
      onSell(null, parseFloat(price));
    }
  }

  async function handleAIAssist() {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    setAiResponse(null);
    try {
      const result = await onAIStrategy({
        prompt: aiPrompt,
        market,
        currentPrice,
        portfolio: summary,
      });
      setAiResponse(result);
    } catch (e) {
      setError("AI strategy request failed. Check your Worker deployment.");
    } finally {
      setAiLoading(false);
    }
  }

  const unitLabel = market === "gold" ? "baht-weight" : "shares";
  const minUnit   = market === "gold" ? 1 : 100;

  return (
    <div className="order-panel">
      {/* ── Strategy Mode Selector ── */}
      <div className="mode-selector">
        {[
          { key: "manual", label: "Manual",  tip: "tooltip-strategy-manual" },
          { key: "preset", label: "Preset",  tip: "tooltip-strategy-preset" },
          { key: "ai",     label: "AI Assist", tip: "tooltip-strategy-ai" },
        ].map(({ key, label, tip }) => (
          <Tooltip key={key} id={tip}>
            <button
              className={`mode-btn ${mode === key ? "active" : ""}`}
              onClick={() => setMode(key)}
            >
              {key === "ai" && "✦ "}{label}
            </button>
          </Tooltip>
        ))}
      </div>

      {/* ── Buy / Sell Toggle ── */}
      <div className="side-toggle">
        <Tooltip id="tooltip-order-buy">
          <button
            className={`side-btn buy ${side === "buy" ? "active" : ""}`}
            onClick={() => setSide("buy")}
          >
            ▲ BUY
          </button>
        </Tooltip>
        <Tooltip id="tooltip-order-sell">
          <button
            className={`side-btn sell ${side === "sell" ? "active" : ""}`}
            onClick={() => setSide("sell")}
          >
            ▼ SELL
          </button>
        </Tooltip>
      </div>

      {/* ── Preset Strategy Selector ── */}
      {mode === "preset" && (
        <div className="field-row">
          <label className="field-label">
            Strategy
            <TooltipIcon id={`tooltip-strategy-${selectedPreset.replace(/_/g, "-")}`} />
          </label>
          <select
            className="field-input"
            value={selectedPreset}
            onChange={e => setSelectedPreset(e.target.value)}
          >
            {PRESET_STRATEGIES.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <p className="field-hint">
            {PRESET_STRATEGIES.find(s => s.id === selectedPreset)?.description}
          </p>
        </div>
      )}

      {/* ── AI Prompt Panel ── */}
      {mode === "ai" && (
        <div className="ai-panel">
          <label className="field-label">Your Market Thesis</label>
          <textarea
            className="field-input ai-prompt"
            rows={3}
            placeholder="e.g. Gold looks strong with USD weakening and Fed pause expected. Looking to buy the dip around current levels..."
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
              <div className={`ai-sentiment ${aiResponse.sentiment}`}>
                {aiResponse.sentiment?.toUpperCase()} — {aiResponse.action}
              </div>
              <p className="ai-reasoning">{aiResponse.reasoning}</p>
              <div className="ai-trade-params">
                {aiResponse.suggestedEntry && <span>Entry: ฿{aiResponse.suggestedEntry}</span>}
                {aiResponse.suggestedStop  && <span>Stop: ฿{aiResponse.suggestedStop}</span>}
                {aiResponse.suggestedTP    && <span>Target: ฿{aiResponse.suggestedTP}</span>}
              </div>
              <button
                className="ai-apply-btn"
                onClick={() => {
                  setPrice(aiResponse.suggestedEntry || price);
                  setStopLoss(aiResponse.suggestedStop || "");
                  setTakeProfit(aiResponse.suggestedTP || "");
                  setMode("manual");
                }}
              >
                Apply to Order →
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Order Fields ── */}
      <div className="field-row">
        <label className="field-label">
          Price (THB)
          <TooltipIcon id="tooltip-order-price" />
        </label>
        <input
          type="number"
          className="field-input"
          value={price}
          onChange={e => setPrice(e.target.value)}
          placeholder={currentPrice?.toFixed(2)}
          step="0.01"
        />
      </div>

      <div className="field-row">
        <label className="field-label">
          Quantity ({unitLabel})
          <TooltipIcon id="tooltip-order-qty" />
        </label>
        <div className="qty-row">
          <input
            type="number"
            className="field-input"
            value={qty}
            onChange={e => setQty(e.target.value)}
            placeholder={`min ${minUnit}`}
            min={minUnit}
            step={minUnit}
          />
          <Tooltip id="tooltip-order-size-suggest">
            <button className="suggest-btn" onClick={handleSuggestSize}>Auto Size</button>
          </Tooltip>
        </div>
        <div className="risk-level-select">
          {["low", "medium", "high"].map(lvl => (
            <Tooltip key={lvl} id={`tooltip-risk-${lvl}`}>
              <button
                className={`risk-btn ${riskLevel === lvl ? "active" : ""} ${lvl}`}
                onClick={() => setRiskLevel(lvl)}
              >
                {lvl}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>

      <div className="field-row">
        <label className="field-label">
          Stop Loss
          <TooltipIcon id="tooltip-order-stoploss" />
        </label>
        <input
          type="number"
          className="field-input"
          value={stopLoss}
          onChange={e => setStopLoss(e.target.value)}
          placeholder="Optional — auto-closes if price falls here"
          step="0.01"
        />
      </div>

      <div className="field-row">
        <label className="field-label">
          Take Profit
          <TooltipIcon id="tooltip-order-takeprofit" />
        </label>
        <input
          type="number"
          className="field-input"
          value={takeProfit}
          onChange={e => setTakeProfit(e.target.value)}
          placeholder="Optional — auto-closes if price rises here"
          step="0.01"
        />
      </div>

      {/* ── Order Summary ── */}
      {tradeCost > 0 && (
        <div className="order-summary">
          <span>Est. Cost: <strong>฿{tradeCost.toLocaleString()}</strong></span>
          {riskLabel && (
            <span className={riskColors[riskLabel]}>
              Risk: {riskLabel.toUpperCase()}
              <TooltipIcon id={`tooltip-risk-${riskLabel}`} />
            </span>
          )}
        </div>
      )}

      {/* ── Errors / Warnings ── */}
      {error   && <div className="order-error">⚠ {error}</div>}
      {warning && <div className="order-warning">⚡ {warning}</div>}

      {/* ── Market Status Bar ── */}
      <div className={`market-status ${marketOpen ? "open" : "closed"}`}>
        <Tooltip id={`tooltip-market-${market}-${marketOpen ? "open" : "closed"}`}>
          <span>{marketOpen ? "● MARKET OPEN" : "● MARKET CLOSED"}</span>
        </Tooltip>
      </div>

      {/* ── Submit ── */}
      <button
        className={`submit-btn ${side}`}
        onClick={handleSubmit}
        disabled={!marketOpen && mode !== "ai"}
      >
        {side === "buy" ? "▲ PLACE BUY ORDER" : "▼ CLOSE POSITION"}
      </button>
    </div>
  );
}
