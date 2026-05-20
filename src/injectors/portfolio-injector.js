/**
 * portfolio-injector.js
 * Phase 6 — Battlefield data layer (v4)
 *
 * Key changes from v3:
 * - computeUniqueLanes now accepts BOTH market workflow bundles separately
 *   (goldBundle, setBundle) and picks the right one per lane.market
 * - strategyDuration is now used: plan status checks if strategy is
 *   still within its active time window (openedAt + duration > now)
 * - Expired strategy = "late" regardless of P&L
 * - AI workflow stage detail now shows stage label + time window from the stage itself
 */

import config from "../../config.js";

const WORKER_BASE   = config.workers.base;
const WORKER_TRADES = WORKER_BASE + config.workers.routes.trades;
const WORKER_STRAT  = WORKER_BASE + config.workers.routes.strategy;

export const DAILY_GOAL = 500;

// ── Strategy duration defaults (ms) ──────────────────────────────────────────
// Matches the duration options in StrategyPanel
const DURATION_MS = {
  "30m":  30 * 60 * 1000,
  "1h":    1 * 60 * 60 * 1000,
  "4h":    4 * 60 * 60 * 1000,
  "1d":   24 * 60 * 60 * 1000,
  "3d":   72 * 60 * 60 * 1000,
};

function parseDurationMs(duration) {
  if (!duration) return null;
  if (typeof duration === "number") return duration;
  return DURATION_MS[duration] || null;
}

// ── Session clock helpers ─────────────────────────────────────────────────────

function getSessionWindow(market) {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  if (market === "gold") {
    return {
      start: Date.UTC(y, m, d, 2, 0, 0),   // 09:00 ICT
      end:   Date.UTC(y, m, d, 10, 0, 0),  // 17:00 ICT
    };
  }
  return {
    start: Date.UTC(y, m, d, 3, 0, 0),    // 10:00 ICT
    end:   Date.UTC(y, m, d, 10, 0, 0),   // 17:00 ICT
  };
}

function getSessionProgress(market) {
  const now = Date.now();
  const { start, end } = getSessionWindow(market);
  if (now <= start) return 0;
  if (now >= end)   return 1;
  return (now - start) / (end - start);
}

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

// ── One lane per unique symbol ────────────────────────────────────────────────

/**
 * @param {Array}  positions        KV portfolio positions
 * @param {string} activeStrategy   preset key ("ma_crossover" etc)
 * @param {string|null} strategyDuration  "4h" | "1d" | etc
 * @param {object} goldBundle       { workflow, stageStatuses, activeStageIdx, workflowDone }
 * @param {object} setBundle        { workflow, stageStatuses, activeStageIdx, workflowDone }
 */
export function computeUniqueLanes(
  positions,
  activeStrategy,
  strategyDuration,
  goldBundle,
  setBundle,
) {
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
  const durationMs   = parseDurationMs(strategyDuration);
  const now          = Date.now();

  return Object.values(map).map(lane => {
    lane.avgEntry = lane.totalQty > 0 ? lane.totalCost / lane.totalQty : 0;

    // ── Pick correct workflow bundle for this lane's market ───────────────────
    const bundle = lane.market === "gold" ? goldBundle : setBundle;
    const wf     = bundle?.workflow;
    const wfDone = bundle?.workflowDone;
    const stageStatuses  = bundle?.stageStatuses || [];
    const activeStageIdx = bundle?.activeStageIdx || 0;

    const wfActive = !!wf && !wfDone;

    // ── Protocol label ────────────────────────────────────────────────────────
    if (wfActive) {
      const stage = wf.stages?.[activeStageIdx];
      lane.protocol       = `AI: ${wf.workflowName || wf.name || "workflow"}`;
      lane.protocolDetail = stage
        ? `S${activeStageIdx + 1}/${wf.stages.length} — ${stage.label || stage.action || ""}`
        + (stage.timeWindow ? ` · ${stage.timeWindow}` : "")
        : null;
      lane.hasWorkflow = true;
    } else if (activeStrategy && activeStrategy !== "off") {
      lane.protocol       = strategyName || activeStrategy;
      lane.protocolDetail = strategyDuration ? `${strategyDuration} window` : null;
      lane.hasWorkflow    = false;
    } else {
      lane.protocol       = lane.strategy !== "manual" ? lane.strategy : null;
      lane.protocolDetail = null;
      lane.hasWorkflow    = false;
    }

    // ── Timeline: session progress (shared clock, 17:00 ICT = right edge) ────
    lane.timeProgress = getSessionProgress(lane.market);

    // ── Strategy time window: is the strategy still active (not expired)? ─────
    let strategyExpired = false;
    if (!wfActive && durationMs && lane.oldestOpenedAt) {
      const openedMs = new Date(lane.oldestOpenedAt).getTime();
      strategyExpired = (now - openedMs) > durationMs;
    }
    lane.strategyExpired = strategyExpired;

    // ── Plan status ───────────────────────────────────────────────────────────
    // Priority:
    // 1. AI workflow active → use stage outcome state
    // 2. Strategy expired   → "late" (time bound passed, need to review)
    // 3. Near stop loss     → "at_risk"
    // 4. P&L positive       → "on_plan"
    // 5. Flat / tiny loss   → "late"
    // 6. Significant loss   → "at_risk"

    if (wfActive) {
      // Derive from stage statuses
      const hasLoss = stageStatuses.some(s => s === "loss");
      const allGood = stageStatuses.every(s => s === "win" || s === "pending" || s === "active");
      if (bundle?.fallbackTriggered) lane.planStatus = "at_risk";
      else if (hasLoss)              lane.planStatus = "late";
      else if (allGood)              lane.planStatus = "on_plan";
      else                           lane.planStatus = "late";
    } else if (strategyExpired) {
      lane.planStatus = "late"; // time bound passed — needs attention
    } else {
      const pnlPct = lane.totalCost > 0 ? lane.unrealisedPnL / lane.totalCost : 0;
      const price  = lane.currentPrice || lane.avgEntry;
      const slDist = lane.stopLoss   ? Math.abs(price - lane.stopLoss)   : null;
      const tpDist = lane.takeProfit ? Math.abs(lane.takeProfit - price) : null;
      const nearSL = slDist !== null && tpDist !== null && slDist < tpDist * 0.4;

      if (nearSL || pnlPct < -0.015) lane.planStatus = "at_risk";
      else if (pnlPct > 0.001)       lane.planStatus = "on_plan";
      else                           lane.planStatus = "late";
    }

    return lane;
  });
}

