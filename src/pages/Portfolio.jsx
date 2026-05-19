/**
 * Portfolio.jsx — The Battlefield v2
 * Phase 6
 *
 * Changes from v1:
 * - Zone 1: one swim lane per unique symbol (deduped from KV), shared clock timeline
 *           max 5 visible, collapse toggle, color band = plan status, shared/own scale toggle
 * - Zone 2: horizontal card scroll (not vertical grid), independent of Zone 1 filter
 * - Zone 3: multi-card drop, AI advisor using correct Worker payload via injector
 *
 * Props from Dashboard (sharedMarketProps + onTabSwitch):
 *   portfolio, workflow, activeStrategy, autoExecute, activityEvents,
 *   stageStatuses, activeStageIdx, workflowDone, onTabSwitch
 */

import { useState, useCallback, useRef } from "react";
import {
  computeUniqueLanes,
  computeAssetStats,
  computeGoalProgress,
  fetchTradeHistory,
  fetchBattlefieldAdvisor,
  DAILY_GOAL,
} from "../injectors/portfolio-injector.js";
import { calcPortfolioSummary } from "../core/portfolio-engine.js";

// ── Sort options (cards only) ─────────────────────────────────────────────────
const SORT_OPTIONS = [
  { key: "best_earn",   label: "Best earn" },
  { key: "most_invest", label: "Most invested" },
  { key: "most_missed", label: "Most missed" },
  { key: "at_risk",     label: "At risk" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function planColor(status) {
  return { on_plan: "#22c55e", late: "#f59e0b", at_risk: "#ef4444" }[status] || "#4b5563";
}
function planLabel(status) {
  return { on_plan: "on plan", late: "alert", at_risk: "risk" }[status] || "—";
}
function planBg(status) {
  return { on_plan: "rgba(34,197,94,0.12)", late: "rgba(245,158,11,0.12)", at_risk: "rgba(239,68,68,0.12)" }[status] || "rgba(75,85,99,0.12)";
}

function sortCards(cards, key) {
  return [...cards].sort((a, b) => {
    switch (key) {
      case "best_earn":   return (b.stats?.totalPnl || 0) - (a.stats?.totalPnl || 0);
      case "most_invest": return (b.totalCost || b.stats?.totalInvested || 0) - (a.totalCost || a.stats?.totalInvested || 0);
      case "most_missed": return (a.stats?.winRate ?? 100) - (b.stats?.winRate ?? 100);
      case "at_risk":     return (a.unrealisedPnL || 0) - (b.unrealisedPnL || 0);
      default:            return 0;
    }
  });
}

function fmt(n) { return Math.round(n).toLocaleString("en-US"); }
function fmtPnl(n) { return `${n >= 0 ? "+" : ""}฿${fmt(Math.abs(n))}`; }

// ── Dial Gauge ────────────────────────────────────────────────────────────────

function DialGauge({ pct, label, sublabel, color }) {
  const clamp  = Math.min(1, Math.max(0, pct));
  const angle  = -180 + clamp * 180;
  const r      = 20;
  const cx = 26, cy = 26;
  const toXY = deg => ({
    x: cx + r * Math.cos((deg * Math.PI) / 180),
    y: cy + r * Math.sin((deg * Math.PI) / 180),
  });
  const start = toXY(-180);
  const end   = toXY(angle);
  const large = clamp > 0.5 ? 1 : 0;

  return (
    <div className="bf2-gauge">
      <svg width="52" height="30" viewBox="0 0 52 30">
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3" strokeLinecap="round" />
        {clamp > 0 && (
          <path d={`M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`}
            fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" />
        )}
        <line x1={cx} y1={cy}
          x2={cx + 13 * Math.cos((angle * Math.PI) / 180)}
          y2={cy + 13 * Math.sin((angle * Math.PI) / 180)}
          stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="2" fill={color} />
      </svg>
      <span className="bf2-gauge-val" style={{ color }}>{label}</span>
      <span className="bf2-gauge-sub">{sublabel}</span>
    </div>
  );
}

// ── Asset Card (horizontal scroll item) ───────────────────────────────────────

function AssetCard({ lane, stats, isSelected, onSelect, onNavigate }) {
  const pnl     = Math.round(lane.unrealisedPnL || 0);
  const histPnl = Math.round(stats?.totalPnl || 0);
  const wr      = stats?.winRate ?? null;
  const rr      = stats?.returnRatio ?? null;
  const cost    = Math.round(lane.totalCost || 0);
  const isRisk  = lane.planStatus === "at_risk";

  return (
    <div
      className={`bf2-card ${isSelected ? "bf2-card-selected" : ""} ${isRisk ? "bf2-card-risk" : ""}`}
      onClick={() => onSelect(lane.symbol)}
      draggable
      onDragStart={e => { e.dataTransfer.setData("bf-symbol", lane.symbol); onSelect(lane.symbol); }}
    >
      <div className="bf2-card-top">
        <div>
          <span className="bf2-card-name">{lane.displayName}</span>
          <span className="bf2-card-mkt">{lane.market === "gold" ? "Gold" : "SET"}</span>
        </div>
        <span className="bf2-card-status" style={{ background: planBg(lane.planStatus), color: planColor(lane.planStatus) }}>
          {planLabel(lane.planStatus)}
        </span>
      </div>

      {lane.protocol && (
        <div className="bf2-card-proto">{lane.protocol}{lane.protocolDetail && ` · ${lane.protocolDetail}`}</div>
      )}

      <div className="bf2-gauges">
        <DialGauge
          pct={Math.abs(pnl) / Math.max(500, Math.abs(pnl) * 1.2)}
          label={fmtPnl(pnl)}
          sublabel="open P&L"
          color={pnl >= 0 ? "#22c55e" : "#ef4444"}
        />
        {wr !== null && (
          <DialGauge
            pct={wr / 100}
            label={`${wr}%`}
            sublabel="win rate"
            color={wr >= 60 ? "#22c55e" : wr >= 40 ? "#f59e0b" : "#ef4444"}
          />
        )}
        {rr !== null && (
          <DialGauge
            pct={Math.min(1, Math.abs(rr) / 10)}
            label={`${rr > 0 ? "+" : ""}${rr}%`}
            sublabel="return/inv"
            color={rr >= 0 ? "#60a5fa" : "#ef4444"}
          />
        )}
        {wr === null && (
          <div className="bf2-gauge bf2-gauge-empty">
            <span className="bf2-gauge-sub">load D1<br/>for stats</span>
          </div>
        )}
      </div>

      <div className="bf2-card-footer">
        <span className="bf2-card-cost">฿{fmt(cost)} invested</span>
        {stats && <span className="bf2-card-hist" style={{ color: histPnl >= 0 ? "#22c55e" : "#ef4444" }}>hist {fmtPnl(histPnl)}</span>}
      </div>

      <button className="bf2-card-nav" onClick={e => { e.stopPropagation(); onNavigate(lane.market); }}>
        Go to {lane.market === "gold" ? "Gold" : "SET"} →
      </button>
    </div>
  );
}

// ── Main Battlefield ──────────────────────────────────────────────────────────

export default function Portfolio({
  portfolio, workflow, activeStrategy, autoExecute,
  stageStatuses, activeStageIdx, workflowDone, activityEvents, onTabSwitch,
}) {
  const summary   = calcPortfolioSummary(portfolio);
  const positions = portfolio?.positions || [];

  // ── Zone 1 state ───────────────────────────────────────────────────────────
  const [lanesCollapsed, setLanesCollapsed] = useState(false);
  const [scaleMode,      setScaleMode]      = useState("shared"); // shared | own

  // ── Zone 2 state ───────────────────────────────────────────────────────────
  const [sortKey,      setSortKey]      = useState("best_earn");
  const [assetStats,   setAssetStats]   = useState({});
  const [goalProgress, setGoalProgress] = useState(null);
  const [d1Loaded,     setD1Loaded]     = useState(false);
  const [d1Loading,    setD1Loading]    = useState(false);
  const [d1Error,      setD1Error]      = useState(null);
  const [selectedSyms, setSelectedSyms] = useState(new Set()); // multi-select for act zone

  // ── Zone 3 state ───────────────────────────────────────────────────────────
  const [aiAdvice,   setAiAdvice]   = useState(null);
  const [aiLoading,  setAiLoading]  = useState(false);
  const [actPrompt,  setActPrompt]  = useState("");
  const [isDragOver, setIsDragOver] = useState(false);

  // ── Compute lanes (always from KV, no D1 needed) ──────────────────────────
  const lanes = computeUniqueLanes(
    positions, activeStrategy, workflow,
    stageStatuses || [], activeStageIdx || 0
  );

  // Shared clock: find the earliest openedAt across all lanes
  const earliest = lanes.reduce((min, l) => {
    if (!l.oldestOpenedAt) return min;
    return !min || l.oldestOpenedAt < min ? l.oldestOpenedAt : min;
  }, null);
  const sharedSpanMs = earliest ? Date.now() - new Date(earliest).getTime() : 4 * 3600 * 1000;
  const sharedMaxMs  = Math.max(sharedSpanMs, 4 * 3600 * 1000); // min 4 hr window

  // ── Build card items ───────────────────────────────────────────────────────
  const buildCards = () => {
    const cards = lanes.map(lane => ({
      ...lane,
      stats: assetStats[lane.symbol] || null,
    }));
    // Add D1-only symbols not in KV
    Object.values(assetStats).forEach(s => {
      if (!lanes.find(l => l.symbol === s.symbol)) {
        cards.push({
          symbol: s.symbol, displayName: s.symbol.replace(".BK", ""),
          market: s.market, planStatus: "no_plan",
          unrealisedPnL: 0, totalCost: 0, positionCount: 0,
          protocol: null, timeProgress: 0, stats: s,
        });
      }
    });
    return sortCards(cards, sortKey);
  };

  const cards = buildCards();

  // ── Load D1 stats ──────────────────────────────────────────────────────────
  const handleLoadD1 = useCallback(async () => {
    setD1Loading(true); setD1Error(null);
    try {
      const from  = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const rows  = await fetchTradeHistory(from, null);
      setAssetStats(computeAssetStats(rows));
      setGoalProgress(computeGoalProgress(rows));
      setD1Loaded(true);
    } catch { setD1Error("Failed to load D1 data"); }
    finally  { setD1Loading(false); }
  }, []);

  // ── Card selection ─────────────────────────────────────────────────────────
  const toggleSelect = sym => setSelectedSyms(prev => {
    const next = new Set(prev);
    next.has(sym) ? next.delete(sym) : next.add(sym);
    return next;
  });

  const selectedCards = cards.filter(c => selectedSyms.has(c.symbol));

  // ── AI advisor ─────────────────────────────────────────────────────────────
  const handleAiAdvisor = useCallback(async (extraPrompt = "") => {
    setAiLoading(true);
    try {
      const advice = await fetchBattlefieldAdvisor({
        portfolio, assetStats, goalProgress: goalProgress || { todayPnl: 0, goal: 500, pct: 0 },
        workflow, lanes: selectedCards.length > 0 ? selectedCards : lanes,
      });
      setAiAdvice(extraPrompt ? `[${extraPrompt}]\n${advice}` : advice);
    } finally { setAiLoading(false); }
  }, [portfolio, assetStats, goalProgress, workflow, lanes, selectedCards]);

  const handlePromptSend = () => {
    if (!actPrompt.trim()) return;
    handleAiAdvisor(actPrompt);
    setActPrompt("");
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const visibleLanes = lanesCollapsed ? [] : lanes.slice(0, 5);
  const hasMore      = lanes.length > 5;

  return (
    <div className="bf2-root">

      {/* ── Header ── */}
      <div className="bf2-header">
        <div className="bf2-header-left">
          <span className="bf2-title">The Battlefield</span>
          <span className="bf2-sub">Plan · Do · Check · Act</span>
        </div>
        <div className="bf2-header-right">
          {goalProgress ? (
            <div className="bf2-goal">
              <span className="bf2-goal-label">Today</span>
              <span className="bf2-goal-val" style={{ color: goalProgress.status === "achieved" ? "#22c55e" : goalProgress.todayPnl > 0 ? "#f59e0b" : "#ef4444" }}>
                ฿{fmt(goalProgress.todayPnl)} / ฿{goalProgress.goal}
              </span>
              <div className="bf2-goal-track"><div className="bf2-goal-fill" style={{ width: `${goalProgress.pct}%` }} /></div>
            </div>
          ) : (
            <button className="bf2-load-btn" onClick={handleLoadD1} disabled={d1Loading}>
              {d1Loading ? "Loading…" : "Load D1 stats"}
            </button>
          )}
          <span className="bf2-equity">Equity ฿{fmt(summary.totalEquity)}</span>
        </div>
      </div>

      {d1Error && <div className="bf2-error">{d1Error}</div>}

      {/* ══════════════════════
          ZONE 1 — PLAN LANES
      ══════════════════════ */}
      <section className="bf2-zone">
        <div className="bf2-zone-head">
          <span className="bf2-zone-icon">⟶</span>
          <span className="bf2-zone-label">Zone 1 — Plan</span>
          <span className="bf2-zone-sub">Shared clock · one lane per asset</span>
          <div className="bf2-lane-controls">
            <button
              className={`bf2-scale-btn ${scaleMode === "shared" ? "active" : ""}`}
              onClick={() => setScaleMode("shared")}
            >shared clock</button>
            <button
              className={`bf2-scale-btn ${scaleMode === "own" ? "active" : ""}`}
              onClick={() => setScaleMode("own")}
            >own scale</button>
            <button className="bf2-collapse-btn" onClick={() => setLanesCollapsed(v => !v)}>
              {lanesCollapsed ? "▼ show" : "▲ hide"}
            </button>
          </div>
        </div>

        {!lanesCollapsed && (
          <>
            {/* Shared clock header */}
            {scaleMode === "shared" && lanes.length > 0 && (
              <div className="bf2-timeline-header">
                <span className="bf2-tl-label">Now</span>
                <div className="bf2-tl-track">
                  <div className="bf2-tl-tick" style={{ left: "0%" }}>0h</div>
                  <div className="bf2-tl-tick" style={{ left: "25%" }}>1h</div>
                  <div className="bf2-tl-tick" style={{ left: "50%" }}>2h</div>
                  <div className="bf2-tl-tick" style={{ left: "75%" }}>3h</div>
                  <div className="bf2-tl-tick" style={{ left: "100%" }}>4h+</div>
                </div>
              </div>
            )}

            {lanes.length === 0 ? (
              <div className="bf2-empty-lane">No open positions — open a position to see swim lanes</div>
            ) : (
              <div className="bf2-lanes">
                {visibleLanes.map(lane => {
                  const progress = scaleMode === "own"
                    ? lane.timeProgress
                    : (lane.oldestOpenedAt
                        ? Math.min(1, (Date.now() - new Date(lane.oldestOpenedAt).getTime()) / sharedMaxMs)
                        : 0);
                  const fillPct  = Math.max(3, Math.round(progress * 100));
                  const col      = planColor(lane.planStatus);
                  const bg       = planBg(lane.planStatus);
                  const pnl      = Math.round(lane.unrealisedPnL);

                  return (
                    <div key={lane.symbol} className="bf2-lane">
                      <div className="bf2-lane-name">{lane.displayName}</div>
                      <div className="bf2-lane-track">
                        <div
                          className="bf2-lane-fill"
                          style={{ width: `${fillPct}%`, background: bg, borderRight: `2px solid ${col}` }}
                        >
                          <span className="bf2-lane-proto">
                            {lane.protocol || "manual"}
                            {lane.protocolDetail && ` · ${lane.protocolDetail}`}
                          </span>
                        </div>
                        {/* Pulse dot at the leading edge */}
                        <div className="bf2-lane-pulse" style={{ left: `${fillPct}%`, background: col }} />
                      </div>
                      <span className="bf2-lane-badge" style={{ background: bg, color: col }}>
                        {planLabel(lane.planStatus)}
                      </span>
                      <span className="bf2-lane-pnl" style={{ color: pnl >= 0 ? "#22c55e" : "#ef4444" }}>
                        {fmtPnl(pnl)}
                      </span>
                    </div>
                  );
                })}
                {hasMore && !lanesCollapsed && (
                  <div className="bf2-lanes-more">+{lanes.length - 5} more assets — see cards below</div>
                )}
              </div>
            )}

            {/* Legend */}
            <div className="bf2-lane-legend">
              <span className="bf2-leg-dot" style={{ background: "#22c55e" }} /> on plan
              <span className="bf2-leg-dot" style={{ background: "#f59e0b" }} /> alert
              <span className="bf2-leg-dot" style={{ background: "#ef4444" }} /> risk
              <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: "10px" }}>
                bar progress = time elapsed in current plan
              </span>
            </div>
          </>
        )}
      </section>

      {/* ══════════════════════════════
          ZONE 2 — CARDS (horizontal)
      ══════════════════════════════ */}
      <section className="bf2-zone bf2-cards-zone">
        <div className="bf2-zone-head">
          <span className="bf2-zone-icon">◉</span>
          <span className="bf2-zone-label">Zone 2 — Do + Check</span>
          <span className="bf2-zone-sub">
            {selectedSyms.size > 0 ? `${selectedSyms.size} selected — drag or click Act` : "Click to select · drag to Act zone"}
          </span>
          <div className="bf2-sort-row">
            <span className="bf2-sort-label">Sort:</span>
            {SORT_OPTIONS.map(o => (
              <button
                key={o.key}
                className={`bf2-sort-btn ${sortKey === o.key ? "active" : ""}`}
                onClick={() => setSortKey(o.key)}
              >{o.label}</button>
            ))}
          </div>
          {!d1Loaded && (
            <button className="bf2-load-btn" onClick={handleLoadD1} disabled={d1Loading} style={{ marginLeft: 8 }}>
              {d1Loading ? "…" : "Load D1 stats"}
            </button>
          )}
        </div>

        {cards.length === 0 ? (
          <div className="bf2-empty-cards">No positions or history — open a position or load D1 stats</div>
        ) : (
          <div className="bf2-cards-scroll">
            {cards.map(card => (
              <AssetCard
                key={card.symbol}
                lane={card}
                stats={card.stats}
                isSelected={selectedSyms.has(card.symbol)}
                onSelect={toggleSelect}
                onNavigate={mkt => onTabSwitch?.(mkt === "gold" ? "gold" : "set")}
              />
            ))}
          </div>
        )}
      </section>

      {/* ══════════════════════════════
          ZONE 3 — ACT (pinned bottom)
      ══════════════════════════════ */}
      <section
        className="bf2-zone bf2-act-zone"
        onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={e => {
          e.preventDefault();
          setIsDragOver(false);
          const sym = e.dataTransfer.getData("bf-symbol");
          if (sym) toggleSelect(sym);
        }}
      >
        <div className="bf2-zone-head">
          <span className="bf2-zone-icon">⚡</span>
          <span className="bf2-zone-label">Zone 3 — Act</span>
          <span className="bf2-zone-sub">Drop cards here · multi-select OK · prompt AI</span>
          <button className="bf2-ai-btn" onClick={() => handleAiAdvisor()} disabled={aiLoading}>
            {aiLoading ? "Thinking…" : "Get AI view ↗"}
          </button>
        </div>

        {/* Drop zone + selected cards */}
        <div className={`bf2-drop-zone ${isDragOver ? "bf2-drop-hover" : ""} ${selectedSyms.size > 0 ? "bf2-drop-has" : ""}`}>
          {selectedSyms.size === 0 ? (
            <span className="bf2-drop-hint">Drag cards here or click cards above to select</span>
          ) : (
            <div className="bf2-drop-chips">
              {[...selectedSyms].map(sym => {
                const card = cards.find(c => c.symbol === sym);
                const pnl  = Math.round(card?.unrealisedPnL || 0);
                return (
                  <div key={sym} className="bf2-chip">
                    <span className="bf2-chip-name">{card?.displayName || sym}</span>
                    <span className="bf2-chip-pnl" style={{ color: pnl >= 0 ? "#22c55e" : "#ef4444" }}>{fmtPnl(pnl)}</span>
                    <button className="bf2-chip-x" onClick={() => toggleSelect(sym)}>✕</button>
                  </div>
                );
              })}
              <button className="bf2-clear-all" onClick={() => setSelectedSyms(new Set())}>clear all</button>
            </div>
          )}
        </div>

        {/* AI advice output */}
        {aiAdvice && (
          <div className="bf2-ai-box">
            <div className="bf2-ai-head">
              <span className="bf2-ai-icon">◎</span>
              <span className="bf2-ai-title">Helicopter view</span>
              <button className="bf2-ai-x" onClick={() => setAiAdvice(null)}>✕</button>
            </div>
            <p className="bf2-ai-text">{aiAdvice}</p>
          </div>
        )}

        {/* Prompt row */}
        <div className="bf2-prompt-row">
          <input
            className="bf2-prompt-input"
            type="text"
            placeholder={selectedSyms.size > 0
              ? `Ask about ${[...selectedSyms].map(s => s.replace("THAI_GOLD_BAHT", "Gold").replace(".BK", "")).join(", ")}…`
              : "Ask AI about your battlefield…"}
            value={actPrompt}
            onChange={e => setActPrompt(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handlePromptSend()}
          />
          <button className="bf2-prompt-send" onClick={handlePromptSend} disabled={aiLoading || !actPrompt.trim()}>
            {aiLoading ? "…" : "Ask ↗"}
          </button>
        </div>

        {/* Nav shortcuts */}
        <div className="bf2-nav-row">
          <span className="bf2-nav-label">Navigate:</span>
          <button className="bf2-nav-btn" onClick={() => onTabSwitch?.("gold")}>Gold tab →</button>
          <button className="bf2-nav-btn" onClick={() => onTabSwitch?.("set")}>SET tab →</button>
        </div>
      </section>

    </div>
  );
}
