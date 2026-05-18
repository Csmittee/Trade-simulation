/**
 * OrderPanel.jsx
 * Phase 4 — AI Assist fully wired.
 * - Manual tab: unchanged
 * - AI tab:
 *     Top half  = chat (thesis input → AI analysis)
 *     Bottom half = workflow node panel (no more talk, just execute)
 *
 * Props unchanged from before. onAIStrategy called with:
 *   { prompt, market, symbol, currentPrice, portfolio, recentCloses }
 * Parent (GoldMarket/SetMarket) must pass recentCloses as prop.
 */

import { useState, useEffect, useRef } from "react";
import Tooltip, { TooltipIcon } from "./Tooltip.jsx";
import { suggestPositionSize, getRiskLabel, calcPortfolioSummary } from "../core/portfolio-engine.js";

const WORKER_BASE = "https://tts-workers.csmittee.workers.dev";

// ── Stage status helpers ──────────────────────────────────────────────────────
const STATUS = { PENDING: "pending", ACTIVE: "active", DONE_WIN: "win", DONE_LOSS: "loss", SKIPPED: "skipped" };

function stageStatusColor(status) {
  if (status === STATUS.ACTIVE)     return "var(--gold)";
  if (status === STATUS.DONE_WIN)   return "var(--green)";
  if (status === STATUS.DONE_LOSS)  return "var(--red)";
  if (status === STATUS.SKIPPED)    return "var(--text-muted)";
  return "var(--text-muted)";
}

