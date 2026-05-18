/**
 * Dashboard.jsx
 * Master shell — header, tab navigation, global state, balance reset.
 * Imports market pages and passes shared portfolio state down.
 */

import { useState, useEffect, useCallback } from "react";
import GoldMarket from "./GoldMarket.jsx";
import SetMarket  from "./SetMarket.jsx";
import Tooltip, { TooltipIcon } from "../components/Tooltip.jsx";
import { createPortfolio, resetPortfolio, calcPortfolioSummary, isMarketOpen } from "../core/portfolio-engine.js";
import config from "../../config.js";

// ── KV persistence helpers (calls /api/portfolio Worker) ─────────────────────
const WORKER_PORTFOLIO = config.workers.base + config.workers.routes.portfolio;
const WORKER_SETTINGS  = config.workers.base + config.workers.routes.settings;

async function kvGet(key) {
  try {
    const res = await fetch(`${WORKER_PORTFOLIO}?key=${key}`);
    const json = await res.json();
    return json.success ? json.data : null;
  } catch { return null; }
}

async function kvSet(key, value) {
  try {
    await fetch(WORKER_PORTFOLIO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
  } catch { /* silent fail — state still in memory */ }
}

// ── Balance Setup Modal ───────────────────────────────────────────────────────
function BalanceModal({ onConfirm }) {
  const [amount, setAmount] = useState(config.app.defaultBalance.toString());

  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <div className="modal-icon">🏦</div>
        <h2 className="modal-title">Set Your Starting Balance</h2>
        <p className="modal-desc">
          This is your virtual trading capital. Choose an amount that reflects
          what you'd realistically start with in real life.
        </p>
        <div className="modal-input-row">
          <span className="modal-currency">฿</span>
          <input
            type="number"
            className="modal-input"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            min={10000}
            step={100000}
          />
        </div>
        <p className="modal-hint">
          Suggested: ฿500,000 – ฿2,000,000 for realistic gold trading simulation
        </p>
        <button
          className="modal-confirm-btn"
          onClick={() => onConfirm(parseFloat(amount) || config.app.defaultBalance)}
          disabled={!amount || parseFloat(amount) < 10000}
        >
          Start Trading →
        </button>
      </div>
    </div>
  );
}

