 /**
 * Portfolio.jsx — The Battlefield v8
 * Phase 6
 *
 * KI011 change:
 * - setBundle prop replaced with setWorkflows dict
 *   { "PTT.BK": { workflow, stageStatuses, ... }, "SCB.BK": {...}, ... }
 * - computeUniqueLanes and fetchBattlefieldAdvisor both receive setWorkflows dict
 */

import { useState, useCallback } from "react";
import {
  computeUniqueLanes,
  computeAssetStats,
  computeGoalProgress,
  fetchTradeHistory,
  fetchBattlefieldAdvisor,
  computeSharedOwnRuler,
  DAILY_GOAL,
} from "../injectors/portfolio-injector.js";
import { calcPortfolioSummary } from "../core/portfolio-engine.js";

const SORT_OPTIONS = [
  { key: "best_earn",   label: "Best earn" },
  { key: "most_invest", label: "Most invested" },
  { key: "most_missed", label: "Most missed" },
  { key: "at_risk",     label: "At risk" },
];

function planColor(s) {
  return { on_plan: "#22c55e", late: "#f59e0b", at_risk: "#ef4444" }[s] || "#4b5563";
}
function planLabel(s) {
  return { on_plan: "on plan", late: "alert", at_risk: "risk" }[s] || "—";
}
function planBg(s) {
  return {
    on_plan: "rgba(34,197,94,0.12)",
    late:    "rgba(245,158,11,0.12)",
    at_risk: "rgba(239,68,68,0.12)",
  }[s] || "rgba(75,85,99,0.12)";
}

function nodeColor(status, isActive) {
  if (isActive)           return "#f59e0b";
  if (status === "win")   return "#22c55e";
  if (status === "loss")  return "#ef4444";
  if (status === "skipped") return "#4b5563";
  return "#6b7280";
}

function sortCards(cards, key) {
  return [...cards].sort((a, b) => {
    switch (key) {
      case "best_earn":   return (b.stats?.totalPnl || 0) - (a.stats?.totalPnl || 0);
      case "most_invest": return (b.totalCost || b.stats?.totalInvested || 0) - (a.totalCost || a.stats?.totalInvested || 0);
      case "most_missed": return (a.stats?.winRate ?? 100) - (b.stats?.winRate ?? 100);
      case "at_risk":     return (a.unrealisedPnL || 0) - (b.unrealisedPnL || 0);
      default: return 0;
    }
  });
}
function fmt(n)    { return Math.round(n).toLocaleString("en-US"); }
function fmtPnl(n) { return `${n >= 0 ? "+" : ""}฿${fmt(Math.abs(n))}`; }

