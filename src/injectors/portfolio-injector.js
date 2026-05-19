/**
 * portfolio-injector.js
 * Phase 6 — Battlefield data layer (v2)
 *
 * Fixed:
 * - fetchBattlefieldAdvisor now sends correct Worker payload
 * - computeUniqueLanes: one entry per unique symbol (not per position/trade)
 * - Timeline progress from position openedAt
 */

import config from "../../config.js";

const WORKER_BASE   = config.workers.base;
const WORKER_TRADES = WORKER_BASE + config.workers.routes.trades;
const WORKER_STRAT  = WORKER_BASE + config.workers.routes.strategy;

export const DAILY_GOAL = 500;

// ── Fetch D1 trade history (on-demand only) ───────────────────────────────────

export async function fetchTradeHistory(from, to) {
  try {
    const url = new URL(WORKER_TRADES);
    if (from) url.searchParams.set("from", from);
    if (to)   url.searchParams.set("to", to);
    url.searchParams.set("limit", "500");
    const res  = await fetch(url.toString());
    const json = await res.json();
    return json.success ? (json.data || []) : [];
  } catch { return []; }
}

// ── One lane per unique symbol from KV positions ──────────────────────────────

export function computeUniqueLanes(positions, activeStrategy, workflow, stageStatuses, activeStageIdx) {
  if (!Array.isArray(positions) || positions.length === 0) return [];

  const map = {};

  positions.forEach(pos => {
    const sym = pos.symbol;
    if (!map[sym]) {
      map[sym] = {
        symbol:         sym,
        market:         pos.market,
        displayName:    sym === "THAI_GOLD_BAHT" ? "Thai Gold" : sym.replace(".BK", ""),
        totalQty:       0,
        totalCost:      0,
        unrealisedPnL:  0,
        currentPrice:   pos.currentPrice || pos.entryPrice,
        strategy:       pos.strategy || "manual",
        oldestOpenedAt: pos.openedAt,
        positionCount:  0,
        stopLoss:       pos.stopLoss,
        takeProfit:     pos.takeProfit,
      };
    }
    const lane = map[sym];
    lane.totalQty      += pos.qty || 0;
    lane.totalCost     += pos.totalCost || 0;
    lane.unrealisedPnL += pos.unrealisedPnL || 0;
    lane.positionCount++;
    if (pos.openedAt && pos.openedAt < lane.oldestOpenedAt) lane.oldestOpenedAt = pos.openedAt;
    if (pos.strategy && pos.strategy !== "manual") lane.strategy = pos.strategy;
  });

  const strategyName = getStrategyDisplayName(activeStrategy);

  return Object.values(map).map(lane => {
    lane.avgEntry = lane.totalQty > 0 ? lane.totalCost / lane.totalQty : 0;

    // Protocol: AI workflow > preset > position strategy
    if (workflow && !workflow.done) {
      const stage = workflow.stages?.[activeStageIdx];
      lane.protocol      = `AI: ${workflow.name || "workflow"}`;
      lane.protocolDetail = stage ? `S${activeStageIdx + 1} — ${stage.label || stage.action || ""}` : null;
      lane.hasWorkflow   = true;
    } else if (activeStrategy && activeStrategy !== "off") {
      lane.protocol      = strategyName || activeStrategy;
      lane.protocolDetail = null;
      lane.hasWorkflow   = false;
    } else {
      lane.protocol      = lane.strategy !== "manual" ? lane.strategy : null;
      lane.protocolDetail = null;
      lane.hasWorkflow   = false;
    }

    // Timeline: ms open vs 4-hr expected hold
    const openMs     = lane.oldestOpenedAt ? Date.now() - new Date(lane.oldestOpenedAt).getTime() : 0;
    lane.timeProgress = Math.min(1, openMs / (4 * 60 * 60 * 1000));

    // Plan status from open P&L
    const pnlPct = lane.totalCost > 0 ? lane.unrealisedPnL / lane.totalCost : 0;
    if (pnlPct > 0.005)       lane.planStatus = "on_plan";
    else if (pnlPct >= 0)     lane.planStatus = "late";
    else                      lane.planStatus = "at_risk";

    return lane;
  });
}

function getStrategyDisplayName(key) {
  const names = {
    ma_crossover: "MA Crossover", rsi_reversion: "RSI Mean Reversion",
    breakout_volume: "Volume Breakout", golden_cross: "Golden / Death Cross",
    support_bounce: "Support / Resistance Bounce", off: null,
  };
  return names[key] || key;
}

// ── Per-asset stats from D1 trades ────────────────────────────────────────────