// ── Reset Confirm Dialog ──────────────────────────────────────────────────────
function ResetDialog({ balance, onConfirm, onCancel }) {
  const [newAmount, setNewAmount] = useState(balance.toString());

  return (
    <div className="modal-overlay">
      <div className="modal-box reset-dialog">
        <div className="modal-icon">🔄</div>
        <h2 className="modal-title">Game Over — Restart?</h2>
        <p className="modal-desc">
          All open positions will be closed. Your balance resets to the amount below.
          <strong> Trade history is kept</strong> so you can review what happened.
        </p>
        <div className="modal-input-row">
          <span className="modal-currency">฿</span>
          <input
            type="number"
            className="modal-input"
            value={newAmount}
            onChange={e => setNewAmount(e.target.value)}
            min={10000}
            step={100000}
          />
        </div>
        <div className="dialog-buttons">
          <button className="dialog-cancel-btn" onClick={onCancel}>Cancel</button>
          <button
            className="dialog-confirm-btn"
            onClick={() => onConfirm(parseFloat(newAmount) || balance)}
          >
            Reset & Restart
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
const TABS = [
  { key: "gold",      label: "Gold",      icon: "🥇" },
  { key: "set",       label: "SET/MAI",   icon: "📈" },
  { key: "portfolio", label: "Portfolio", icon: "💼" },
];

export default function Dashboard() {
  const [portfolio, setPortfolio]       = useState(null);   // null = not loaded yet
  const [activeTab, setActiveTab]       = useState("gold");
  const [enforceHours, setEnforceHours] = useState(true);
  const [showReset, setShowReset]       = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [activeStrategy, setActiveStrategy] = useState(null);  // Phase 4 BUG001 fix — lifted from market pages
  const [activityEvents, setActivityEvents] = useState([]);     // Phase 4 — activity log feed

  // ── Lifted: AI workflow state (BUG002) ───────────────────────────────────
  const [workflow,          setWorkflow]          = useState(null);
  const [stageStatuses,     setStageStatuses]     = useState([]);
  const [activeStageIdx,    setActiveStageIdx]    = useState(0);
  const [consecutiveRed,    setConsecutiveRed]    = useState(0);
  const [workflowDone,      setWorkflowDone]      = useState(false);
  const [fallbackTriggered, setFallbackTriggered] = useState(false);
  const [stagePnl,          setStagePnl]          = useState([]);

  // BUG003: AI workflow active = workflow exists and not done
  const aiWorkflowActive = !!workflow && !workflowDone;
  // ── Load state from KV on mount ──────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      const saved = await kvGet("portfolio:state");
      const settings = await kvGet("settings:enforce_hours");

      if (saved && (saved.balance > 0 || saved.startingBalance > 0)) {
        setPortfolio(saved);
      }
      // If no saved state OR saved state is corrupted (balance=0) → show BalanceModal
      // This handles cases where a bad deploy wipes the portfolio state in KV

      if (settings !== null) {
        setEnforceHours(settings === "true" || settings === true);
      }

      setBootstrapped(true);
    }
    load();
  }, []);

  // ── Persist portfolio to KV whenever it changes ───────────────────────────
  useEffect(() => {
    if (portfolio) kvSet("portfolio:state", portfolio);
  }, [portfolio]);

  // ── Persist market hours toggle ───────────────────────────────────────────
  useEffect(() => {
    if (bootstrapped) kvSet("settings:enforce_hours", String(enforceHours));
  }, [enforceHours, bootstrapped]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleBalanceConfirm = useCallback((amount) => {
    const fresh = createPortfolio(amount);
    setPortfolio(fresh);
  }, []);

  const handleReset = useCallback((newAmount) => {
    const fresh = resetPortfolio(newAmount);
    setPortfolio(fresh);
    setShowReset(false);
  }, []);

  // AI strategy — calls the Worker which calls Anthropic
  const handleAIStrategy = useCallback(async ({ prompt, market, currentPrice, portfolio: summary }) => {
    const res = await fetch(config.workers.base + config.workers.routes.strategy, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, market, currentPrice, portfolio: summary }),
    });
    if (!res.ok) throw new Error(`Strategy Worker returned ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    return json.data;
  }, []);

// Activity log event handler — called by market pages
  // Special string "__clear__gold" or "__clear__set" clears that market's events
  const handleActivityEvent = useCallback((ev) => {
    if (ev === "__clear__gold") {
      setActivityEvents(prev => prev.filter(e => e.market !== "gold"));
      return;
    }
    if (ev === "__clear__set") {
      setActivityEvents(prev => prev.filter(e => e.market !== "set"));
      return;
    }
    setActivityEvents(prev => {
      const next = [...prev, ev];
      return next.length > 200 ? next.slice(-200) : next;
    });
  }, []);

  
  // ── Loading state ─────────────────────────────────────────────────────────
  if (!bootstrapped) {
    return (
      <div className="dashboard-loading">
        <div className="loading-spinner" />
        <span>Loading your trading desk...</span>
      </div>
    );
  }

  // ── First run — show balance setup ───────────────────────────────────────
  if (!portfolio) {
    return <BalanceModal onConfirm={handleBalanceConfirm} />;
  }

  const summary = calcPortfolioSummary(portfolio);
  const totalReturnUp = summary.totalReturn >= 0;
  const dayPnLUp      = summary.realisedPnL >= 0;

  const setOpen  = isMarketOpen("set",  enforceHours);
  const goldOpen = isMarketOpen("gold", enforceHours);

  return (
    <div className="dashboard">

      {/* ── Header ── */}
      <header className="dashboard-header">
        <div className="header-left">
          <span className="app-logo">⚡ TradeSim</span>
          <span className="app-subtitle">Thai Paper Trading</span>
        </div>

        <div className="header-metrics">
          <Tooltip id="tooltip-header-equity">
            <div className="metric-block">
              <span className="metric-label">Total Equity</span>
              <span className="metric-value">
                ฿{summary.totalEquity.toLocaleString("en-US", { minimumFractionDigits: 0 })}
              </span>
            </div>
          </Tooltip>

          <Tooltip id="tooltip-header-balance">
            <div className="metric-block">
              <span className="metric-label">Cash</span>
              <span className="metric-value">
                ฿{summary.balance.toLocaleString("en-US", { minimumFractionDigits: 0 })}
              </span>
            </div>
          </Tooltip>

          <Tooltip id="tooltip-header-day-pnl">
            <div className="metric-block">
              <span className="metric-label">Session P&L</span>
              <span className={`metric-value ${dayPnLUp ? "pnl-up" : "pnl-down"}`}>
                {dayPnLUp ? "+" : ""}฿{summary.realisedPnL.toLocaleString("en-US", { minimumFractionDigits: 0 })}
              </span>
            </div>
          </Tooltip>

          <Tooltip id="tooltip-header-balance">
            <div className="metric-block">
              <span className="metric-label">Total Return</span>
              <span className={`metric-value ${totalReturnUp ? "pnl-up" : "pnl-down"}`}>
                {totalReturnUp ? "+" : ""}{summary.totalReturnPct.toFixed(2)}%
              </span>
            </div>
          </Tooltip>
        </div>

        <div className="header-controls">
          {/* Market Status Pills */}
          <div className="market-pills">
            <Tooltip id={`tooltip-market-set-${setOpen ? "open" : "closed"}`}>
              <span className={`market-pill ${setOpen ? "open" : "closed"}`}>
                SET {setOpen ? "●" : "○"}
              </span>
            </Tooltip>
            <Tooltip id={`tooltip-market-gold-${goldOpen ? "open" : "closed"}`}>
              <span className={`market-pill ${goldOpen ? "open" : "closed"}`}>
                GOLD {goldOpen ? "●" : "○"}
              </span>
            </Tooltip>
          </div>

          {/* Market Hours Toggle */}
          <Tooltip id="tooltip-header-market-hours">
            <div className="toggle-control">
              <span className="toggle-label">Market Hours</span>
              <button
                className={`toggle-btn ${enforceHours ? "on" : "off"}`}
                onClick={() => setEnforceHours(v => !v)}
                aria-label={`Market hours enforcement: ${enforceHours ? "ON" : "OFF"}`}
              >
                <span className="toggle-knob" />
              </button>
              <span className={`toggle-state ${enforceHours ? "on" : "off"}`}>
                {enforceHours ? "ON" : "OFF"}
              </span>
            </div>
          </Tooltip>

          {/* Reset Button */}
          <Tooltip id="tooltip-header-reset">
            <button className="reset-btn" onClick={() => setShowReset(true)}>
              🔄 Reset
            </button>
          </Tooltip>
        </div>
      </header>

      {/* ── Tab Navigation ── */}
      <nav className="tab-nav">
        {TABS.map(({ key, label, icon }) => (
          <button
            key={key}
            className={`tab-btn ${activeTab === key ? "active" : ""} ${key === "portfolio" ? "coming-soon" : ""}`}
            onClick={() => setActiveTab(key)}
          >
            <span>{icon}</span>
            <span>{label}</span>
            {key === "portfolio" && <span className="coming-tag">Phase 5</span>}
          </button>
        ))}
      </nav>

      {/* ── Tab Content ── */}
      <main className="tab-content">
         {activeTab === "gold" && (
          <GoldMarket
            portfolio={portfolio}
            setPortfolio={setPortfolio}
            enforceHours={enforceHours}
            onAIStrategy={handleAIStrategy}
            activeStrategy={activeStrategy}
            onStrategyChange={setActiveStrategy}
            activityEvents={activityEvents}
            onActivityEvent={handleActivityEvent}
            workflow={workflow} setWorkflow={setWorkflow}
            stageStatuses={stageStatuses} setStageStatuses={setStageStatuses}
            activeStageIdx={activeStageIdx} setActiveStageIdx={setActiveStageIdx}
            consecutiveRed={consecutiveRed} setConsecutiveRed={setConsecutiveRed}
            workflowDone={workflowDone} setWorkflowDone={setWorkflowDone}
            fallbackTriggered={fallbackTriggered} setFallbackTriggered={setFallbackTriggered}
            stagePnl={stagePnl} setStagePnl={setStagePnl}
            aiWorkflowActive={aiWorkflowActive}
          />
        )}
       {activeTab === "set" && (
          <SetMarket
            portfolio={portfolio}
            setPortfolio={setPortfolio}
            enforceHours={enforceHours}
            onAIStrategy={handleAIStrategy}
            activeStrategy={activeStrategy}
            onStrategyChange={setActiveStrategy}
            activityEvents={activityEvents}
            onActivityEvent={handleActivityEvent}
            workflow={workflow} setWorkflow={setWorkflow}
            stageStatuses={stageStatuses} setStageStatuses={setStageStatuses}
            activeStageIdx={activeStageIdx} setActiveStageIdx={setActiveStageIdx}
            consecutiveRed={consecutiveRed} setConsecutiveRed={setConsecutiveRed}
            workflowDone={workflowDone} setWorkflowDone={setWorkflowDone}
            fallbackTriggered={fallbackTriggered} setFallbackTriggered={setFallbackTriggered}
            stagePnl={stagePnl} setStagePnl={setStagePnl}
            aiWorkflowActive={aiWorkflowActive}
          />
        )}
        {activeTab === "portfolio" && (
          <div className="coming-soon-page">
            <div className="coming-icon">💼</div>
            <h2>Portfolio View — Phase 5</h2>
            <p>Combined portfolio analytics with drawdown, win rate, and hourly P&L will be built in Phase 5.</p>
          </div>
        )}
      </main>

      {/* ── Reset Dialog ── */}
      {showReset && (
        <ResetDialog
          balance={portfolio.startingBalance}
          onConfirm={handleReset}
          onCancel={() => setShowReset(false)}
        />
      )}
    </div>
  );
}