// ── Stage node tooltip ────────────────────────────────────────────────────────
function StageNode({ node, barHeight = 24 }) {
  const [hovered, setHovered] = useState(false);
  if (node.pct === null) return null;

  const col = nodeColor(node.status, node.isActive);

  return (
    <div
      style={{
        position:   "absolute",
        left:       `${node.pct}%`,
        top:        0,
        transform:  "translateX(-50%)",
        zIndex:     3,
        cursor:     "default",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{
        width:        9,
        height:       9,
        borderRadius: "50%",
        background:   col,
        border:       `1.5px solid ${node.isActive ? "#f59e0b" : "rgba(0,0,0,0.4)"}`,
        boxShadow:    node.isActive ? `0 0 6px 2px ${col}` : "none",
        animation:    node.isActive ? "bf2-pulse 1.6s ease-in-out infinite" : "none",
        marginTop:    -5,
      }} />

      <div style={{
        fontSize:   9,
        color:      col,
        textAlign:  "center",
        marginTop:  barHeight + 2,
        whiteSpace: "nowrap",
        position:   "absolute",
        left:       "50%",
        transform:  "translateX(-50%)",
        top:        -2,
      }}>
        S{node.id}
      </div>

      {hovered && (
        <div style={{
          position:   "absolute",
          bottom:     "calc(100% + 10px)",
          left:       "50%",
          transform:  "translateX(-50%)",
          background: "#1f2937",
          border:     "1px solid rgba(255,255,255,0.12)",
          borderRadius: 6,
          padding:    "6px 10px",
          minWidth:   140,
          zIndex:     20,
          pointerEvents: "none",
        }}>
          <div style={{ fontWeight: 600, fontSize: 11, color: col, marginBottom: 2 }}>S{node.id}: {node.label}</div>
          <div style={{ fontSize: 10, color: "#9ca3af" }}>{node.action} · {node.timeWindow || "—"}</div>
          <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>{node.status}</div>
        </div>
      )}
    </div>
  );
}

// ── Dial Gauge ────────────────────────────────────────────────────────────────
function DialGauge({ pct, label, sublabel, color }) {
  const clamp = Math.min(1, Math.max(0, pct));
  const angle = -180 + clamp * 180;
  const r = 20, cx = 26, cy = 26;
  const toXY = deg => ({ x: cx + r * Math.cos((deg * Math.PI) / 180), y: cy + r * Math.sin((deg * Math.PI) / 180) });
  const start = toXY(-180), end = toXY(angle);
  const large = clamp > 0.5 ? 1 : 0;
  return (
    <div className="bf2-gauge">
      <svg width="52" height="30" viewBox="0 0 52 30">
        <path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3" strokeLinecap="round" />
        {clamp > 0 && <path d={`M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" />}
        <line x1={cx} y1={cy} x2={cx+13*Math.cos((angle*Math.PI)/180)} y2={cy+13*Math.sin((angle*Math.PI)/180)} stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="2" fill={color} />
      </svg>
      <span className="bf2-gauge-val" style={{ color }}>{label}</span>
      <span className="bf2-gauge-sub">{sublabel}</span>
    </div>
  );
}

// ── Asset Card ────────────────────────────────────────────────────────────────
function AssetCard({ lane, stats, isSelected, onSelect, onDragStart, onNavigate }) {
  const pnl = Math.round(lane.unrealisedPnL || 0), histPnl = Math.round(stats?.totalPnl || 0);
  const wr = stats?.winRate ?? null, rr = stats?.returnRatio ?? null;
  const cost = Math.round(lane.totalCost || 0);
  return (
    <div className={`bf2-card ${isSelected?"bf2-card-selected":""} ${lane.planStatus==="at_risk"?"bf2-card-risk":""}`}
      onClick={() => onSelect(lane.symbol)} draggable
      onDragStart={e => { e.dataTransfer.setData("bf-symbol", lane.symbol); onDragStart(lane.symbol); }}>
      <div className="bf2-card-top">
        <div>
          <span className="bf2-card-name">{lane.displayName}</span>
          <span className="bf2-card-mkt">{lane.market === "gold" ? "Gold" : "SET"}</span>
        </div>
        <span className="bf2-card-status" style={{ background: planBg(lane.planStatus), color: planColor(lane.planStatus) }}>{planLabel(lane.planStatus)}</span>
      </div>
      {lane.protocol && (
        <div className="bf2-card-proto" style={{ color: lane.strategyExpired ? "#f59e0b" : undefined }}>
          {lane.strategyExpired ? "⏱ " : ""}{lane.protocol}{lane.protocolDetail && ` · ${lane.protocolDetail}`}{lane.strategyExpired && " — expired"}
        </div>
      )}
      <div className="bf2-gauges">
        <DialGauge pct={Math.abs(pnl)/Math.max(500,Math.abs(pnl)*1.5)} label={fmtPnl(pnl)} sublabel="open P&L" color={pnl>=0?"#22c55e":"#ef4444"} />
        {wr !== null
          ? <DialGauge pct={wr/100} label={`${wr}%`} sublabel="win rate" color={wr>=60?"#22c55e":wr>=40?"#f59e0b":"#ef4444"} />
          : <div className="bf2-gauge bf2-gauge-empty"><span className="bf2-gauge-sub" style={{textAlign:"center"}}>load D1<br/>for stats</span></div>}
        {rr !== null && <DialGauge pct={Math.min(1,Math.abs(rr)/10)} label={`${rr>0?"+":""}${rr}%`} sublabel="return/inv" color={rr>=0?"#60a5fa":"#ef4444"} />}
      </div>
      <div className="bf2-card-footer">
        <span className="bf2-card-cost">฿{fmt(cost)} invested</span>
        {stats && <span className="bf2-card-hist" style={{ color: histPnl>=0?"#22c55e":"#ef4444" }}>hist {fmtPnl(histPnl)}</span>}
        <button className="bf2-card-nav" onClick={e => { e.stopPropagation(); onNavigate?.(lane.market); }}>Go to tab →</button>
      </div>
    </div>
  );
}

// ── Main Battlefield ──────────────────────────────────────────────────────────
// KI011: setBundle replaced with setWorkflows dict
export default function Portfolio({
  portfolio, activeStrategy, strategyDuration,
  setStrategySettings,
  goldBundle, setWorkflows, activityEvents, onTabSwitch,
}) {
  const summary   = calcPortfolioSummary(portfolio);
  const positions = portfolio?.positions || [];

  const [lanesCollapsed, setLanesCollapsed] = useState(false);
  const [scaleMode,      setScaleMode]      = useState("shared");
  const [sortKey,        setSortKey]        = useState("best_earn");
  const [assetStats,     setAssetStats]     = useState({});
  const [goalProgress,   setGoalProgress]   = useState(null);
  const [d1Loaded,       setD1Loaded]       = useState(false);
  const [d1Loading,      setD1Loading]      = useState(false);
  const [d1Error,        setD1Error]        = useState(null);
  const [selectedSyms,   setSelectedSyms]   = useState(new Set());
  const [aiAdvice,       setAiAdvice]       = useState(null);
  const [aiLoading,      setAiLoading]      = useState(false);
  const [actPrompt,      setActPrompt]      = useState("");
  const [isDragOver,     setIsDragOver]     = useState(false);

  // KI011: pass setWorkflows dict (not single setBundle)
 const lanes = computeUniqueLanes(positions, activeStrategy, strategyDuration, setStrategySettings, goldBundle, setWorkflows);

  const buildCards = () => {
    const cards = lanes.map(lane => ({ ...lane, stats: assetStats[lane.symbol] || null }));
    Object.values(assetStats).forEach(s => {
      if (!lanes.find(l => l.symbol === s.symbol))
        cards.push({ symbol: s.symbol, displayName: s.symbol.replace(".BK",""), market: s.market,
          planStatus: "no_plan", unrealisedPnL: 0, totalCost: 0, positionCount: 0,
          protocol: null, timeProgress: 0, strategyExpired: false, stageNodes: [], stats: s });
    });
    return sortCards(cards, sortKey);
  };
  const cards = buildCards();

  const handleLoadD1 = useCallback(async () => {
    setD1Loading(true); setD1Error(null);
    try {
      const from = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const rows = await fetchTradeHistory(from, null);
      setAssetStats(computeAssetStats(rows));
      setGoalProgress(computeGoalProgress(rows));
      setD1Loaded(true);
    } catch { setD1Error("Failed to load D1 data."); }
    finally  { setD1Loading(false); }
  }, []);

  const toggleSelect   = sym => setSelectedSyms(prev => { const n = new Set(prev); n.has(sym) ? n.delete(sym) : n.add(sym); return n; });
  const forceAddSelect = sym => setSelectedSyms(prev => new Set([...prev, sym]));
  const selectedCards  = cards.filter(c => selectedSyms.has(c.symbol));

  // KI011: pass setWorkflows instead of setBundle
  const handleAiAdvisor = useCallback(async (extra = "") => {
    setAiLoading(true);
    try {
      const advice = await fetchBattlefieldAdvisor({
        portfolio, assetStats, goalProgress: goalProgress || { todayPnl: 0, goal: DAILY_GOAL, pct: 0 },
        goldBundle, setWorkflows, lanes: selectedCards.length > 0 ? selectedCards : lanes,
      });
      setAiAdvice(extra ? `[${extra}]\n\n${advice}` : advice);
    } finally { setAiLoading(false); }
  }, [portfolio, assetStats, goalProgress, goldBundle, setWorkflows, lanes, selectedCards]);

  const handlePromptSend = () => { if (!actPrompt.trim()) return; handleAiAdvisor(actPrompt); setActPrompt(""); };

  // ── Ruler prep ────────────────────────────────────────────────────────────
  const visibleLanes = lanesCollapsed ? [] : lanes.slice(0, 5);
  const hasMore      = lanes.length > 5;

  const ownRulerLabels = scaleMode === "own" ? computeSharedOwnRuler(visibleLanes) : null;

  const hasGold      = lanes.some(l => l.market === "gold");
  const sharedLabels = [hasGold?"09:00":"10:00","11:00","13:00","15:00","17:00"].map((label,i) => ({ pct: i*25, label }));
  const rulerLabels  = scaleMode === "own" ? (ownRulerLabels || sharedLabels) : sharedLabels;

  const BAR_HEIGHT = 24;

  return (
    <div className="bf2-root">

      <div className="bf2-header">
        <div className="bf2-header-left">
          <span className="bf2-title">The Battlefield</span>
          <span className="bf2-sub">Plan · Do · Check · Act</span>
        </div>
        <div className="bf2-header-right">
          {goalProgress ? (
            <div className="bf2-goal">
              <span className="bf2-goal-label">Today</span>
              <span className="bf2-goal-val" style={{ color: goalProgress.status==="achieved"?"#22c55e":goalProgress.todayPnl>0?"#f59e0b":"#ef4444" }}>
                ฿{fmt(goalProgress.todayPnl)} / ฿{goalProgress.goal}
              </span>
              <div className="bf2-goal-track"><div className="bf2-goal-fill" style={{ width:`${goalProgress.pct}%` }} /></div>
            </div>
          ) : (
            <button className="bf2-load-btn" onClick={handleLoadD1} disabled={d1Loading}>{d1Loading?"Loading…":"Load D1 stats"}</button>
          )}
          <span className="bf2-equity">Equity ฿{fmt(summary.totalEquity)}</span>
        </div>
      </div>

      {d1Error && <div className="bf2-error">{d1Error}</div>}

      {/* ══ ZONE 1 — PLAN ══ */}
      <section className="bf2-zone">
        <div className="bf2-zone-head">
          <span className="bf2-zone-icon">⟶</span>
          <span className="bf2-zone-label">Zone 1 — Plan</span>
          <span className="bf2-zone-sub">
            {scaleMode === "shared" ? "Session clock · 17:00 ICT = right edge" : "Own scale · full plan span · dot = now · nodes = stages"}
          </span>
          <div className="bf2-lane-controls">
            <button className={`bf2-scale-btn ${scaleMode==="shared"?"active":""}`} onClick={() => setScaleMode("shared")}>shared clock</button>
            <button className={`bf2-scale-btn ${scaleMode==="own"?"active":""}`} onClick={() => setScaleMode("own")}>own scale</button>
            <button className="bf2-collapse-btn" onClick={() => setLanesCollapsed(v => !v)}>{lanesCollapsed?"▼ show":"▲ hide"}</button>
          </div>
        </div>

        {!lanesCollapsed && (
          <>
            <div className="bf2-timeline-ruler">
              <div className="bf2-ruler-spacer" />
              <div className="bf2-ruler-track">
                {rulerLabels.map((item, i) => (
                  <span key={i} className="bf2-ruler-tick" style={{ left: `${item.pct}%` }}>{item.label}</span>
                ))}
              </div>
            </div>

            {lanes.length === 0 ? (
              <div className="bf2-empty-lane">No open positions</div>
            ) : (
              <div className="bf2-lanes">
                {visibleLanes.map(lane => {
                  const col = planColor(lane.planStatus);
                  const bg  = planBg(lane.planStatus);
                  const pnl = Math.round(lane.unrealisedPnL);
                  const nodes = lane.stageNodes || [];

                  if (scaleMode === "own") {
                    const barStartPct = Math.round((lane.ownScaleBarStart ?? 0) * 100);
                    const barEndPct   = Math.round((lane.ownScaleBarEnd   ?? 1) * 100);
                    const barWidthPct = Math.max(2, barEndPct - barStartPct);
                    const nowPct      = Math.round((lane.ownScaleNowPct   ?? 0) * 100);
                    const nowInBar    = lane.ownScaleNowInSpan;

                    return (
                      <div key={lane.symbol} className="bf2-lane" style={{ marginBottom: 18 }}>
                        <div className="bf2-lane-name">{lane.displayName}</div>
                        <div className="bf2-lane-track" style={{ position: "relative", overflow: "visible" }}>
                          <div style={{
                            position: "absolute", left: `${barStartPct}%`, width: `${barWidthPct}%`,
                            top: 0, bottom: 0, background: bg,
                            borderLeft: `2px solid ${col}`, borderRight: `2px solid ${col}`,
                            borderRadius: 3, display: "flex", alignItems: "center",
                            paddingLeft: 6, overflow: "hidden",
                          }}>
                            <span className="bf2-lane-proto" style={{ whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", fontSize: 9 }}>
                              {lane.protocol || "manual"}
                              {lane.protocolDetail && ` · ${lane.protocolDetail}`}
                              {lane.strategyExpired && " ⏱"}
                            </span>
                          </div>

                          {nodes.map(node => (
                            <StageNode key={node.id} node={node} barHeight={BAR_HEIGHT} />
                          ))}

                          <div className="bf2-lane-pulse" style={{
                            position: "absolute", left: `${nowPct}%`,
                            top: "50%", transform: "translateY(-50%) translateX(-50%)",
                            background: nowInBar ? col : "rgba(255,255,255,0.25)", zIndex: 2,
                          }} />
                        </div>
                        <span className="bf2-lane-badge" style={{ background: bg, color: col }}>{planLabel(lane.planStatus)}</span>
                        <span className="bf2-lane-pnl" style={{ color: pnl>=0?"#22c55e":"#ef4444" }}>{fmtPnl(pnl)}</span>
                      </div>
                    );
                  } else {
                    const fillPct = Math.max(3, Math.round(lane.timeProgress * 100));
                    return (
                      <div key={lane.symbol} className="bf2-lane">
                        <div className="bf2-lane-name">{lane.displayName}</div>
                        <div className="bf2-lane-track">
                          <div className="bf2-lane-fill" style={{ width:`${fillPct}%`, background: bg, borderRight:`2px solid ${col}` }}>
                            <span className="bf2-lane-proto">
                              {lane.protocol || "manual"}
                              {lane.protocolDetail && ` · ${lane.protocolDetail}`}
                              {lane.strategyExpired && " ⏱"}
                            </span>
                          </div>
                          <div className="bf2-lane-pulse" style={{ left:`${fillPct}%`, background: col }} />
                        </div>
                        <span className="bf2-lane-badge" style={{ background: bg, color: col }}>{planLabel(lane.planStatus)}</span>
                        <span className="bf2-lane-pnl" style={{ color: pnl>=0?"#22c55e":"#ef4444" }}>{fmtPnl(pnl)}</span>
                      </div>
                    );
                  }
                })}
                {hasMore && <div className="bf2-lanes-more">+{lanes.length - 5} more — see cards ↓</div>}
              </div>
            )}

            <div className="bf2-lane-legend">
              <span className="bf2-leg-dot" style={{ background:"#22c55e" }} /> on plan
              <span className="bf2-leg-dot" style={{ background:"#f59e0b" }} /> alert
              <span className="bf2-leg-dot" style={{ background:"#ef4444" }} /> risk
              {scaleMode === "own" && <>
                <span style={{ marginLeft: 8, color:"var(--text-muted)", fontSize: 10 }}>nodes = stage milestones · hover for detail · dot = now</span>
              </>}
            </div>
          </>
        )}
      </section>

      {/* ══ ZONE 2 — CARDS ══ */}
      <section className="bf2-zone bf2-cards-zone">
        <div className="bf2-zone-head">
          <span className="bf2-zone-icon">◉</span>
          <span className="bf2-zone-label">Zone 2 — Do + Check</span>
          <span className="bf2-zone-sub">{selectedSyms.size>0?`${selectedSyms.size} selected — drag or click Act ↓`:"Click to select · drag to Act zone"}</span>
          <div className="bf2-sort-row">
            <span className="bf2-sort-label">Sort:</span>
            {SORT_OPTIONS.map(o => (
              <button key={o.key} className={`bf2-sort-btn ${sortKey===o.key?"active":""}`} onClick={() => setSortKey(o.key)}>{o.label}</button>
            ))}
          </div>
          {!d1Loaded && <button className="bf2-load-btn" onClick={handleLoadD1} disabled={d1Loading} style={{marginLeft:6}}>{d1Loading?"…":"Load D1 stats"}</button>}
        </div>
        {cards.length === 0
          ? <div className="bf2-empty-cards">No positions or history</div>
          : <div className="bf2-cards-scroll">
              {cards.map(card => (
                <AssetCard key={card.symbol} lane={card} stats={card.stats}
                  isSelected={selectedSyms.has(card.symbol)}
                  onSelect={toggleSelect} onDragStart={forceAddSelect}
                  onNavigate={mkt => onTabSwitch?.(mkt==="gold"?"gold":"set")} />
              ))}
            </div>}
      </section>

      {/* ══ ZONE 3 — ACT ══ */}
      <section className="bf2-zone bf2-act-zone"
        onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={e => { e.preventDefault(); setIsDragOver(false); const sym=e.dataTransfer.getData("bf-symbol"); if(sym) forceAddSelect(sym); }}>
        <div className="bf2-zone-head">
          <span className="bf2-zone-icon">⚡</span>
          <span className="bf2-zone-label">Zone 3 — Act</span>
          <span className="bf2-zone-sub">Drop cards · multi-select · prompt AI</span>
          <button className="bf2-ai-btn" onClick={() => handleAiAdvisor()} disabled={aiLoading}>{aiLoading?"Thinking…":"Get AI view ↗"}</button>
        </div>

        <div className={`bf2-drop-zone ${isDragOver?"bf2-drop-hover":""} ${selectedSyms.size>0?"bf2-drop-has":""}`}>
          {selectedSyms.size === 0
            ? <span className="bf2-drop-hint">Drag cards here or click to select</span>
            : <div className="bf2-drop-chips">
                {[...selectedSyms].map(sym => {
                  const card = cards.find(c => c.symbol===sym);
                  const pnl  = Math.round(card?.unrealisedPnL||0);
                  return (
                    <div key={sym} className="bf2-chip">
                      <span className="bf2-chip-name">{card?.displayName||sym}</span>
                      <span className="bf2-chip-pnl" style={{ color:pnl>=0?"#22c55e":"#ef4444" }}>{fmtPnl(pnl)}</span>
                      <button className="bf2-chip-x" onClick={() => toggleSelect(sym)}>✕</button>
                    </div>
                  );
                })}
                <button className="bf2-clear-all" onClick={() => setSelectedSyms(new Set())}>clear all</button>
              </div>}
        </div>

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

        <div className="bf2-prompt-row">
          <input className="bf2-prompt-input" type="text"
            placeholder={selectedSyms.size>0
              ? `Ask about ${[...selectedSyms].map(s=>s.replace("THAI_GOLD_BAHT","Gold").replace(".BK","")).join(", ")}…`
              : "Ask AI about your battlefield…"}
            value={actPrompt} onChange={e => setActPrompt(e.target.value)}
            onKeyDown={e => e.key==="Enter" && handlePromptSend()} />
          <button className="bf2-prompt-send" onClick={handlePromptSend} disabled={aiLoading||!actPrompt.trim()}>{aiLoading?"…":"Ask ↗"}</button>
        </div>

        <div className="bf2-nav-row">
          <span className="bf2-nav-label">Navigate:</span>
          <button className="bf2-nav-btn" onClick={() => onTabSwitch?.("gold")}>Gold tab →</button>
          <button className="bf2-nav-btn" onClick={() => onTabSwitch?.("set")}>SET tab →</button>
        </div>
      </section>
    </div>
  );
}
