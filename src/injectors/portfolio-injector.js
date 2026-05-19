/**
 * portfolio-injector.js
 * Phase 6 — Battlefield data layer
 *
 * Responsibilities:
 * - Fetch D1 trade history on demand (not on load — saves KV/D1 ops)
 * - Compute per-asset performance stats from closed trades
 * - Compute goal progress (฿500/day target)
 * - Provide AI battlefield advisor summary via /api/strategy
 *
 * Data flow:
 * - KV portfolio (positions, balance) → already loaded in Dashboard, passed as prop
 * - D1 trades → fetched only when user clicks "Load battlefield data"
 * - AI advisor → fetched only when user clicks "Get AI view"
 */

import config from "../../config.js";

const WORKER_BASE   = config.workers.base;
const WORKER_TRADES = WORKER_BASE + config.workers.routes.trades;
const WORKER_STRAT  = WORKER_BASE + config.workers.routes.strategy;

const DAILY_GOAL = 500; // ฿500/day target

// ── Fetch D1 trade history ────────────────────────────────────────────────────

/**
 * Fetch closed trades from D1 for a date range.
 * @param {string} from  ISO date string e.g. "2025-05-01"
 * @param {string} to    ISO date string e.g. "2025-05-19"
 * @returns {Array} raw trade rows
 */
export async function fetchTradeHistory(from, to) {
  try {
    const url = new URL(WORKER_TRADES);
    if (from) url.searchParams.set("from", from);
    if (to)   url.searchParams.set("to", to);
    url.searchParams.set("limit", "500");
    const res  = await fetch(url.toString());
    const json = await res.json();
    return json.success ? (json.data || []) : [];
  } catch {
    return [];
  }
}

// ── Per-asset performance stats ───────────────────────────────────────────────

/**
 * Given an array of D1 trade rows, compute per-symbol performance.
 * Returns a map: { "THAI_GOLD_BAHT": { ...stats }, "PTT.BK": { ...stats } }
 */
export function computeAssetStats(trades) {
  const map = {};

  trades.forEach(t => {
    const sym = t.symbol || "unknown";
    if (!map[sym]) {
      map[sym] = {
        symbol:       sym,
        market:       t.market || "unknown",
        tradeCount:   0,
        winCount:     0,
        lossCount:    0,
        totalPnl:     0,
        totalInvested: 0,
        bestTrade:    null,
        worstTrade:   null,
        strategies:   {},
        lastTradeAt:  null,
      };
    }

    const s = map[sym];
    const pnl = parseFloat(t.pnl || 0);
    const cost = parseFloat(t.total_cost || t.totalCost || 0);

    s.tradeCount++;
    s.totalPnl     += pnl;
    s.totalInvested = Math.max(s.totalInvested, cost); // peak capital used

    if (pnl > 0) {
      s.winCount++;
      if (!s.bestTrade || pnl > s.bestTrade.pnl) s.bestTrade = { pnl, ...t };
    } else if (pnl < 0) {
      s.lossCount++;
      if (!s.worstTrade || pnl < s.worstTrade.pnl) s.worstTrade = { pnl, ...t };
    }

    // Strategy breakdown
    const strat = t.strategy || "manual";
    if (!s.strategies[strat]) s.strategies[strat] = { count: 0, pnl: 0 };
    s.strategies[strat].count++;
    s.strategies[strat].pnl += pnl;

    const ts = t.closed_at || t.closedAt;
    if (ts && (!s.lastTradeAt || ts > s.lastTradeAt)) s.lastTradeAt = ts;
  });

  // Derive computed fields
  Object.values(map).forEach(s => {
    s.winRate       = s.tradeCount > 0 ? Math.round((s.winCount / s.tradeCount) * 100) : 0;
    s.returnRatio   = s.totalInvested > 0
      ? parseFloat((s.totalPnl / s.totalInvested * 100).toFixed(2))
      : 0;
    s.bestStrategy  = Object.entries(s.strategies)
      .sort((a, b) => b[1].pnl - a[1].pnl)[0]?.[0] || null;
    s.activeStrategies = Object.keys(s.strategies);
  });

  return map;
}