export function computeAssetStats(trades) {
  const map = {};
  trades.forEach(t => {
    const sym = t.symbol || "unknown";
    if (!map[sym]) map[sym] = {
      symbol: sym, market: t.market || "unknown",
      tradeCount: 0, winCount: 0, lossCount: 0,
      totalPnl: 0, totalInvested: 0, strategies: {}, lastTradeAt: null,
    };
    const s = map[sym];
    const pnl  = parseFloat(t.pnl || 0);
    const cost = parseFloat(t.total_cost || t.totalCost || 0);
    s.tradeCount++; s.totalPnl += pnl;
    s.totalInvested = Math.max(s.totalInvested, cost);
    if (pnl > 0) s.winCount++; else s.lossCount++;
    const strat = t.strategy || "manual";
    if (!s.strategies[strat]) s.strategies[strat] = { count: 0, pnl: 0 };
    s.strategies[strat].count++; s.strategies[strat].pnl += pnl;
    const ts = t.closed_at || t.closedAt;
    if (ts && (!s.lastTradeAt || ts > s.lastTradeAt)) s.lastTradeAt = ts;
  });
  Object.values(map).forEach(s => {
    s.winRate     = s.tradeCount > 0 ? Math.round((s.winCount / s.tradeCount) * 100) : 0;
    s.returnRatio = s.totalInvested > 0 ? parseFloat((s.totalPnl / s.totalInvested * 100).toFixed(2)) : 0;
    s.bestStrategy = Object.entries(s.strategies).sort((a, b) => b[1].pnl - a[1].pnl)[0]?.[0] || null;
  });
  return map;
}

// ── Goal progress ─────────────────────────────────────────────────────────────

export function computeGoalProgress(trades) {
  const todayStr = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const todayPnl = trades
    .filter(t => (t.closed_at || t.closedAt || "").startsWith(todayStr))
    .reduce((sum, t) => sum + parseFloat(t.pnl || 0), 0);
  const pct = Math.min(100, Math.max(0, Math.round((todayPnl / DAILY_GOAL) * 100)));
  return {
    todayPnl: Math.round(todayPnl), goal: DAILY_GOAL, pct,
    status: todayPnl >= DAILY_GOAL ? "achieved" : todayPnl > 0 ? "progress" : "behind",
  };
}

// ── AI battlefield advisor — correct Worker payload ───────────────────────────

export async function fetchBattlefieldAdvisor({ portfolio, assetStats, goalProgress, workflow, lanes }) {
  try {
    const balance  = portfolio?.balance || 0;
    const posCount = portfolio?.positions?.length || 0;

    const laneLines = (lanes || []).map(l =>
      `${l.displayName}: cost ฿${Math.round(l.totalCost).toLocaleString()} | open P&L ฿${Math.round(l.unrealisedPnL).toLocaleString()} | protocol: ${l.protocol || "none"} | status: ${l.planStatus}`
    ).join("\n");

    const statsLines = Object.values(assetStats || {}).map(s =>
      `${s.symbol}: ${s.tradeCount} trades | win ${s.winRate}% | total P&L ฿${Math.round(s.totalPnl)}`
    ).join("\n");

    const gp = goalProgress || { todayPnl: 0, goal: DAILY_GOAL, pct: 0 };

    // Build the prompt — sent as `prompt` field which Worker requires
    const prompt = `BATTLEFIELD ADVISOR — helicopter view of my whole portfolio.

LIVE POSITIONS (from KV):
${laneLines || "No open positions"}

HISTORICAL STATS (from D1 trades):
${statsLines || "No trade history loaded yet"}

CASH AVAILABLE: ฿${Math.round(balance).toLocaleString()}
DAILY GOAL: ฿${gp.goal} | Today realised P&L: ฿${gp.todayPnl} (${gp.pct}% of goal)
ACTIVE WORKFLOW: ${workflow ? `"${workflow.name || "unnamed"}" — ${workflow.stages?.length || 0} stages` : "none"}

Give me a 3-sentence helicopter assessment:
1. What is earning and what is bleeding capital right now
2. The single biggest risk on this battlefield
3. One concrete counter-measure I can execute immediately

Be specific with ฿ amounts. No fluff. No preamble.`;

    const res = await fetch(WORKER_STRAT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        market:        "gold",
        symbol:        "PORTFOLIO",
        currentPrice:  0,
        cashBalance:   balance,
        openPositions: posCount,
        recentCloses:  [],
      }),
    });

    const json = await res.json();
    if (!json.success) return `Worker error: ${json.error || "unknown"}`;

    const d = json.data;
    if (typeof d === "string") return d;
    if (d?.advice)  return d.advice;
    if (d?.summary) return d.summary;
    // Worker returned a workflow object — extract readable summary
    if (d?.name && d?.stages) {
      return `Strategy "${d.name}" generated (${d.stages.length} stages). ` +
        `For full execution, use AI Assist in the Gold or SET tab. ` +
        `Key: ${d.stages[0]?.label || d.stages[0]?.action || "see workflow"}.`;
    }
    return String(JSON.stringify(d)).slice(0, 400);
  } catch (err) {
    return `AI advisor connection error: ${err.message}. Check Worker is deployed.`;
  }
}