function stageStatusIcon(status) {
  if (status === STATUS.ACTIVE)     return "●";
  if (status === STATUS.DONE_WIN)   return "✓";
  if (status === STATUS.DONE_LOSS)  return "✗";
  if (status === STATUS.SKIPPED)    return "—";
  return "○";
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function OrderPanel({
  market, currentPrice, portfolio,
  onBuy, onSell, marketOpen, enforceHours, onAIStrategy,
  orderMode, onOrderModeChange,
  recentCloses = [],   // last 10 closes passed from market page
  selectedSymbol = "", // e.g. "PTT.BK" or "THAI_GOLD_BAHT"
  onLogActivity,       // optional — logs to ActivityLog
}) {
  // Manual tab state
  const [side, setSide]             = useState("buy");
  const [qty, setQty]               = useState("");
  const [price, setPrice]           = useState("");
  const [stopLoss, setStopLoss]     = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [riskLevel, setRiskLevel]   = useState("medium");
  const [error, setError]           = useState(null);
  const [warning, setWarning]       = useState(null);

  // AI tab state
  const [aiPrompt, setAiPrompt]         = useState("");
  const [aiLoading, setAiLoading]       = useState(false);
  const [aiError, setAiError]           = useState(null);
  const [workflow, setWorkflow]         = useState(null);      // built workflow object
  const [chatCollapsed, setChatCollapsed] = useState(false);   // collapse chat after workflow built
  const [stageStatuses, setStageStatuses] = useState([]);      // per-stage status
  const [activeStageIdx, setActiveStageIdx] = useState(0);
  const [consecutiveRed, setConsecutiveRed] = useState(0);
  const [workflowDone, setWorkflowDone]     = useState(false);
  const [fallbackTriggered, setFallbackTriggered] = useState(false);
  const [stagePnl, setStagePnl]             = useState([]);    // actual ฿ result per stage (filled after done)
  const workflowRef = useRef(null);

  useEffect(() => {
    if (currentPrice) setPrice(currentPrice.toFixed(2));
  }, [currentPrice]);

  // Scroll workflow into view when it appears
  useEffect(() => {
    if (workflow && workflowRef.current) {
      setTimeout(() => workflowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 100);
    }
  }, [workflow]);

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

  const mode = orderMode || "manual";

  // ── Manual tab handlers ───────────────────────────────────────────────────
  function handleSuggestSize() {
    const suggested = suggestPositionSize(portfolio.balance, parseFloat(price), parseFloat(stopLoss), riskLevel, market);
    setQty(suggested.toString());
  }

  function handleSubmit() {
    setError(null); setWarning(null);
    if (!qty || !price) { setError("Please enter quantity and price."); return; }
    if (!canTrade) { setError(closedHint); return; }
   if (side === "buy") {
      const sym = market === "gold" ? "THAI_GOLD_BAHT" : (selectedSymbol || "SELECTED_STOCK");
      const p   = parseFloat(price);
      const q   = parseFloat(qty);
      const result = onBuy({ symbol: sym, market, qty: q, price: p, stopLoss: parseFloat(stopLoss) || null, takeProfit: parseFloat(takeProfit) || null, strategy: "manual", simMode });
      if (result?.error) { setError(`Order rejected: ${result.error}`); return; }
      if (result?.warning) setWarning(result.warning);
      onLogActivity?.({ type: "buy", market, symbol: sym, price: p, detail: `Manual buy × ${q} @ ฿${p?.toLocaleString()}` });
      setQty(""); setStopLoss(""); setTakeProfit("");
    } else {
      const p = parseFloat(price);
      const result = onSell(null, p);
      if (result?.error) { setError(result.error); return; }
      onLogActivity?.({ type: "sell", market, symbol: selectedSymbol || market, price: p, detail: `Manual sell @ ฿${p?.toLocaleString()}` });
    }
  }

  // ── AI tab handlers ───────────────────────────────────────────────────────
  async function handleAIAssist() {
    if (!aiPrompt.trim()) return;
    setAiLoading(true); setAiError(null); setWorkflow(null);
    setStageStatuses([]); setActiveStageIdx(0); setConsecutiveRed(0);
    setWorkflowDone(false); setFallbackTriggered(false); setStagePnl([]);

    try {
      const res = await fetch(`${WORKER_BASE}/api/strategy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt:        aiPrompt.trim(),
          market,
          symbol:        selectedSymbol || (market === "gold" ? "THAI_GOLD_BAHT" : ""),
          currentPrice,
          cashBalance:   portfolio.balance || 0,
          openPositions: (portfolio.positions || []).length,
          recentCloses:  recentCloses.slice(-10),
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Worker returned error");

      const wf = json.data;
      setWorkflow(wf);
      setStageStatuses(wf.stages.map((_, i) => (i === 0 ? STATUS.ACTIVE : STATUS.PENDING)));
      setStagePnl(wf.stages.map(() => null));
      setChatCollapsed(true);
      onLogActivity?.({ type: "info", market, message: `✦ AI Workflow built: "${wf.workflowName}" — ${wf.stages.length} stages` });
    } catch (err) {
      setAiError(err.message);
    } finally {
      setAiLoading(false);
    }
  }

  function resetWorkflow() {
    setWorkflow(null); setAiPrompt(""); setAiError(null);
    setStageStatuses([]); setActiveStageIdx(0); setConsecutiveRed(0);
    setWorkflowDone(false); setFallbackTriggered(false); setStagePnl([]);
    setChatCollapsed(false);
  }

  // Mark current stage as win or loss, advance to next
  function resolveStage(stageIdx, outcome /* "win" | "loss" | "skip" */) {
    const newStatuses = [...stageStatuses];
    const newPnl      = [...stagePnl];

    if (outcome === "win")  { newStatuses[stageIdx] = STATUS.DONE_WIN; }
    if (outcome === "loss") { newStatuses[stageIdx] = STATUS.DONE_LOSS; }
    if (outcome === "skip") { newStatuses[stageIdx] = STATUS.SKIPPED; }
    setStageStatuses(newStatuses);

    // Track consecutive red
    let newConsecRed = outcome === "loss" ? consecutiveRed + 1 : 0;
    setConsecutiveRed(newConsecRed);

    // Fallback rule check — 2 consecutive losses
    if (newConsecRed >= 2) {
      setFallbackTriggered(true);
      setWorkflowDone(true);
      onLogActivity?.({ type: "warn", market, message: `⛔ Workflow "${workflow?.workflowName}" — fallback triggered: 2 consecutive losses. Holding.` });
      return;
    }

    // Advance to next stage
    const nextIdx = stageIdx + 1;
    if (nextIdx >= newStatuses.length) {
      setWorkflowDone(true);
      onLogActivity?.({ type: "info", market, message: `✅ Workflow "${workflow?.workflowName}" complete — all ${newStatuses.length} stages done.` });
    } else {
      newStatuses[nextIdx] = STATUS.ACTIVE;
      setStageStatuses([...newStatuses]);
      setActiveStageIdx(nextIdx);
    }
  }

  // Execute the trade for a stage then let user mark outcome
  function executeStageAction(stage, stageIdx) {
    if (!canTrade) { setAiError(closedHint); return; }

    if (stage.action === "BUY" || stage.action === "SCALE IN") {
      const sym = market === "gold" ? "THAI_GOLD_BAHT" : (selectedSymbol || "SELECTED_STOCK");
      const entryPrice = workflow.suggestedEntry || currentPrice;
      const suggestedQty = market === "gold" ? 1 : 100;
      const result = onBuy({
        symbol: sym, market,
        qty: suggestedQty,
        price: entryPrice,
        stopLoss: workflow.suggestedStop || null,
        takeProfit: workflow.suggestedTP || null,
        strategy: workflow.workflowName,
        simMode,
      });
      if (result?.error) { setAiError(`Trade rejected: ${result.error}`); return; }
      onLogActivity?.({ type: "buy", market, message: `✦ [${workflow.workflowName}] Stage ${stageIdx + 1}: ${stage.action} executed at ฿${entryPrice?.toLocaleString()}` });

    } else if (stage.action === "SELL" || stage.action === "EXIT") {
      const result = onSell(null, workflow.suggestedTP || currentPrice);
      if (result?.error) { setAiError(`Trade rejected: ${result.error}`); return; }
      onLogActivity?.({ type: "sell", market, message: `✦ [${workflow.workflowName}] Stage ${stageIdx + 1}: ${stage.action} executed` });

    } else {
      // HOLD — no trade, just log
      onLogActivity?.({ type: "info", market, message: `✦ [${workflow.workflowName}] Stage ${stageIdx + 1}: HOLD — no trade placed` });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="order-panel">

      {/* ── Tabs: Manual | AI Assist ── */}
      <div className="mode-selector">
        <button className={`mode-btn ${mode === "manual" ? "active" : ""}`} onClick={() => onOrderModeChange("manual")}>
          Manual
        </button>
        <button className={`mode-btn ${mode === "ai" ? "active" : ""}`} onClick={() => onOrderModeChange("ai")}>
          ✦ AI Assist
        </button>
      </div>

      {/* ── Buy / Sell toggle (always visible) ── */}
      <div className="side-toggle">
        <button className={`side-btn buy ${side === "buy" ? "active" : ""}`} onClick={() => setSide("buy")}>▲ BUY</button>
        <button className={`side-btn sell ${side === "sell" ? "active" : ""}`} onClick={() => setSide("sell")}>▼ SELL</button>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          AI ASSIST TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {mode === "ai" && (
        <div className="ai-panel">

          {/* ── CHAT SECTION (collapsible after workflow built) ── */}
          <div className="ai-chat-section">
            <div
              className="ai-chat-header"
              onClick={() => workflow && setChatCollapsed(c => !c)}
              style={{ cursor: workflow ? "pointer" : "default" }}
            >
              <span className="ai-chat-title">✦ AI Strategy Builder</span>
              {workflow && (
                <span className="ai-chat-collapse-hint">{chatCollapsed ? "▶ expand" : "▼ collapse"}</span>
              )}
            </div>

            {!chatCollapsed && (
              <div className="ai-chat-body">
                <p className="ai-chat-hint">
                  Describe your market view. The AI will search current news, assess your thesis,
                  and build a time-bound workflow you execute with one click.
                </p>

                <label className="field-label">Your Market Thesis</label>
                <textarea
                  className="field-input ai-prompt"
                  rows={3}
                  placeholder={market === "gold"
                    ? "e.g. Gold looks strong — USD weakening and Fed pause expected tonight. Build me a scalp plan for today."
                    : "e.g. PTT is near support. Oil recovered this week. Give me a session bounce tactic for today."}
                  value={aiPrompt}
                  onChange={e => setAiPrompt(e.target.value)}
                  disabled={aiLoading}
                />

                {aiError && <div className="order-error">⚠ {aiError}</div>}

                <button
                  className="ai-submit-btn"
                  onClick={handleAIAssist}
                  disabled={aiLoading || !aiPrompt.trim()}
                >
                  {aiLoading ? (
                    <span className="ai-loading-row">
                      <span className="ai-loading-dot" />
                      Analysing market + building workflow…
                    </span>
                  ) : "✦ Build Workflow"}
                </button>

                {workflow && (
                  <button className="ai-reset-btn" onClick={resetWorkflow}>
                    ↩ New Strategy
                  </button>
                )}
              </div>
            )}
          </div>

          {/* ── WORKFLOW NODE PANEL (appears after AI responds) ── */}
          {workflow && (
            <div className="ai-workflow-panel" ref={workflowRef}>

              {/* ── Workflow header ── */}
              <div className="wf-header">
                <div className="wf-name">{workflow.workflowName}</div>
                <div className={`wf-sentiment ${workflow.sentiment}`}>
                  {workflow.sentiment === "bullish" ? "▲" : workflow.sentiment === "bearish" ? "▼" : "◆"} {workflow.sentiment?.toUpperCase()}
                  <span className="wf-confidence">· {workflow.confidence} confidence</span>
                </div>
              </div>

              {/* ── AI reasoning (compact) ── */}
              <div className="wf-reasoning">{workflow.reasoning}</div>

              {/* ── Key prices ── */}
              <div className="wf-prices">
                {workflow.suggestedEntry && (
                  <span className="wf-price-tag entry">Entry ฿{workflow.suggestedEntry?.toLocaleString()}</span>
                )}
                {workflow.suggestedStop && (
                  <span className="wf-price-tag stop">Stop ฿{workflow.suggestedStop?.toLocaleString()}</span>
                )}
                {workflow.suggestedTP && (
                  <span className="wf-price-tag tp">Target ฿{workflow.suggestedTP?.toLocaleString()}</span>
                )}
              </div>

              {/* ── Fallback rule ── */}
              <div className="wf-fallback">
                ⚠ Fallback: {workflow.fallbackRule}
              </div>

              {/* ── Fallback triggered banner ── */}
              {fallbackTriggered && (
                <div className="wf-fallback-triggered">
                  ⛔ FALLBACK TRIGGERED — 2 consecutive losses. Workflow halted. Holding position.
                </div>
              )}

              {/* ── Workflow done banner ── */}
              {workflowDone && !fallbackTriggered && (
                <div className="wf-done-banner">
                  ✅ Workflow complete — all stages done.
                </div>
              )}

              {/* ── Stage nodes ── */}
              <div className="wf-stages">
                {workflow.stages.map((stage, idx) => {
                  const status   = stageStatuses[idx] || STATUS.PENDING;
                  const isActive = status === STATUS.ACTIVE;
                  const isDone   = status === STATUS.DONE_WIN || status === STATUS.DONE_LOSS || status === STATUS.SKIPPED;

                  return (
                    <div
                      key={stage.id}
                      className={`wf-stage ${status} ${isActive ? "wf-stage-active" : ""}`}
                    >
                      {/* Stage connector line */}
                      {idx > 0 && (
                        <div className="wf-connector">
                          <div className="wf-connector-line" style={{
                            background: stageStatuses[idx - 1] === STATUS.DONE_WIN ? "var(--green)"
                              : stageStatuses[idx - 1] === STATUS.DONE_LOSS ? "var(--red)"
                              : "var(--border)"
                          }} />
                        </div>
                      )}

                      <div className="wf-stage-card">
                        {/* Stage number + status icon */}
                        <div className="wf-stage-left">
                          <div
                            className="wf-stage-dot"
                            style={{
                              background: isActive ? "var(--gold)" : stageStatusColor(status),
                              boxShadow: isActive ? "0 0 8px var(--gold)" : "none",
                              animation: isActive ? "pulse 1.5s ease-in-out infinite" : "none",
                            }}
                          >
                            {stageStatusIcon(status)}
                          </div>
                          <div className="wf-stage-num">S{stage.id}</div>
                        </div>

                        {/* Stage content */}
                        <div className="wf-stage-content">
                          <div className="wf-stage-top">
                            <span className="wf-stage-label">{stage.label}</span>
                            <span className={`wf-stage-action action-${stage.action.toLowerCase().replace(" ", "-")}`}>
                              {stage.action}
                            </span>
                          </div>

                          <div className="wf-stage-meta">
                            <span className="wf-stage-time">🕐 {stage.timeWindow}</span>
                            <span className={`wf-stage-pnl ${stage.targetPnl?.startsWith("+") ? "positive" : "negative"}`}>
                              {stage.targetPnl}
                            </span>
                          </div>

                          {stage.note && (
                            <div className="wf-stage-note">{stage.note}</div>
                          )}

                          {/* Actual P&L if done */}
                          {stagePnl[idx] !== null && isDone && (
                            <div className={`wf-stage-actual-pnl ${stagePnl[idx] >= 0 ? "positive" : "negative"}`}>
                              Actual: {stagePnl[idx] >= 0 ? "+" : ""}฿{stagePnl[idx]}
                            </div>
                          )}

                          {/* Action buttons — only for active stage */}
                          {isActive && !workflowDone && (
                            <div className="wf-stage-actions">
                              {/* Execute button */}
                              {(stage.action !== "HOLD") && (
                                <button
                                  className="wf-exec-btn"
                                  onClick={() => executeStageAction(stage, idx)}
                                  disabled={!canTrade}
                                >
                                  ▶ {stage.action === "BUY" || stage.action === "SCALE IN" ? "Execute Buy" : "Execute Sell/Exit"}
                                </button>
                              )}
                              {stage.action === "HOLD" && (
                                <div className="wf-hold-note">◈ HOLD — no trade needed this stage</div>
                              )}

                              {/* Outcome buttons (user marks result) */}
                              <div className="wf-outcome-row">
                                <span className="wf-outcome-label">Mark result:</span>
                                <button
                                  className="wf-outcome-btn win"
                                  onClick={() => resolveStage(idx, "win")}
                                  title="Stage hit target — move to next"
                                >✓ Win</button>
                                <button
                                  className="wf-outcome-btn loss"
                                  onClick={() => resolveStage(idx, "loss")}
                                  title="Stage hit stop — move to next"
                                >✗ Loss</button>
                                <button
                                  className="wf-outcome-btn skip"
                                  onClick={() => resolveStage(idx, "skip")}
                                  title="Skip this stage"
                                >— Skip</button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* ── Apply entry to manual tab ── */}
              {!workflowDone && (
                <button
                  className="ai-apply-btn"
                  onClick={() => {
                    if (workflow.suggestedEntry) setPrice(workflow.suggestedEntry.toString());
                    if (workflow.suggestedStop)  setStopLoss(workflow.suggestedStop.toString());
                    if (workflow.suggestedTP)    setTakeProfit(workflow.suggestedTP.toString());
                    onOrderModeChange("manual");
                  }}
                >
                  ↗ Apply prices to Manual tab
                </button>
              )}

              {/* ── Reset after done ── */}
              {workflowDone && (
                <button className="ai-reset-btn" onClick={resetWorkflow}>
                  ↩ Build New Strategy
                </button>
              )}

            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          MANUAL TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {mode === "manual" && (
        <>
          <div className="field-row">
            <label className="field-label">Price (THB)<TooltipIcon id="tooltip-order-price" /></label>
            <input type="number" className="field-input" value={price} onChange={e => setPrice(e.target.value)} placeholder={currentPrice?.toFixed(2)} step="0.01" />
          </div>

          <div className="field-row">
            <label className="field-label">Quantity ({market === "gold" ? "baht-weight" : "shares"})<TooltipIcon id="tooltip-order-qty" /></label>
            <div className="qty-row">
              <input type="number" className="field-input" value={qty} onChange={e => setQty(e.target.value)} placeholder={`min ${market === "gold" ? 1 : 100}`} min={market === "gold" ? 1 : 100} step={market === "gold" ? 1 : 100} />
              <button className="suggest-btn" onClick={handleSuggestSize}>Auto Size</button>
            </div>
            <div className="risk-level-select">
              {["low","medium","high"].map(lvl => (
                <button key={lvl} className={`risk-btn ${riskLevel === lvl ? "active" : ""} ${lvl}`} onClick={() => setRiskLevel(lvl)}>{lvl}</button>
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
