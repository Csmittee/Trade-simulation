/**
 * Dashboard.jsx
 * Phase 5 — Session persistence + KV operation optimization
 * Phase 6b — 14-state workflow split (goldWorkflow + setWorkflow)
 *
 * KI011 (Phase 6c) — Per-symbol SET workflow dictionary
 * - setWorkflows: { "PTT.BK": EMPTY_WORKFLOW, "SCB.BK": EMPTY_WORKFLOW, ... }
 * - setOrderModes: { "PTT.BK": "manual", ... }
 * - Helpers: getSetBundle(sym), setSetBundle(sym, patch)
 * - SetMarket receives: setWorkflows (full dict), activeSetSymbol callback,
 *   and per-symbol derived props for the currently selected symbol
 * - Portfolio receives: setWorkflows dict (replaces single setBundle)
 * - Worker handleAIStrategy: passes symbol so response carries it back
 */

import { useState, useEffect, useCallback, useRef } from "react";
import GoldMarket from "./GoldMarket.jsx";
import SetMarket   from "./SetMarket.jsx";
import Portfolio   from "./Portfolio.jsx";
import D1Tab       from "./D1Tab.jsx";

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
  } catch { /* silent */ }
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
  { key: "d1",        label: "D1",        icon: "🗄" },
];

// A blank workflow slice for one symbol
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
  activeStrategy:      "off",
  autoExecute:         false,
  strategyDuration:    null,
  goldOrderMode:       "manual",
  setOrderModes:       {},
  setStrategySettings: {},
  gold:                { ...EMPTY_WORKFLOW },
  setWorkflows:        {},
};

// ── Helpers: read/write a single symbol's slice from the dict ─────────────────
function getSetBundle(setWorkflows, sym) {
  return setWorkflows[sym] || { ...EMPTY_WORKFLOW };
}

function patchSetBundle(setWorkflows, sym, patch) {
  return {
    ...setWorkflows,
    [sym]: { ...getSetBundle(setWorkflows, sym), ...patch },
  };
}

