/**
 * Portfolio.jsx — The Battlefield
 * Phase 6 — Command center: Plan → Do → Check → Act
 *
 * Zone 1 — PLAN: Swim lanes, left-to-right goal progress per asset
 * Zone 2 — DO+CHECK: Asset cards with dial gauges, sortable
 * Zone 3 — ACT: Drag-drop or AI prompt → execute or navigate
 *
 * Data:
 * - KV portfolio (positions, balance) → received as prop from Dashboard (already loaded)
 * - D1 trade history → on-demand via "Load battlefield data" button
 * - AI advisor → on-demand via "Get AI view" button
 *
 * Props (all from Dashboard via sharedMarketProps):
 *   portfolio, workflow, activeStrategy, autoExecute, activityEvents
 */

import { useState, useCallback } from "react";
import {
  fetchTradeHistory,
  computeAssetStats,
  computeGoalProgress,
  getPlanStatus,
  fetchBattlefieldAdvisor,
} from "../injectors/portfolio-injector.js";
import { calcPortfolioSummary } from "../core/portfolio-engine.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const DAILY_GOAL = 500;

const SORT_OPTIONS = [
  { key: "best_earn",    label: "Best earn" },
  { key: "most_invest",  label: "Most invested" },
  { key: "most_missed",  label: "Most missed" },
  { key: "at_risk",      label: "At risk" },
];

