/**
 * Dashboard.jsx
 * Phase 5 — Session persistence: strategy state, autoExecute, workflow,
 *            all survive tab switch, Ctrl+Shift+R, browser swap.
 * Only a manual Reset button wipe clears the state.
 *
 * Changes from Phase 4:
 * - autoExecute lifted here from StrategyPanel (was local state)
 * - All strategy + workflow state persisted to KV on every change
 * - KV restore on load covers: activeStrategy, autoExecute, workflow,
 *   stageStatuses, activeStageIdx, consecutiveRed, workflowDone,
 *   fallbackTriggered, stagePnl
 * - handleActivityEvent now also writes to D1 via /api/logs
 * - activityEvents loaded from D1 on mount (last 12 hrs)
 * - loadMoreLogs() fetches 12 hrs further back per call
 */

import { useState, useEffect, useCallback, useRef } from "react";
import GoldMarket from "./GoldMarket.jsx";
import SetMarket  from "./SetMarket.jsx";
import Tooltip, { TooltipIcon } from "../components/Tooltip.jsx";
import { createPortfolio, resetPortfolio, calcPortfolioSummary, isMarketOpen } from "../core/portfolio-engine.js";
import { makeActivityEvent } from "../components/ActivityLog.jsx";
import config from "../../config.js";

const WORKER_BASE      = config.workers.base;
const WORKER_PORTFOLIO = WORKER_BASE + config.workers.routes.portfolio;
const WORKER_SETTINGS  = WORKER_BASE + config.workers.routes.settings;
const WORKER_LOGS      = WORKER_BASE + config.workers.routes.logs;

// ── KV helpers ────────────────────────────────────────────────────────────────
async function kvGetPortfolio() {
  try {
    const res  = await fetch(WORKER_PORTFOLIO);
    const json = await res.json();
    return json.success ? json.data : null;
  } catch { return null; }
}

async function kvSetPortfolio(value) {
  try {
    await fetch(WORKER_PORTFOLIO, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ value }),
    });
  } catch { /* silent */ }
}

async function kvGetSetting(key) {
  try {
    const res  = await fetch(`${WORKER_SETTINGS}?key=${encodeURIComponent(key)}`);
    const json = await res.json();
    return json.success ? json.data : null;
  } catch { return null; }
}

async function kvSetSetting(key, value) {
  try {
    await fetch(WORKER_SETTINGS, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ key, value: typeof value === "string" ? value : JSON.stringify(value) }),
    });
  } catch { /* silent */ }
}

// ── D1 activity log helpers ───────────────────────────────────────────────────
async function d1PostLog(event) {
  try {
    await fetch(WORKER_LOGS, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        id:        event.id,
        type:      event.type      || "info",
        market:    event.market    || "system",
        message:   event.message   || event.text || "",
        detail:    event.detail    || "",
        pnl:       event.pnl       ?? null,
        strategy:  event.strategy  || null,
        logged_at: event.time instanceof Date
          ? event.time.toISOString()
          : new Date().toISOString(),
      }),
    });
  } catch { /* silent — log lives in memory anyway */ }
}

