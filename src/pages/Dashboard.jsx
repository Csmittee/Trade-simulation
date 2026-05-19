/**
 * Dashboard.jsx
 * Phase 5 — Session persistence + KV operation optimization
 *
 * Changes from Phase 4:
 * - autoExecute lifted here from StrategyPanel (was local state)
 * - All 9 strategy/workflow KV keys bundled into ONE key (settings:strategyBundle)
 *   → Load: 11 reads → 3 reads per session start
 *   → Write: 9 separate writes → 1 write per any strategy state change
 * - KV restore on load covers: activeStrategy, autoExecute, workflow, all stage state
 * - handleActivityEvent writes to D1 via /api/logs
 * - activityEvents loaded from D1 on mount (last 12 hrs)
 * - handleLoadMoreLogs: fetches 12 hrs further back per call
 * - Only Reset button clears everything — tab switch / Ctrl+R / browser swap safe
 */

import { useState, useEffect, useCallback, useRef } from "react";
import GoldMarket from "./GoldMarket.jsx";
import SetMarket   from "./SetMarket.jsx";
import Portfolio   from "./Portfolio.jsx";

import Tooltip, { TooltipIcon } from "../components/Tooltip.jsx";
import { createPortfolio, resetPortfolio, calcPortfolioSummary, isMarketOpen } from "../core/portfolio-engine.js";
import { makeActivityEvent } from "../components/ActivityLog.jsx";
import config from "../../config.js";

const WORKER_BASE      = config.workers.base;
const WORKER_PORTFOLIO = WORKER_BASE + config.workers.routes.portfolio;
const WORKER_SETTINGS  = WORKER_BASE + config.workers.routes.settings;
const WORKER_LOGS      = WORKER_BASE + config.workers.routes.logs;

const BUNDLE_KEY = "settings:strategyBundle";
const HOURS_KEY  = "settings:enforce_hours";

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
        type:      event.type     || "info",
        market:    event.market   || "system",
        message:   event.message  || event.text || "",
        detail:    event.detail   || "",
        pnl:       event.pnl      ?? null,
        strategy:  event.strategy || null,
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

const EMPTY_WORKFLOW = {
  workflow:          null,
  stageStatuses:     [],
  activeStageIdx:    0,
  consecutiveRed:    0,
  workflowDone:      false,
  fallbackTriggered: false,
  stagePnl:          [],
};

const EMPTY_BUNDLE = {
  activeStrategy:    "off",
  autoExecute:       false,
  strategyDuration:  null,
  goldOrderMode:     "manual",
  setOrderMode:      "manual",
  gold:              { ...EMPTY_WORKFLOW },
  set:               { ...EMPTY_WORKFLOW },
};