// ── Goal progress ─────────────────────────────────────────────────────────────

/**
 * Calculate today's P&L progress toward the ฿500/day goal.
 * Uses D1 trades closed today (ICT).
 */
export function computeGoalProgress(trades) {
  const nowIct = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const todayStr = nowIct.toISOString().slice(0, 10);

  const todayPnl = trades
    .filter(t => {
      const ts = t.closed_at || t.closedAt || "";
      return ts.startsWith(todayStr);
    })
    .reduce((sum, t) => sum + parseFloat(t.pnl || 0), 0);

  const pct = Math.min(100, Math.max(0, Math.round((todayPnl / DAILY_GOAL) * 100)));

  return {
    todayPnl:   Math.round(todayPnl),
    goal:       DAILY_GOAL,
    pct,
    status:     todayPnl >= DAILY_GOAL ? "achieved" : todayPnl > 0 ? "progress" : "behind",
  };
}

// ── Swim lane plan status ─────────────────────────────────────────────────────

/**
 * Determine plan status for a position in KV.
 * Returns "on_plan" | "late" | "at_risk" | "no_plan"
 */
export function getPlanStatus(position, assetStats) {
  if (!position) return "no_plan";
  const stats = assetStats?.[position.symbol];
  if (!stats) return "no_plan";

  if (stats.winRate >= 60 && stats.totalPnl > 0) return "on_plan";
  if (stats.winRate >= 40 || stats.totalPnl > 0)  return "late";
  if (stats.tradeCount > 0)                        return "at_risk";
  return "no_plan";
}

// ── AI battlefield advisor ────────────────────────────────────────────────────

/**
 * Ask AI for a helicopter-view summary of the battlefield.
 * Sends portfolio + stats to /api/strategy and returns plain text.
 */
export async function fetchBattlefieldAdvisor({ portfolio, assetStats, goalProgress, workflow }) {
  try {
    const prompt = buildAdvisorPrompt({ portfolio, assetStats, goalProgress, workflow });
    const res  = await fetch(WORKER_STRAT, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        market:  "portfolio",
        symbol:  "PORTFOLIO",
        price:   0,
        prompt,
        mode:    "battlefield_advisor",
      }),
    });
    const json = await res.json();
    // Response may be raw text or structured
    if (json.success && json.data) {
      const d = json.data;
      if (typeof d === "string") return d;
      if (d.advice)  return d.advice;
      if (d.message) return d.message;
      return JSON.stringify(d);
    }
    return "AI advisor unavailable — check Worker logs.";
  } catch {
    return "AI advisor unavailable — network error.";
  }
}

function buildAdvisorPrompt({ portfolio, assetStats, goalProgress, workflow }) {
  const positions = portfolio?.positions || [];
  const balance   = portfolio?.balance || 0;
  const posLines  = positions.map(p =>
    `${p.symbol}: ${p.qty} units @ ฿${p.entryPrice} | unrealised P&L: ฿${Math.round(p.unrealisedPnL || 0)}`
  ).join("\n");

  const statsLines = Object.values(assetStats || {}).map(s =>
    `${s.symbol}: ${s.tradeCount} trades | win rate ${s.winRate}% | total P&L ฿${Math.round(s.totalPnl)} | best strategy: ${s.bestStrategy || "none"}`
  ).join("\n");

  return `You are a helicopter-view trading advisor for a Thai paper trading simulator.

PORTFOLIO:
Cash balance: ฿${Math.round(balance).toLocaleString()}
Open positions:
${posLines || "None"}

PERFORMANCE STATS (from trade history):
${statsLines || "No history yet"}

GOAL: ฿${goalProgress.goal}/day | Today P&L: ฿${goalProgress.todayPnl} (${goalProgress.pct}% of goal)

${workflow ? `ACTIVE AI WORKFLOW: "${workflow.name || "unnamed"}" — ${workflow.stages?.length || 0} stages` : "No active AI workflow."}

Give a concise battlefield assessment in 3 sentences max:
1. What is working and what is bleeding capital
2. The single biggest risk right now
3. One concrete counter-measure to consider

Be direct. Use ฿ amounts. No fluff.`;
}