const QUICK_DATE_RANGES = [
  { label: "Today",    days: 0 },
  { label: "7 days",   days: 7 },
  { label: "30 days",  days: 30 },
  { label: "All time", days: 365 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function toIsoDate(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

function planLabel(status) {
  const map = {
    on_plan:  "on plan",
    late:     "late",
    at_risk:  "at risk",
    no_plan:  "no plan",
  };
  return map[status] || "no plan";
}

function planColor(status) {
  const map = {
    on_plan: "bf-lane-green",
    late:    "bf-lane-amber",
    at_risk: "bf-lane-red",
    no_plan: "bf-lane-gray",
  };
  return map[status] || "bf-lane-gray";
}

function sortCards(cards, sortKey) {
  return [...cards].sort((a, b) => {
    switch (sortKey) {
      case "best_earn":   return (b.stats?.totalPnl || 0) - (a.stats?.totalPnl || 0);
      case "most_invest": return (b.stats?.totalInvested || 0) - (a.stats?.totalInvested || 0);
      case "most_missed": return (a.stats?.winRate || 0) - (b.stats?.winRate || 0);
      case "at_risk":     return (a.stats?.returnRatio || 0) - (b.stats?.returnRatio || 0);
      default:            return 0;
    }
  });
}

// ── Dial Gauge (SVG) ──────────────────────────────────────────────────────────

function DialGauge({ value, max, label, color = "#639922", danger = false }) {
  const pct    = Math.min(1, Math.max(0, Math.abs(value) / Math.max(1, Math.abs(max))));
  const angle  = -90 + pct * 180; // -90° = far left, +90° = far right
  const neg    = value < 0;
  const c      = danger ? "#e24b4a" : neg ? "#e24b4a" : color;

  return (
    <div className="bf-gauge-wrap">
      <svg width="52" height="30" viewBox="0 0 52 30">
        {/* Track arc */}
        <path
          d="M4 28 A22 22 0 0 1 48 28"
          fill="none"
          stroke="var(--color-border-tertiary)"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {/* Fill arc */}
        <path
          d={describeArc(26, 28, 22, -180, -180 + pct * 180)}
          fill="none"
          stroke={c}
          strokeWidth="3"
          strokeLinecap="round"
        />
        {/* Needle */}
        <line
          x1="26" y1="28"
          x2={26 + 14 * Math.cos((angle * Math.PI) / 180)}
          y2={28 + 14 * Math.sin((angle * Math.PI) / 180)}
          stroke={c}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <circle cx="26" cy="28" r="2" fill={c} />
      </svg>
      <span className="bf-gauge-val" style={{ color: neg || danger ? "#e24b4a" : "var(--color-text-primary)" }}>
        {label}
      </span>
      <span className="bf-gauge-lbl">{value < 0 && "▼"}{value > 0 && "▲"}</span>
    </div>
  );
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  const rad = a => (a * Math.PI) / 180;
  const x1 = cx + r * Math.cos(rad(startAngle));
  const y1 = cy + r * Math.sin(rad(startAngle));
  const x2 = cx + r * Math.cos(rad(endAngle));
  const y2 = cy + r * Math.sin(rad(endAngle));
  const large = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

// ── Asset Card ────────────────────────────────────────────────────────────────

function AssetCard({ item, onDragToAct, onNavigate }) {
  const { position, stats, planStatus } = item;
  const sym    = position?.symbol || stats?.symbol || "Unknown";
  const market = position?.market || stats?.market || "";
  const pnl    = Math.round(stats?.totalPnl || 0);
  const invest = Math.round(stats?.totalInvested || 0);
  const wr     = stats?.winRate || 0;
  const rr     = stats?.returnRatio || 0;
  const proto  = stats?.bestStrategy || (position?.strategy) || "none";
  const openPnl = Math.round(position?.unrealisedPnL || 0);
  const hasPos  = !!position;
  const isRisk  = planStatus === "at_risk";

  const displayName = sym === "THAI_GOLD_BAHT" ? "Thai Gold" : sym.replace(".BK", "");

  return (
    <div
      className={`bf-card ${isRisk ? "bf-card-risk" : ""}`}
      draggable
      onDragStart={e => {
        e.dataTransfer.setData("text/plain", sym);
        onDragToAct?.(item);
      }}
    >
      <div className="bf-card-header">
        <div>
          <span className="bf-card-name">{displayName}</span>
          <span className="bf-card-market">{market === "gold" ? "Gold" : "SET"}</span>
        </div>
        <span className={`bf-proto-badge ${proto === "none" ? "bf-proto-none" : ""}`}>
          {proto === "none" ? "no protocol" : proto.length > 16 ? proto.slice(0, 14) + "…" : proto}
        </span>
      </div>

      {/* Gauges */}
      <div className="bf-gauges">
        <DialGauge
          value={pnl}
          max={Math.max(500, Math.abs(pnl) * 1.5)}
          label={`฿${Math.abs(pnl) >= 1000 ? (pnl / 1000).toFixed(1) + "k" : pnl}`}
          danger={pnl < 0}
          color="#639922"
        />
        <DialGauge
          value={wr}
          max={100}
          label={`${wr}%`}
          color={wr >= 60 ? "#639922" : wr >= 40 ? "#ba7517" : "#e24b4a"}
        />
        <DialGauge
          value={rr}
          max={10}
          label={`${rr.toFixed(1)}%`}
          danger={rr < 0}
          color="#1d9e75"
        />
      </div>

      <div className="bf-gauge-labels">
        <span>P&L</span>
        <span>Win rate</span>
        <span>Return/inv</span>
      </div>

      {/* Progress bar: goal contribution */}
      <div className="bf-bar-row">
        <div className="bf-bar-bg">
          <div
            className="bf-bar-fill"
            style={{
              width: `${Math.min(100, Math.max(0, (pnl / DAILY_GOAL) * 100))}%`,
              background: pnl >= 0 ? "#639922" : "#e24b4a",
            }}
          />
        </div>
        <span className="bf-bar-label">goal {Math.round((pnl / DAILY_GOAL) * 100)}%</span>
      </div>

      {/* Open position info */}
      {hasPos && (
        <div className="bf-pos-line">
          <span className="bf-pos-dot" style={{ background: openPnl >= 0 ? "#639922" : "#e24b4a" }} />
          <span className="bf-pos-text">
            Open: {openPnl >= 0 ? "+" : ""}฿{openPnl.toLocaleString()}
          </span>
        </div>
      )}

      <div className="bf-card-actions">
        <button className="bf-card-btn" onClick={() => onDragToAct?.(item)}>
          Act
        </button>
        <button
          className="bf-card-btn bf-card-btn-ghost"
          onClick={() => onNavigate?.(market)}
        >
          Go to {market === "gold" ? "Gold" : "SET"} →
        </button>
      </div>
    </div>
  );
}

// ── Empty Asset Card ──────────────────────────────────────────────────────────

function EmptyAssetCard() {
  return (
    <div className="bf-card bf-card-empty">
      <span className="bf-empty-icon">＋</span>
      <span className="bf-empty-text">No other assets watching</span>
    </div>
  );
}

// ── Main Battlefield ──────────────────────────────────────────────────────────

export default function Portfolio({ portfolio, workflow, activeStrategy, activityEvents, onTabSwitch }) {
  // ── State ──────────────────────────────────────────────────────────────────
  const [trades,       setTrades]       = useState(null);   // null = not loaded yet
  const [assetStats,   setAssetStats]   = useState({});
  const [goalProgress, setGoalProgress] = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [loadError,    setLoadError]    = useState(null);
  const [dateRange,    setDateRange]    = useState(7);       // days back
  const [sortKey,      setSortKey]      = useState("best_earn");
  const [aiAdvice,     setAiAdvice]     = useState(null);
  const [aiLoading,    setAiLoading]    = useState(false);
  const [actItem,      setActItem]      = useState(null);    // card in act zone
  const [actPrompt,    setActPrompt]    = useState("");
  const [actSuggestions, setActSuggestions] = useState([]);

  const summary = calcPortfolioSummary(portfolio);
  const positions = portfolio?.positions || [];

  // ── Load D1 data ───────────────────────────────────────────────────────────
  const handleLoad = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const from   = dateRange === 365 ? null : toIsoDate(dateRange);
      const to     = toIsoDate(0);
      const rows   = await fetchTradeHistory(from, to);
      const stats  = computeAssetStats(rows);
      const goal   = computeGoalProgress(rows);
      setTrades(rows);
      setAssetStats(stats);
      setGoalProgress(goal);
    } catch {
      setLoadError("Failed to load trade history. Check Worker connection.");
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  // ── AI advisor ─────────────────────────────────────────────────────────────
  const handleAiAdvisor = useCallback(async () => {
    setAiLoading(true);
    try {
      const advice = await fetchBattlefieldAdvisor({
        portfolio,
        assetStats,
        goalProgress: goalProgress || { todayPnl: 0, goal: DAILY_GOAL, pct: 0 },
        workflow,
      });
      setAiAdvice(advice);
    } finally {
      setAiLoading(false);
    }
  }, [portfolio, assetStats, goalProgress, workflow]);

  // ── Build card items from positions + stats ────────────────────────────────
  const buildCards = () => {
    const seen = new Set();
    const cards = [];

    // Positions in KV
    positions.forEach(pos => {
      seen.add(pos.symbol);
      const stats      = assetStats[pos.symbol] || null;
      const planStatus = getPlanStatus(pos, assetStats);
      cards.push({ position: pos, stats, planStatus, symbol: pos.symbol });
    });

    // Symbols in D1 stats but no open position
    Object.values(assetStats).forEach(s => {
      if (!seen.has(s.symbol)) {
        cards.push({ position: null, stats: s, planStatus: "no_plan", symbol: s.symbol });
      }
    });

    return sortCards(cards, sortKey);
  };

  const cards = buildCards();

  // ── Act zone helpers ───────────────────────────────────────────────────────
  const handleDragOver = e => e.preventDefault();

  const handleDrop = e => {
    e.preventDefault();
    // actItem already set on dragStart
  };

  const handleActPrompt = async () => {
    if (!actPrompt.trim()) return;
    setAiLoading(true);
    const context = actItem
      ? `Asset: ${actItem.symbol} | P&L: ฿${Math.round(actItem.stats?.totalPnl || 0)} | Win rate: ${actItem.stats?.winRate || 0}% | Open P&L: ฿${Math.round(actItem.position?.unrealisedPnL || 0)}\n\nUser question: ${actPrompt}`
      : actPrompt;
    try {
      const advice = await fetchBattlefieldAdvisor({
        portfolio,
        assetStats,
        goalProgress: goalProgress || { todayPnl: 0, goal: DAILY_GOAL, pct: 0 },
        workflow,
      });
      setAiAdvice(`[${actItem?.symbol || "Portfolio"}] ${advice}`);
      // Quick action suggestions based on item
      if (actItem) {
        const s = actItem.stats;
        const suggestions = [];
        if (actItem.position) suggestions.push(`Sell all ${actItem.symbol.replace(".BK", "")}`);
        if (s?.winRate < 40)   suggestions.push(`Switch to MA Crossover`);
        if (actItem.position?.unrealisedPnL < -200) suggestions.push(`Tighten stop loss`);
        suggestions.push(`Go to ${actItem.position?.market === "gold" ? "Gold" : "SET"} tab →`);
        setActSuggestions(suggestions);
      }
    } finally {
      setAiLoading(false);
      setActPrompt("");
    }
  };

  const handleSuggestionClick = (suggestion) => {
    if (suggestion.includes("Gold tab") || suggestion.includes("gold")) {
      onTabSwitch?.("gold");
    } else if (suggestion.includes("SET tab") || suggestion.includes("SET")) {
      onTabSwitch?.("set");
    }
  };

  // ── Swim lane data ─────────────────────────────────────────────────────────
  const laneItems = cards.length > 0 ? cards : positions.map(p => ({
    position: p,
    stats: null,
    planStatus: "no_plan",
    symbol: p.symbol,
  }));

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="bf-root">

      {/* ── Header strip ── */}
      <div className="bf-header-strip">
        <div className="bf-header-left">
          <span className="bf-title">The Battlefield</span>
          <span className="bf-subtitle">Plan · Do · Check · Act</span>
        </div>
        <div className="bf-header-right">
          {goalProgress && (
            <div className="bf-goal-pill">
              <span className="bf-goal-label">Today</span>
              <span className={`bf-goal-val ${goalProgress.status === "achieved" ? "bf-goal-achieved" : goalProgress.todayPnl > 0 ? "bf-goal-progress" : "bf-goal-behind"}`}>
                ฿{goalProgress.todayPnl.toLocaleString()} / ฿{goalProgress.goal}
              </span>
              <div className="bf-goal-bar-bg">
                <div className="bf-goal-bar-fill" style={{ width: `${goalProgress.pct}%` }} />
              </div>
            </div>
          )}
          <span className="bf-equity-pill">
            Equity ฿{Math.round(summary.totalEquity).toLocaleString()}
          </span>
        </div>
      </div>

      {/* ── Load controls ── */}
      <div className="bf-load-bar">
        <span className="bf-load-label">D1 history:</span>
        {QUICK_DATE_RANGES.map(r => (
          <button
            key={r.label}
            className={`bf-range-btn ${dateRange === r.days ? "bf-range-active" : ""}`}
            onClick={() => setDateRange(r.days)}
          >
            {r.label}
          </button>
        ))}
        <button className="bf-load-btn" onClick={handleLoad} disabled={loading}>
          {loading ? "Loading…" : "Load battlefield data"}
        </button>
        {loadError && <span className="bf-load-error">{loadError}</span>}
        {trades !== null && !loading && (
          <span className="bf-load-ok">{trades.length} trades loaded</span>
        )}
      </div>

      {/* ══════════════════════════════════════════
          ZONE 1 — PLAN: Swim lanes
      ══════════════════════════════════════════ */}
      <section className="bf-zone">
        <div className="bf-zone-head">
          <span className="bf-zone-icon">⟶</span>
          <span className="bf-zone-label">Zone 1 — Plan</span>
          <span className="bf-zone-sub">Swim lanes · goal progress left to right</span>
        </div>

        {laneItems.length === 0 ? (
          <div className="bf-empty-lane">No open positions — load data or open a position</div>
        ) : (
          <div className="bf-lanes">
            {laneItems.map(item => {
              const sym   = item.symbol;
              const name  = sym === "THAI_GOLD_BAHT" ? "Thai Gold" : sym.replace(".BK", "");
              const ps    = item.planStatus;
              const pnl   = Math.round(item.stats?.totalPnl || 0);
              const pct   = Math.min(100, Math.max(4, Math.round(Math.max(0, pnl) / DAILY_GOAL * 100)));
              const strat = item.stats?.bestStrategy || item.position?.strategy || null;
              const wf    = workflow && item.position ? "AI workflow" : null;
              const proto = wf || strat;

              return (
                <div key={sym} className="bf-lane">
                  <div className="bf-lane-label">{name}</div>
                  <div className="bf-lane-track">
                    <div className={`bf-lane-fill ${planColor(ps)}`} style={{ width: `${pct}%` }}>
                      {proto && <span className="bf-lane-proto">{proto}</span>}
                    </div>
                  </div>
                  <span className={`bf-lane-badge ${planColor(ps)}`}>{planLabel(ps)}</span>
                  {item.position?.unrealisedPnL !== undefined && (
                    <span className="bf-lane-open">
                      open {item.position.unrealisedPnL >= 0 ? "+" : ""}฿{Math.round(item.position.unrealisedPnL).toLocaleString()}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Legend */}
        <div className="bf-lane-legend">
          <span className="bf-legend-dot bf-legend-green" /> on plan
          <span className="bf-legend-dot bf-legend-amber" /> late
          <span className="bf-legend-dot bf-legend-red"   /> at risk
          <span className="bf-legend-dot bf-legend-gray"  /> no plan
          <span className="bf-legend-note">Bar width = % of ฿{DAILY_GOAL}/day goal</span>
        </div>
      </section>

      {/* ══════════════════════════════════════════
          ZONE 2 — DO + CHECK: Asset cards
      ══════════════════════════════════════════ */}
      <section className="bf-zone">
        <div className="bf-zone-head">
          <span className="bf-zone-icon">◉</span>
          <span className="bf-zone-label">Zone 2 — Do + Check</span>
          <span className="bf-zone-sub">Asset cards · dial gauges</span>
          <div className="bf-sort-row">
            <span className="bf-sort-label">Sort:</span>
            {SORT_OPTIONS.map(o => (
              <button
                key={o.key}
                className={`bf-sort-btn ${sortKey === o.key ? "bf-sort-active" : ""}`}
                onClick={() => setSortKey(o.key)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {trades === null && positions.length === 0 ? (
          <div className="bf-empty-cards">Load battlefield data to see asset performance cards</div>
        ) : (
          <div className="bf-cards-grid">
            {cards.length > 0
              ? cards.map(item => (
                  <AssetCard
                    key={item.symbol}
                    item={item}
                    onDragToAct={setActItem}
                    onNavigate={market => onTabSwitch?.(market === "gold" ? "gold" : "set")}
                  />
                ))
              : positions.map(pos => (
                  <AssetCard
                    key={pos.symbol}
                    item={{ position: pos, stats: null, planStatus: "no_plan", symbol: pos.symbol }}
                    onDragToAct={setActItem}
                    onNavigate={market => onTabSwitch?.(market === "gold" ? "gold" : "set")}
                  />
                ))
            }
            {cards.length === 0 && positions.length === 0 && <EmptyAssetCard />}
          </div>
        )}
      </section>

      {/* ══════════════════════════════════════════
          ZONE 3 — ACT
      ══════════════════════════════════════════ */}
      <section className="bf-zone bf-act-zone">
        <div className="bf-zone-head">
          <span className="bf-zone-icon">⚡</span>
          <span className="bf-zone-label">Zone 3 — Act</span>
          <span className="bf-zone-sub">Drop a card or prompt AI · execute here or navigate</span>
          <button
            className="bf-ai-btn"
            onClick={handleAiAdvisor}
            disabled={aiLoading}
          >
            {aiLoading ? "Thinking…" : "Get AI view ↗"}
          </button>
        </div>

        {/* Drop target */}
        <div
          className={`bf-drop-target ${actItem ? "bf-drop-has-item" : ""}`}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragEnter={() => {}}
        >
          {actItem ? (
            <div className="bf-drop-item">
              <span className="bf-drop-sym">
                {actItem.symbol === "THAI_GOLD_BAHT" ? "Thai Gold" : actItem.symbol.replace(".BK", "")}
              </span>
              <span className="bf-drop-pnl" style={{ color: (actItem.stats?.totalPnl || 0) >= 0 ? "#639922" : "#e24b4a" }}>
                P&L ฿{Math.round(actItem.stats?.totalPnl || 0).toLocaleString()}
              </span>
              <span className="bf-drop-wr">Win rate {actItem.stats?.winRate || 0}%</span>
              <button className="bf-drop-clear" onClick={() => { setActItem(null); setActSuggestions([]); }}>✕</button>
            </div>
          ) : (
            <span className="bf-drop-hint">Drag an asset card here to act on it</span>
          )}
        </div>

        {/* AI advice display */}
        {aiAdvice && (
          <div className="bf-ai-advice">
            <div className="bf-ai-head">
              <span className="bf-ai-icon">◎</span>
              <span className="bf-ai-title">Helicopter view</span>
              <button className="bf-ai-clear" onClick={() => setAiAdvice(null)}>✕</button>
            </div>
            <p className="bf-ai-text">{aiAdvice}</p>
          </div>
        )}

        {/* Quick action suggestions */}
        {actSuggestions.length > 0 && (
          <div className="bf-suggestions">
            {actSuggestions.map((s, i) => (
              <button key={i} className="bf-suggest-btn" onClick={() => handleSuggestionClick(s)}>
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Prompt input */}
        <div className="bf-prompt-row">
          <input
            className="bf-prompt-input"
            type="text"
            placeholder={actItem
              ? `Ask about ${actItem.symbol === "THAI_GOLD_BAHT" ? "Thai Gold" : actItem.symbol.replace(".BK", "")}… e.g. what should I do?`
              : "Ask AI about your battlefield… e.g. which asset is draining capital?"}
            value={actPrompt}
            onChange={e => setActPrompt(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleActPrompt()}
          />
          <button
            className="bf-prompt-send"
            onClick={handleActPrompt}
            disabled={aiLoading || !actPrompt.trim()}
          >
            {aiLoading ? "…" : "Ask ↗"}
          </button>
        </div>

        {/* Navigate shortcuts */}
        <div className="bf-nav-shortcuts">
          <span className="bf-nav-label">Navigate:</span>
          <button className="bf-nav-btn" onClick={() => onTabSwitch?.("gold")}>Gold tab →</button>
          <button className="bf-nav-btn" onClick={() => onTabSwitch?.("set")}>SET tab →</button>
        </div>
      </section>

    </div>
  );
}