export default function Dashboard() {
  const [portfolio,     setPortfolio]     = useState(null);
  const [activeTab,     setActiveTab]     = useState("gold");
  const [enforceHours,  setEnforceHours]  = useState(true);
  const [showReset,     setShowReset]     = useState(false);
  const [bootstrapped,  setBootstrapped]  = useState(false);

  // ── Strategy state (lifted from StrategyPanel — Phase 5) ─────────────────
  const [activeStrategy,   setActiveStrategy]   = useState("off");
  const [autoExecute,      setAutoExecute]      = useState(false);
  const [strategyDuration, setStrategyDuration] = useState(null);

  // ── AI workflow state — split per market (Fix A — Phase 6b) ─────────────
  // Gold
  const [goldWorkflow,          setGoldWorkflow]          = useState(null);
  const [goldStageStatuses,     setGoldStageStatuses]     = useState([]);
  const [goldActiveStageIdx,    setGoldActiveStageIdx]    = useState(0);
  const [goldConsecutiveRed,    setGoldConsecutiveRed]    = useState(0);
  const [goldWorkflowDone,      setGoldWorkflowDone]      = useState(false);
  const [goldFallbackTriggered, setGoldFallbackTriggered] = useState(false);
  const [goldStagePnl,          setGoldStagePnl]          = useState([]);

  // SET
  const [setWorkflow,          setSetWorkflow]          = useState(null);
  const [setStageStatuses,     setSetStageStatuses]     = useState([]);
  const [setActiveStageIdx,    setSetActiveStageIdx]    = useState(0);
  const [setConsecutiveRed,    setSetConsecutiveRed]    = useState(0);
  const [setWorkflowDone,      setSetWorkflowDone]      = useState(false);
  const [setFallbackTriggered, setSetFallbackTriggered] = useState(false);
  const [setStagePnl,          setSetStagePnl]          = useState([]);

  // Fix B — orderMode per market, lifted from market pages
  const [goldOrderMode, setGoldOrderMode] = useState("manual");
  const [setOrderMode,  setSetOrderMode]  = useState("manual");

  // Derived active flags per market
  const goldWorkflowActive = !!goldWorkflow && !goldWorkflowDone;
  const setWorkflowActive  = !!setWorkflow  && !setWorkflowDone;

  // ── Activity log ──────────────────────────────────────────────────────────
  const [activityEvents, setActivityEvents] = useState([]);
  const [logOldestTs,    setLogOldestTs]    = useState(null);
  const [logLoading,     setLogLoading]     = useState(false);
  const [logHasMore,     setLogHasMore]     = useState(true);

  // Prevents persist effects from firing before bootstrap completes
  const bootstrappedRef = useRef(false);

  // ── Load all state from KV on mount (3 reads total) ───────────────────────
  useEffect(() => {
    async function load() {
      const [savedPortfolio, savedHours, savedBundle] = await Promise.all([
        kvGetPortfolio(),
        kvGetSetting(HOURS_KEY),
        kvGetSetting(BUNDLE_KEY),
      ]);

      // Portfolio
      if (savedPortfolio && (savedPortfolio.balance > 0 || savedPortfolio.startingBalance > 0)) {
        setPortfolio(savedPortfolio);
      }

      // Market hours
      if (savedHours !== null) {
        setEnforceHours(savedHours === "true" || savedHours === true);
      }

      // Strategy bundle (all fields in one JSON blob)
      if (savedBundle && savedBundle !== "null") {
        try {
          const b = JSON.parse(savedBundle);
          if (b.activeStrategy !== undefined)    setActiveStrategy(b.activeStrategy);
          if (b.autoExecute !== undefined)        setAutoExecute(Boolean(b.autoExecute));
          if (b.strategyDuration !== undefined)   setStrategyDuration(b.strategyDuration ?? null);

          // Fix B — restore orderMode per market
          if (b.goldOrderMode)  setGoldOrderMode(b.goldOrderMode);
          if (b.setOrderMode)   setSetOrderMode(b.setOrderMode);

          // Fix A — restore gold workflow bundle
          const g = b.gold || {};
          if (g.workflow)                         setGoldWorkflow(g.workflow);
          if (Array.isArray(g.stageStatuses))     setGoldStageStatuses(g.stageStatuses);
          if (g.activeStageIdx !== undefined)     setGoldActiveStageIdx(Number(g.activeStageIdx) || 0);
          if (g.consecutiveRed !== undefined)     setGoldConsecutiveRed(Number(g.consecutiveRed) || 0);
          if (g.workflowDone !== undefined)       setGoldWorkflowDone(Boolean(g.workflowDone));
          if (g.fallbackTriggered !== undefined)  setGoldFallbackTriggered(Boolean(g.fallbackTriggered));
          if (Array.isArray(g.stagePnl))          setGoldStagePnl(g.stagePnl);

          // Fix A — restore SET workflow bundle
          const s = b.set || {};
          if (s.workflow)                         setSetWorkflow(s.workflow);
          if (Array.isArray(s.stageStatuses))     setSetStageStatuses(s.stageStatuses);
          if (s.activeStageIdx !== undefined)     setSetActiveStageIdx(Number(s.activeStageIdx) || 0);
          if (s.consecutiveRed !== undefined)     setSetConsecutiveRed(Number(s.consecutiveRed) || 0);
          if (s.workflowDone !== undefined)       setSetWorkflowDone(Boolean(s.workflowDone));
          if (s.fallbackTriggered !== undefined)  setSetFallbackTriggered(Boolean(s.fallbackTriggered));
          if (Array.isArray(s.stagePnl))          setSetStagePnl(s.stagePnl);
        } catch { /* malformed JSON — start fresh */ }
      }

      // Activity log from D1 (last 12 hrs)
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
    kvSetSetting(HOURS_KEY, String(enforceHours));
  }, [enforceHours]);

  // ── Persist all strategy state as ONE KV write ────────────────────────────
  // Any change to any strategy field → single KV write
  useEffect(() => {
    if (!bootstrappedRef.current) return;
    kvSetSetting(BUNDLE_KEY, JSON.stringify({
      activeStrategy:    activeStrategy || "off",
      autoExecute,
      strategyDuration:  strategyDuration ?? null,
      goldOrderMode,
      setOrderMode,
      gold: {
        workflow:          goldWorkflow || null,
        stageStatuses:     goldStageStatuses,
        activeStageIdx:    goldActiveStageIdx,
        consecutiveRed:    goldConsecutiveRed,
        workflowDone:      goldWorkflowDone,
        fallbackTriggered: goldFallbackTriggered,
        stagePnl:          goldStagePnl,
      },
      set: {
        workflow:          setWorkflow || null,
        stageStatuses:     setStageStatuses,
        activeStageIdx:    setActiveStageIdx,
        consecutiveRed:    setConsecutiveRed,
        workflowDone:      setWorkflowDone,
        fallbackTriggered: setFallbackTriggered,
        stagePnl:          setStagePnl,
      },
    }));
  }, [
    activeStrategy, autoExecute, strategyDuration, goldOrderMode, setOrderMode,
    goldWorkflow, goldStageStatuses, goldActiveStageIdx, goldConsecutiveRed,
    goldWorkflowDone, goldFallbackTriggered, goldStagePnl,
    setWorkflow, setStageStatuses, setActiveStageIdx, setConsecutiveRed,
    setWorkflowDone, setFallbackTriggered, setStagePnl,
  ]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleBalanceConfirm = useCallback((amount) => {
    setPortfolio(createPortfolio(amount));
  }, []);

  const handleReset = useCallback(async (newAmount) => {
    setPortfolio(resetPortfolio(newAmount));
    setShowReset(false);
    // Clear all strategy state in memory
    setActiveStrategy("off");
    setAutoExecute(false);
    setStrategyDuration(null);
    // Clear gold workflow
    setGoldWorkflow(null);
    setGoldStageStatuses([]);
    setGoldActiveStageIdx(0);
    setGoldConsecutiveRed(0);
    setGoldWorkflowDone(false);
    setGoldFallbackTriggered(false);
    setGoldStagePnl([]);
    // Clear SET workflow
    setSetWorkflow(null);
    setSetStageStatuses([]);
    setSetActiveStageIdx(0);
    setSetConsecutiveRed(0);
    setSetWorkflowDone(false);
    setSetFallbackTriggered(false);
    setSetStagePnl([]);
    // Reset orderMode
    setGoldOrderMode("manual");
    setSetOrderMode("manual");
    setActivityEvents([]);
    // Clear KV bundle in one write
    await kvSetSetting(BUNDLE_KEY, JSON.stringify(EMPTY_BUNDLE));
  }, []);

  // AI strategy call (Worker → Anthropic)
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

  // Activity log — normalise, write to D1, append to memory
  const handleActivityEvent = useCallback((eventOrCmd) => {
    if (eventOrCmd === "__clear__gold") {
      setActivityEvents(prev => prev.filter(e => e.market !== "gold"));
      return;
    }
    if (eventOrCmd === "__clear__set") {
      setActivityEvents(prev => prev.filter(e => e.market !== "set"));
      return;
    }

    const ev = (eventOrCmd?.id && eventOrCmd?.time)
      ? eventOrCmd
      : makeActivityEvent(eventOrCmd);

    d1PostLog(ev); // async, non-blocking

    setActivityEvents(prev => {
      const next = [...prev, ev];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  // Load more logs — 12 hrs further back per click
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
      setActivityEvents(prev => [...events, ...prev]); // prepend older to top
      setLogOldestTs(older[older.length - 1]?.logged_at || null);
      setLogHasMore(older.length >= 50);
    } finally {
      setLogLoading(false);
    }
  }, [logLoading, logHasMore, logOldestTs]);

  // ── Loading / first-run states ────────────────────────────────────────────
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

  const summary       = calcPortfolioSummary(portfolio);
  const totalReturnUp = summary.totalReturn >= 0;
  const dayPnLUp      = summary.realisedPnL >= 0;
  const setOpen       = isMarketOpen("set",  enforceHours);
  const goldOpen      = isMarketOpen("gold", enforceHours);

  // Shared props that are identical for both markets
  const commonMarketProps = {
    portfolio,
    setPortfolio,
    enforceHours,
    onAIStrategy:             handleAIStrategy,
    activeStrategy,
    onStrategyChange:         setActiveStrategy,
    autoExecute,
    onAutoExecuteChange:      setAutoExecute,
    strategyDuration,
    onStrategyDurationChange: setStrategyDuration,
    activityEvents,
    onActivityEvent:          handleActivityEvent,
    onLoadMoreLogs:           handleLoadMoreLogs,
    logLoading,
    logHasMore,
  };

  // Gold-specific workflow + orderMode props (Fix A + Fix B)
  const goldMarketProps = {
    ...commonMarketProps,
    orderMode:            goldOrderMode,
    onOrderModeChange:    setGoldOrderMode,
    workflow:             goldWorkflow,          setWorkflow:          setGoldWorkflow,
    stageStatuses:        goldStageStatuses,     setStageStatuses:     setGoldStageStatuses,
    activeStageIdx:       goldActiveStageIdx,    setActiveStageIdx:    setGoldActiveStageIdx,
    consecutiveRed:       goldConsecutiveRed,    setConsecutiveRed:    setGoldConsecutiveRed,
    workflowDone:         goldWorkflowDone,      setWorkflowDone:      setGoldWorkflowDone,
    fallbackTriggered:    goldFallbackTriggered, setFallbackTriggered: setGoldFallbackTriggered,
    stagePnl:             goldStagePnl,          setStagePnl:          setGoldStagePnl,
    aiWorkflowActive:     goldWorkflowActive,
  };

  // SET-specific workflow + orderMode props (Fix A + Fix B)
  const setMarketProps = {
    ...commonMarketProps,
    orderMode:            setOrderMode,
    onOrderModeChange:    setSetOrderMode,
    workflow:             setWorkflow,           setWorkflow:          setSetWorkflow,
    stageStatuses:        setStageStatuses,      setStageStatuses:     setSetStageStatuses,
    activeStageIdx:       setActiveStageIdx,     setActiveStageIdx:    setSetActiveStageIdx,
    consecutiveRed:       setConsecutiveRed,     setConsecutiveRed:    setSetConsecutiveRed,
    workflowDone:         setWorkflowDone,       setWorkflowDone:      setSetWorkflowDone,
    fallbackTriggered:    setFallbackTriggered,  setFallbackTriggered: setSetFallbackTriggered,
    stagePnl:             setStagePnl,           setStagePnl:          setSetStagePnl,
    aiWorkflowActive:     setWorkflowActive,
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
                aria-label={`Market hours: ${enforceHours ? "ON" : "OFF"}`}
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
            className={`tab-btn ${activeTab === key ? "active" : ""}`}
            onClick={() => setActiveTab(key)}
          >
            <span>{icon}</span>
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {/* ── Tab Content ── */}
      <main className="tab-content">
        {activeTab === "gold" && <GoldMarket {...goldMarketProps} />}
        {activeTab === "set"  && <SetMarket  {...setMarketProps} />}
        {activeTab === "portfolio" && (
  <Portfolio
    portfolio={portfolio}
    workflow={goldWorkflow || setWorkflow}
    activeStrategy={activeStrategy}
    autoExecute={autoExecute}
    activityEvents={activityEvents}
    stageStatuses={goldWorkflow ? goldStageStatuses : setStageStatuses}
    activeStageIdx={goldWorkflow ? goldActiveStageIdx : setActiveStageIdx}
    workflowDone={goldWorkflow ? goldWorkflowDone : setWorkflowDone}
    onTabSwitch={setActiveTab}
  />
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