async function d1GetLogs(before = null, limitHours = 12) {
  try {
    const url = new URL(WORKER_LOGS);
    url.searchParams.set("hours", limitHours);
    if (before) url.searchParams.set("before", before);
    const res  = await fetch(url.toString());
    const json = await res.json();
    return json.success ? json.data : [];
  } catch { return []; }
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

// KV keys for strategy persistence
const KV = {
  STRATEGY:        "settings:activeStrategy",
  AUTO_EXECUTE:    "settings:autoExecute",
  WORKFLOW:        "settings:workflow",
  STAGE_STATUSES:  "settings:workflowStages",
  STAGE_IDX:       "settings:workflowStageIdx",
  CONSEC_RED:      "settings:consecutiveRed",
  WORKFLOW_DONE:   "settings:workflowDone",
  FALLBACK:        "settings:fallbackTriggered",
  STAGE_PNL:       "settings:stagePnl",
  ENFORCE_HOURS:   "settings:enforce_hours",
};

export default function Dashboard() {
  const [portfolio,     setPortfolio]     = useState(null);
  const [activeTab,     setActiveTab]     = useState("gold");
  const [enforceHours,  setEnforceHours]  = useState(true);
  const [showReset,     setShowReset]     = useState(false);
  const [bootstrapped,  setBootstrapped]  = useState(false);

  // ── Strategy state (lifted from StrategyPanel — BUG001 + Phase 5) ──────────
  const [activeStrategy, setActiveStrategy] = useState("off");
  const [autoExecute,    setAutoExecute]    = useState(false);

  // ── AI workflow state (lifted — BUG002) ───────────────────────────────────
  const [workflow,          setWorkflow]          = useState(null);
  const [stageStatuses,     setStageStatuses]     = useState([]);
  const [activeStageIdx,    setActiveStageIdx]    = useState(0);
  const [consecutiveRed,    setConsecutiveRed]    = useState(0);
  const [workflowDone,      setWorkflowDone]      = useState(false);
  const [fallbackTriggered, setFallbackTriggered] = useState(false);
  const [stagePnl,          setStagePnl]          = useState([]);

  // BUG003: AI workflow active = workflow exists and not done
  const aiWorkflowActive = !!workflow && !workflowDone;

  // ── Activity log ──────────────────────────────────────────────────────────
  const [activityEvents,   setActivityEvents]   = useState([]);
  const [logOldestTs,      setLogOldestTs]       = useState(null);  // cursor for load-more
  const [logLoading,       setLogLoading]        = useState(false);
  const [logHasMore,       setLogHasMore]        = useState(true);

  // Prevent double-persist during bootstrapping
  const bootstrappedRef = useRef(false);

  // ── Load ALL state from KV on mount ──────────────────────────────────────
  useEffect(() => {
    async function load() {
      // Load in parallel — portfolio + all settings
      const [
        savedPortfolio,
        savedHours,
        savedStrategy,
        savedAutoExec,
        savedWorkflow,
        savedStages,
        savedStageIdx,
        savedConsecRed,
        savedWorkflowDone,
        savedFallback,
        savedStagePnl,
      ] = await Promise.all([
        kvGetPortfolio(),
        kvGetSetting(KV.ENFORCE_HOURS),
        kvGetSetting(KV.STRATEGY),
        kvGetSetting(KV.AUTO_EXECUTE),
        kvGetSetting(KV.WORKFLOW),
        kvGetSetting(KV.STAGE_STATUSES),
        kvGetSetting(KV.STAGE_IDX),
        kvGetSetting(KV.CONSEC_RED),
        kvGetSetting(KV.WORKFLOW_DONE),
        kvGetSetting(KV.FALLBACK),
        kvGetSetting(KV.STAGE_PNL),
      ]);

      // Portfolio
      if (savedPortfolio && (savedPortfolio.balance > 0 || savedPortfolio.startingBalance > 0)) {
        setPortfolio(savedPortfolio);
      }

      // Market hours
      if (savedHours !== null) {
        setEnforceHours(savedHours === "true" || savedHours === true);
      }

      // Strategy
      if (savedStrategy && savedStrategy !== "null") {
        setActiveStrategy(savedStrategy);
      }

      // Auto execute
      if (savedAutoExec !== null) {
        setAutoExecute(savedAutoExec === "true");
      }

      // Workflow
      try {
        if (savedWorkflow && savedWorkflow !== "null") {
          setWorkflow(JSON.parse(savedWorkflow));
        }
        if (savedStages && savedStages !== "null") {
          setStageStatuses(JSON.parse(savedStages));
        }
        if (savedStageIdx && savedStageIdx !== "null") {
          setActiveStageIdx(parseInt(savedStageIdx, 10) || 0);
        }
        if (savedConsecRed && savedConsecRed !== "null") {
          setConsecutiveRed(parseInt(savedConsecRed, 10) || 0);
        }
        if (savedWorkflowDone !== null) {
          setWorkflowDone(savedWorkflowDone === "true");
        }
        if (savedFallback !== null) {
          setFallbackTriggered(savedFallback === "true");
        }
        if (savedStagePnl && savedStagePnl !== "null") {
          setStagePnl(JSON.parse(savedStagePnl));
        }
      } catch { /* bad JSON — ignore, start fresh */ }

      // Load activity log from D1 (last 12 hrs)
      const logs = await d1GetLogs(null, 12);
      if (logs.length > 0) {
        const events = logs.map(r => ({
          id:       r.id,
          type:     r.type,
          market:   r.market,
          message:  r.message,
          detail:   r.detail,
          pnl:      r.pnl,
          strategy: r.strategy,
          time:     new Date(r.logged_at),
          fromD1:   true,
        }));
        setActivityEvents(events);
        setLogOldestTs(logs[logs.length - 1]?.logged_at || null);
        setLogHasMore(logs.length >= 50);
      } else {
        setLogHasMore(false);
      }

      bootstrappedRef.current = true;
      setBootstrapped(true);
    }
    load();
  }, []);

  // ── Persist portfolio ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!bootstrappedRef.current) return;
    if (portfolio) kvSetPortfolio(portfolio);
  }, [portfolio]);

  // ── Persist market hours ──────────────────────────────────────────────────
  useEffect(() => {
    if (!bootstrappedRef.current) return;
    kvSetSetting(KV.ENFORCE_HOURS, String(enforceHours));
  }, [enforceHours]);

  // ── Persist strategy + autoExecute ───────────────────────────────────────
  useEffect(() => {
    if (!bootstrappedRef.current) return;
    kvSetSetting(KV.STRATEGY, activeStrategy || "off");
  }, [activeStrategy]);

  useEffect(() => {
    if (!bootstrappedRef.current) return;
    kvSetSetting(KV.AUTO_EXECUTE, String(autoExecute));
  }, [autoExecute]);

  // ── Persist workflow state ────────────────────────────────────────────────
  useEffect(() => {
    if (!bootstrappedRef.current) return;
    kvSetSetting(KV.WORKFLOW, workflow ? JSON.stringify(workflow) : "null");
  }, [workflow]);

  useEffect(() => {
    if (!bootstrappedRef.current) return;
    kvSetSetting(KV.STAGE_STATUSES, JSON.stringify(stageStatuses));
  }, [stageStatuses]);

  useEffect(() => {
    if (!bootstrappedRef.current) return;
    kvSetSetting(KV.STAGE_IDX, String(activeStageIdx));
  }, [activeStageIdx]);

  useEffect(() => {
    if (!bootstrappedRef.current) return;
    kvSetSetting(KV.CONSEC_RED, String(consecutiveRed));
  }, [consecutiveRed]);

  useEffect(() => {
    if (!bootstrappedRef.current) return;
    kvSetSetting(KV.WORKFLOW_DONE, String(workflowDone));
  }, [workflowDone]);

  useEffect(() => {
    if (!bootstrappedRef.current) return;
    kvSetSetting(KV.FALLBACK, String(fallbackTriggered));
  }, [fallbackTriggered]);

  useEffect(() => {
    if (!bootstrappedRef.current) return;
    kvSetSetting(KV.STAGE_PNL, JSON.stringify(stagePnl));
  }, [stagePnl]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleBalanceConfirm = useCallback((amount) => {
    const fresh = createPortfolio(amount);
    setPortfolio(fresh);
  }, []);

  const handleReset = useCallback(async (newAmount) => {
    const fresh = resetPortfolio(newAmount);
    setPortfolio(fresh);
    setShowReset(false);
    // Clear all strategy state on reset
    setActiveStrategy("off");
    setAutoExecute(false);
    setWorkflow(null);
    setStageStatuses([]);
    setActiveStageIdx(0);
    setConsecutiveRed(0);
    setWorkflowDone(false);
    setFallbackTriggered(false);
    setStagePnl([]);
    setActivityEvents([]);
    // Wipe KV strategy keys
    await Promise.all([
      kvSetSetting(KV.STRATEGY,       "off"),
      kvSetSetting(KV.AUTO_EXECUTE,   "false"),
      kvSetSetting(KV.WORKFLOW,       "null"),
      kvSetSetting(KV.STAGE_STATUSES, "[]"),
      kvSetSetting(KV.STAGE_IDX,      "0"),
      kvSetSetting(KV.CONSEC_RED,     "0"),
      kvSetSetting(KV.WORKFLOW_DONE,  "false"),
      kvSetSetting(KV.FALLBACK,       "false"),
      kvSetSetting(KV.STAGE_PNL,      "[]"),
    ]);
  }, []);

  // AI strategy call (calls Worker → Anthropic)
  const handleAIStrategy = useCallback(async ({ prompt, market, currentPrice, portfolio: summary }) => {
    const res = await fetch(WORKER_BASE + config.workers.routes.strategy, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ prompt, market, currentPrice, portfolio: summary }),
    });
    if (!res.ok) throw new Error(`Strategy Worker returned ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    return json.data;
  }, []);

  // Activity log — write to memory + D1
  const handleActivityEvent = useCallback((eventOrCmd) => {
    if (eventOrCmd === "__clear__gold") {
      setActivityEvents(prev => prev.filter(e => e.market !== "gold"));
      return;
    }
    if (eventOrCmd === "__clear__set") {
      setActivityEvents(prev => prev.filter(e => e.market !== "set"));
      return;
    }

    // Normalise
    const ev = (eventOrCmd?.id && eventOrCmd?.time)
      ? eventOrCmd
      : makeActivityEvent(eventOrCmd);

    // Write to D1 (async, don't await)
    d1PostLog(ev);

    setActivityEvents(prev => {
      const next = [...prev, ev];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  // Load more activity logs (12 hrs further back per click)
  const handleLoadMoreLogs = useCallback(async () => {
    if (logLoading || !logHasMore) return;
    setLogLoading(true);
    try {
      const older = await d1GetLogs(logOldestTs, 12);
      if (older.length === 0) {
        setLogHasMore(false);
        return;
      }
      const events = older.map(r => ({
        id:       r.id,
        type:     r.type,
        market:   r.market,
        message:  r.message,
        detail:   r.detail,
        pnl:      r.pnl,
        strategy: r.strategy,
        time:     new Date(r.logged_at),
        fromD1:   true,
      }));
      setActivityEvents(prev => [...events, ...prev]); // prepend older events
      setLogOldestTs(older[older.length - 1]?.logged_at || null);
      setLogHasMore(older.length >= 50);
    } finally {
      setLogLoading(false);
    }
  }, [logLoading, logHasMore, logOldestTs]);

  // ── Loading state ─────────────────────────────────────────────────────────
  if (!bootstrapped) {
    return (
      <div className="dashboard-loading">
        <div className="loading-spinner" />
        <span>Loading your trading desk...</span>
      </div>
    );
  }

  if (!portfolio) {
    return <BalanceModal onConfirm={handleBalanceConfirm} />;
  }

  const summary      = calcPortfolioSummary(portfolio);
  const totalReturnUp = summary.totalReturn >= 0;
  const dayPnLUp      = summary.realisedPnL >= 0;
  const setOpen       = isMarketOpen("set",  enforceHours);
  const goldOpen      = isMarketOpen("gold", enforceHours);

  // Props shared to both market pages
  const sharedMarketProps = {
    portfolio,
    setPortfolio,
    enforceHours,
    onAIStrategy:      handleAIStrategy,
    activeStrategy,
    onStrategyChange:  setActiveStrategy,
    autoExecute,
    onAutoExecuteChange: setAutoExecute,
    activityEvents,
    onActivityEvent:   handleActivityEvent,
    onLoadMoreLogs:    handleLoadMoreLogs,
    logLoading,
    logHasMore,
    workflow,
    setWorkflow,
    stageStatuses,
    setStageStatuses,
    activeStageIdx,
    setActiveStageIdx,
    consecutiveRed,
    setConsecutiveRed,
    workflowDone,
    setWorkflowDone,
    fallbackTriggered,
    setFallbackTriggered,
    stagePnl,
    setStagePnl,
    aiWorkflowActive,
  };

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

          <Tooltip id="tooltip-header-total-return">
            <div className="metric-block">
              <span className="metric-label">Total Return</span>
              <span className={`metric-value ${totalReturnUp ? "pnl-up" : "pnl-down"}`}>
                {totalReturnUp ? "+" : ""}{summary.totalReturnPct.toFixed(2)}%
              </span>
            </div>
          </Tooltip>
        </div>

        <div className="header-controls">
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
          <GoldMarket {...sharedMarketProps} />
        )}
        {activeTab === "set" && (
          <SetMarket {...sharedMarketProps} />
        )}
        {activeTab === "portfolio" && (
          <div className="coming-soon-page">
            <div className="coming-icon">💼</div>
            <h2>Portfolio View — Phase 5</h2>
            <p>Pipeline dashboard, budget allocation, and ฿500/day goal tracker coming next.</p>
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
