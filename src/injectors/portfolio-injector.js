/**
 * portfolio-injector.js
 * Phase 6 — Battlefield data layer (v3)
 *
 * Changes from v2:
 * - computeUniqueLanes: timeProgress now uses TODAY'S SESSION as full width
 *   Gold: 09:00–17:00 ICT | SET: 10:00–17:00 ICT
 *   bar = (now - session start) / session duration → same shared clock for all assets
 * - All other logic unchanged
 */

import config from "../../config.js";

const WORKER_BASE   = config.workers.base;
const WORKER_TRADES = WORKER_BASE + config.workers.routes.trades;
const WORKER_STRAT  = WORKER_BASE + config.workers.routes.strategy;

export const DAILY_GOAL = 500;

// ── Session clock helpers ─────────────────────────────────────────────────────

/**
 * Returns today's session window in UTC ms for a given market.
 * Gold:  09:00–17:00 ICT = 02:00–10:00 UTC
 * SET:   10:00–17:00 ICT = 03:00–10:00 UTC
 */
function getSessionWindow(market) {
  const now    = new Date();
  const y      = now.getUTCFullYear();
  const m      = now.getUTCMonth();
  const d      = now.getUTCDate();

  if (market === "gold") {
    return {
      start: Date.UTC(y, m, d, 2, 0, 0),   // 09:00 ICT
      end:   Date.UTC(y, m, d, 10, 0, 0),  // 17:00 ICT
    };
  } else {
    // SET / MAI
    return {
      start: Date.UTC(y, m, d, 3, 0, 0),   // 10:00 ICT
      end:   Date.UTC(y, m, d, 10, 0, 0),  // 17:00 ICT
    };
  }
}

/**
 * Session progress: 0.0 (session not started) → 1.0 (session over).
 * Clamped 0–1. Both markets use same right edge (17:00 ICT).
 */
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
      lane.protocol       = `AI: ${workflow.name || "workflow"}`;
      lane.protocolDetail = stage ? `S${activeStageIdx + 1} — ${stage.label || stage.action || ""}` : null;
      lane.hasWorkflow    = true;
    } else if (activeStrategy && activeStrategy !== "off") {
      lane.protocol       = strategyName || activeStrategy;
      lane.protocolDetail = null;
      lane.hasWorkflow    = false;
    } else {
      lane.protocol       = lane.strategy !== "manual" ? lane.strategy : null;
      lane.protocolDetail = null;
      lane.hasWorkflow    = false;
    }

    // ── Timeline: fraction of TODAY'S SESSION elapsed ──────────────────────
    // Right edge = 17:00 ICT regardless of market.
    // Both Gold and SET share the same right edge so the shared clock is meaningful.
    // Bar shows "how far through today's session" — not how long position has been open.
    lane.timeProgress = getSessionProgress(lane.market);

    // ── Plan status: smarter logic ─────────────────────────────────────
    // 1. If price is closer to SL than to TP → at_risk
    // 2. If P&L is positive → on_plan
    // 3. If P&L is flat (< 0.1% move) → late (grace, not risk)
    // 4. If P&L is negative but within SL → late
    // 5. If P&L is very negative (> 1.5% loss) → at_risk
    const pnlPct    = lane.totalCost > 0 ? lane.unrealisedPnL / lane.totalCost : 0;
    const price     = lane.currentPrice || lane.avgEntry;
    const slDist    = lane.stopLoss   ? Math.abs(price - lane.stopLoss)   : null;
    const tpDist    = lane.takeProfit ? Math.abs(lane.takeProfit - price) : null;
    const nearSL    = slDist !== null && tpDist !== null && slDist < tpDist * 0.4;

    if (nearSL || pnlPct < -0.015)    lane.planStatus = "at_risk";
    else if (pnlPct > 0.001)          lane.planStatus = "on_plan";
    else                              lane.planStatus = "late"; // flat or tiny loss = alert, not red

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

    const prompt = `BATTLEFIELD ADVISOR — helicopter view of my whole portfolio.

LIVE POSITIONS (from KV):
${laneLines || "No open positions"}

HISTORICAL STATS (from D1 trades):
${statsLines || "No trade history loaded yet"}

CASH AVAILABLE: ฿${Math.round(balance).toLocaleString()}
DAILY GOAL: ฿${gp.goal} | Today realised P&L: ฿${gp.todayPnl} (${gp.pct}%)
ACTIVE WORKFLOW: ${workflow ? `"${workflow.name || "unnamed"}" — ${workflow.stages?.length || 0} stages` : "none"}

Give me a 3-sentence helicopter assessment:
1. What is earning and what is bleeding capital right now
2. The single biggest risk on this battlefield
3. One concrete counter-measure to act on immediately

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
    if (d?.name && d?.stages) {
      return `Strategy "${d.name}" generated (${d.stages.length} stages). ` +
        `For full execution use AI Assist in Gold/SET tab. ` +
        `First stage: ${d.stages[0]?.label || d.stages[0]?.action || "see workflow"}.`;
    }
    return String(JSON.stringify(d)).slice(0, 400);
  } catch (err) {
    return `AI advisor error: ${err.message}. Check Worker is deployed.`;
  }
}