function getStrategyDisplayName(key) {
  const names = {
    ma_crossover:    "MA Crossover",
    rsi_reversion:   "RSI Mean Reversion",
    breakout_volume: "Volume Breakout",
    golden_cross:    "Golden / Death Cross",
    support_bounce:  "Support / Resistance Bounce",
    off:             null,
  };
  return names[key] || key;
}

// ── Per-asset stats from D1 ───────────────────────────────────────────────────

export function computeAssetStats(trades) {
  const map = {};
  trades.forEach(t => {
    const sym = t.symbol || "unknown";
    if (!map[sym]) map[sym] = {
      symbol: sym, market: t.market || "unknown",
      tradeCount: 0, winCount: 0, lossCount: 0,
      totalPnl: 0, totalInvested: 0, strategies: {}, lastTradeAt: null,
    };
    const s    = map[sym];
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
    s.winRate      = s.tradeCount > 0 ? Math.round((s.winCount / s.tradeCount) * 100) : 0;
    s.returnRatio  = s.totalInvested > 0 ? parseFloat((s.totalPnl / s.totalInvested * 100).toFixed(2)) : 0;
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

// ── AI battlefield advisor ────────────────────────────────────────────────────

export async function fetchBattlefieldAdvisor({ portfolio, assetStats, goalProgress, goldBundle, setBundle, lanes }) {
  try {
    const balance  = portfolio?.balance || 0;
    const posCount = portfolio?.positions?.length || 0;

    const laneLines = (lanes || []).map(l => {
      const wfInfo = l.hasWorkflow ? ` | workflow stage: ${l.protocolDetail || "active"}` : "";
      const expInfo = l.strategyExpired ? " | ⚠️ strategy expired" : "";
      return `${l.displayName} (${l.market}): cost ฿${Math.round(l.totalCost).toLocaleString()} | open P&L ฿${Math.round(l.unrealisedPnL).toLocaleString()} | protocol: ${l.protocol || "none"} | status: ${l.planStatus}${wfInfo}${expInfo}`;
    }).join("\n");

    const statsLines = Object.values(assetStats || {}).map(s =>
      `${s.symbol}: ${s.tradeCount} trades | win ${s.winRate}% | total P&L ฿${Math.round(s.totalPnl)}`
    ).join("\n");

    const gp = goalProgress || { todayPnl: 0, goal: DAILY_GOAL, pct: 0 };

    const goldWfName = goldBundle?.workflow?.workflowName || goldBundle?.workflow?.name;
    const setWfName  = setBundle?.workflow?.workflowName  || setBundle?.workflow?.name;

    const prompt = `BATTLEFIELD ADVISOR — helicopter view of my whole portfolio.

LIVE POSITIONS:
${laneLines || "No open positions"}

HISTORICAL STATS (D1):
${statsLines || "No trade history loaded"}

CASH: ฿${Math.round(balance).toLocaleString()}
DAILY GOAL: ฿${gp.goal} | Today P&L: ฿${gp.todayPnl} (${gp.pct}%)
GOLD WORKFLOW: ${goldWfName ? `"${goldWfName}" active` : "none"}
SET WORKFLOW:  ${setWfName  ? `"${setWfName}" active`  : "none"}

3-sentence helicopter assessment:
1. What is earning and what is bleeding capital right now
2. The single biggest risk on the battlefield
3. One concrete counter-measure to execute immediately

฿ amounts. No fluff. No preamble.`;

    const res = await fetch(WORKER_STRAT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        market: "gold", symbol: "PORTFOLIO",
        currentPrice: 0, cashBalance: balance,
        openPositions: posCount, recentCloses: [],
      }),
    });

    const json = await res.json();
    if (!json.success) return `Worker error: ${json.error || "unknown"}`;
    const d = json.data;
    if (typeof d === "string") return d;
    if (d?.advice)  return d.advice;
    if (d?.summary) return d.summary;
    if (d?.name && d?.stages)
      return `Strategy "${d.name}" generated (${d.stages.length} stages). Use AI Assist in Gold/SET tab. First: ${d.stages[0]?.label || d.stages[0]?.action || "—"}.`;
    return String(JSON.stringify(d)).slice(0, 400);
  } catch (err) {
    return `AI advisor error: ${err.message}`;
  }
}