export default function Dashboard() {
  const [portfolio,     setPortfolio]     = useState(null);
  const [activeTab,     setActiveTab]     = useState("gold");
  const [enforceHours,  setEnforceHours]  = useState(true);
  const [showReset,     setShowReset]     = useState(false);
  const [bootstrapped,  setBootstrapped]  = useState(false);

  // ── Strategy state ────────────────────────────────────────────────────────
  const [activeStrategy,   setActiveStrategy]   = useState("off");
  const [autoExecute,      setAutoExecute]      = useState(false);
  const [strategyDuration, setStrategyDuration] = useState(null);

  // ── Gold workflow (unchanged) ─────────────────────────────────────────────
  const [goldWorkflow,          setGoldWorkflow]          = useState(null);
  const [goldStageStatuses,     setGoldStageStatuses]     = useState([]);
  const [goldActiveStageIdx,    setGoldActiveStageIdx]    = useState(0);
  const [goldConsecutiveRed,    setGoldConsecutiveRed]    = useState(0);
  const [goldWorkflowDone,      setGoldWorkflowDone]      = useState(false);
  const [goldFallbackTriggered, setGoldFallbackTriggered] = useState(false);
  const [goldStagePnl,          setGoldStagePnl]          = useState([]);
  const [goldOrderMode,         setGoldOrderMode]         = useState("manual");

  // ── KI011: SET workflow — per-symbol dict ────────────────────────────────
  // setWorkflows: { "PTT.BK": EMPTY_WORKFLOW, "SCB.BK": EMPTY_WORKFLOW, ... }
  const [setWorkflows,  setSetWorkflows]  = useState({});
  // setOrderModes: { "PTT.BK": "manual", ... }
  const [setOrderModes, setSetOrderModes] = useState({});
  // Per-symbol SET strategy settings { "PTT.BK": { activeStrategy, autoExecute, strategyDuration } }
  const [setStrategySettings, setSetStrategySettings] = useState({});
  // Track which symbol SetMarket currently has selected (so we can derive props)
  const [activeSetSymbol, setActiveSetSymbol] = useState("PTT.BK");
  const [userWatchlist,   setUserWatchlist]   = useState(config.data.set.watchlistDefault);

  // Derived: active symbol's workflow bundle
  const activeSetBundle   = getSetBundle(setWorkflows, activeSetSymbol);
  const goldWorkflowActive = !!goldWorkflow && !goldWorkflowDone;

  // ── Activity log ──────────────────────────────────────────────────────────
  const [activityEvents, setActivityEvents] = useState([]);
  const [logOldestTs,    setLogOldestTs]    = useState(null);
  const [logLoading,     setLogLoading]     = useState(false);
  const [logHasMore,     setLogHasMore]     = useState(true);

  const bootstrappedRef = useRef(false);

  // ── Load all state from KV on mount ──────────────────────────────────────
  useEffect(() => {
    async function load() {
      const [savedPortfolio, savedHours, savedBundle] = await Promise.all([
        kvGetPortfolio(),
        kvGetSetting(HOURS_KEY),
        kvGetSetting(BUNDLE_KEY),
      ]);

      if (savedPortfolio && (savedPortfolio.balance > 0 || savedPortfolio.startingBalance > 0)) {
        setPortfolio(savedPortfolio);
      }

      if (savedHours !== null) {
        setEnforceHours(savedHours === "true" || savedHours === true);
      }

      if (savedBundle && savedBundle !== "null") {
        try {
          const b = JSON.parse(savedBundle);
          if (b.activeStrategy !== undefined)    setActiveStrategy(b.activeStrategy);
          if (b.autoExecute !== undefined)        setAutoExecute(Boolean(b.autoExecute));
          if (b.strategyDuration !== undefined)   setStrategyDuration(b.strategyDuration ?? null);

          // Gold orderMode
          if (b.goldOrderMode)  setGoldOrderMode(b.goldOrderMode);

          // Gold workflow
          const g = b.gold || {};
          if (g.workflow)                        setGoldWorkflow(g.workflow);
          if (Array.isArray(g.stageStatuses))    setGoldStageStatuses(g.stageStatuses);
          if (g.activeStageIdx !== undefined)    setGoldActiveStageIdx(Number(g.activeStageIdx) || 0);
          if (g.consecutiveRed !== undefined)    setGoldConsecutiveRed(Number(g.consecutiveRed) || 0);
          if (g.workflowDone !== undefined)      setGoldWorkflowDone(Boolean(g.workflowDone));
          if (g.fallbackTriggered !== undefined) setGoldFallbackTriggered(Boolean(g.fallbackTriggered));
          if (Array.isArray(g.stagePnl))         setGoldStagePnl(g.stagePnl);

          // KI011: restore SET per-symbol dicts
          // Support old KV shape (b.set = single bundle) gracefully
          if (b.setWorkflows && typeof b.setWorkflows === "object") {
            setSetWorkflows(b.setWorkflows);
          } else if (b.set?.workflow) {
            // Migrate old single-bundle to dict under PTT.BK as fallback
            setSetWorkflows({ "PTT.BK": b.set });
          }

          if (b.setOrderModes && typeof b.setOrderModes === "object") {
            setSetOrderModes(b.setOrderModes);
          } else if (b.setOrderMode) {
            // Migrate old flat setOrderMode → apply to PTT.BK
            setSetOrderModes({ "PTT.BK": b.setOrderMode });
          }
            if (b.setStrategySettings && typeof b.setStrategySettings === "object") {
            setSetStrategySettings(b.setStrategySettings);
          }
          if (Array.isArray(b.userWatchlist)) {
            setUserWatchlist(b.userWatchlist);
          }
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
  useEffect(() => {
    if (!bootstrappedRef.current) return;
    kvSetSetting(BUNDLE_KEY, JSON.stringify({
      activeStrategy:   activeStrategy || "off",
      autoExecute,
      strategyDuration: strategyDuration ?? null,
      goldOrderMode,
      gold: {
        workflow:          goldWorkflow || null,
        stageStatuses:     goldStageStatuses,
        activeStageIdx:    goldActiveStageIdx,
        consecutiveRed:    goldConsecutiveRed,
        workflowDone:      goldWorkflowDone,
        fallbackTriggered: goldFallbackTriggered,
        stagePnl:          goldStagePnl,
      },
      // KI011: persist as dicts
      setWorkflows,
      setOrderModes,
      setStrategySettings,
      userWatchlist,
    }));
  }, [
    activeStrategy, autoExecute, strategyDuration, goldOrderMode,
    goldWorkflow, goldStageStatuses, goldActiveStageIdx, goldConsecutiveRed,
    goldWorkflowDone, goldFallbackTriggered, goldStagePnl,
    setWorkflows, setOrderModes, setStrategySettings, userWatchlist,
  ]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleBalanceConfirm = useCallback((amount) => {
    setPortfolio(createPortfolio(amount));
  }, []);

  const handleReset = useCallback(async (newAmount) => {
    setPortfolio(resetPortfolio(newAmount));
    setShowReset(false);
    setActiveStrategy("off");
    setAutoExecute(false);
  
    setStrategyDuration(null);
    // Clear gold
    setGoldWorkflow(null);
    setGoldStageStatuses([]);
    setGoldActiveStageIdx(0);
    setGoldConsecutiveRed(0);
    setGoldWorkflowDone(false);
    setGoldFallbackTriggered(false);
    setGoldStagePnl([]);
    setGoldOrderMode("manual");
    // Clear SET dicts
    setSetWorkflows({});
    setSetOrderModes({});
    setSetStrategySettings({});
    setUserWatchlist(config.data.set.watchlistDefault);
    setActivityEvents([]);
    await kvSetSetting(BUNDLE_KEY, JSON.stringify(EMPTY_BUNDLE));
  }, []);

  // AI strategy call — passes symbol so Worker can embed it in response
  const handleAIStrategy = useCallback(async ({ prompt, market, symbol, currentPrice, portfolio: summary }) => {
    const res = await fetch(WORKER_BASE + config.workers.routes.strategy, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ prompt, market, symbol, currentPrice, portfolio: summary }),
    });
    if (!res.ok) throw new Error(`Strategy Worker returned ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    return json.data;
  }, []);

  // Activity log
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

    d1PostLog(ev);

    setActivityEvents(prev => {
      const next = [...prev, ev];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

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
      setActivityEvents(prev => [...events, ...prev]);
      setLogOldestTs(older[older.length - 1]?.logged_at || null);
      setLogHasMore(older.length >= 50);
    } finally {
      setLogLoading(false);
    }
  }, [logLoading, logHasMore, logOldestTs]);

  // ── KI011: per-symbol SET workflow setter helpers passed to SetMarket ─────
  // SetMarket calls these with (sym, patch) to update one symbol's slice
  const handleSetWorkflowPatch = useCallback((sym, patch) => {
    setSetWorkflows(prev => patchSetBundle(prev, sym, patch));
  }, []);

  const handleSetOrderModeChange = useCallback((sym, mode) => {
    setSetOrderModes(prev => ({ ...prev, [sym]: mode }));
  }, []);

  const handleSetStrategyChange = useCallback((sym, patch) => {
    setSetStrategySettings(prev => ({ ...prev, [sym]: { ...(prev[sym] || {}), ...patch } }));
  }, []);

  const handleAddToWatchlist = useCallback((ticker) => {
    setUserWatchlist(prev => prev.includes(ticker) ? prev : [...prev, ticker]);
  }, []);

  const handleRemoveFromWatchlist = useCallback((ticker) => {
    setUserWatchlist(prev => prev.filter(t => t !== ticker));
  }, []);
  
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

  // Shared props identical for both markets
// Base props shared by both markets (strategy settings removed from here — Gold gets them directly, SET per-symbol)
  const commonMarketProps = {
    portfolio,
    setPortfolio,
    enforceHours,
    onAIStrategy:  handleAIStrategy,
    activityEvents,
    onActivityEvent:  handleActivityEvent,
    onLoadMoreLogs:   handleLoadMoreLogs,
    logLoading,
    logHasMore,
  };

  // Gold props — unchanged from Phase 6b
const goldMarketProps = {
    ...commonMarketProps,
    activeStrategy,
    onStrategyChange:         setActiveStrategy,
    autoExecute,
    onAutoExecuteChange:      setAutoExecute,
    strategyDuration,
    onStrategyDurationChange: setStrategyDuration,
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

  // KI011: SET props — pass full dicts + per-symbol helpers
  // SetMarket derives the active symbol's slice internally
  const setMarketProps = {
    ...commonMarketProps,
    setWorkflows,
    onSetWorkflowPatch:      handleSetWorkflowPatch,
    setOrderModes,
    onSetOrderModeChange:    handleSetOrderModeChange,
    setStrategySettings,
    onSetStrategyChange:      handleSetStrategyChange,
    onActiveSetSymbolChange:  setActiveSetSymbol,
    userWatchlist,
    onAddToWatchlist:         handleAddToWatchlist,
    onRemoveFromWatchlist:    handleRemoveFromWatchlist,
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
            activeStrategy={activeStrategy}
            strategyDuration={strategyDuration}
            setStrategySettings={setStrategySettings}
            goldBundle={{
              workflow:          goldWorkflow,
              stageStatuses:     goldStageStatuses,
              activeStageIdx:    goldActiveStageIdx,
              workflowDone:      goldWorkflowDone,
              fallbackTriggered: goldFallbackTriggered,
            }}
            setWorkflows={setWorkflows}
            activityEvents={activityEvents}
            onTabSwitch={setActiveTab}
          />
        )}
        {activeTab === "d1" && <D1Tab />}
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
