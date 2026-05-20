/**
 * portfolio-injector.js
 * Phase 6 — Battlefield data layer (v7)
 *
 * Changes from v6:
 * - fetchBattlefieldAdvisor: fixed response parser — Worker always returns
 *   a workflow JSON object. Now extracts reasoning + sentiment + key stage
 *   into readable 3-sentence text. Never shows raw JSON.
 * - computeUniqueLanes: adds lane.stageNodes[] for milestone markers
 *   Each node: { id, label, action, timeWindow, endMs, status }
 *   Portfolio.jsx uses endMs to position nodes on the Gantt bar.
 */

import config from "../../config.js";

const WORKER_BASE   = config.workers.base;
const WORKER_TRADES = WORKER_BASE + config.workers.routes.trades;
const WORKER_STRAT  = WORKER_BASE + config.workers.routes.strategy;

export const DAILY_GOAL = 500;

// ── Duration: stored as MINUTES (integer) ─────────────────────────────────────
function parseDurationMs(duration) {
  if (!duration) return null;
  const mins = parseFloat(duration);
  if (!isNaN(mins) && mins > 0) return mins * 60 * 1000;
  return null;
}

// ── Parse stage end date from timeWindow string ───────────────────────────────

export function parseLastStageEndDate(timeWindow) {
  if (!timeWindow || typeof timeWindow !== "string") return null;
  const tw = timeWindow.trim();

  // "May 21-22, 2026" → May 22 2026
  const rangeMatch = tw.match(/([A-Za-z]+)\s+(\d{1,2})-(\d{1,2}),?\s*(\d{4})/);
  if (rangeMatch) {
    const d = new Date(`${rangeMatch[1]} ${rangeMatch[3]}, ${rangeMatch[4]}`);
    if (!isNaN(d)) return d;
  }

  // "May 21, 2026" → single day
  const singleMatch = tw.match(/([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})/);
  if (singleMatch) {
    const d = new Date(singleMatch[0]);
    if (!isNaN(d)) return d;
  }

  // Intraday / "today" → end of today session (17:00 ICT = 10:00 UTC)
  if (/today|tonight|\d{1,2}:\d{2}/i.test(tw)) {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10, 0, 0));
  }

  return null;
}

export function getWorkflowEndDate(workflow) {
  if (!workflow?.stages?.length) return null;
  const reversed = [...workflow.stages].reverse();
  for (const stage of reversed) {
    const d = parseLastStageEndDate(stage.timeWindow);
    if (d) return d;
  }
  return null;
}

// ── Session clock helpers ─────────────────────────────────────────────────────

function getSessionWindow(market) {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  if (market === "gold") {
    return { start: Date.UTC(y, m, d, 2, 0, 0), end: Date.UTC(y, m, d, 10, 0, 0) };
  }
  return { start: Date.UTC(y, m, d, 3, 0, 0), end: Date.UTC(y, m, d, 10, 0, 0) };
}

function getSessionProgress(market) {
  const now = Date.now();
  const { start, end } = getSessionWindow(market);
  if (now <= start) return 0;
  if (now >= end)   return 1;
  return (now - start) / (end - start);
}

// ── Fetch D1 trade history ────────────────────────────────────────────────────

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

// ── Own scale ruler ───────────────────────────────────────────────────────────

export function computeSharedOwnRuler(lanes) {
  let earliestMs = null, latestMs = null;
  const now = Date.now();

  lanes.forEach(lane => {
    if (lane.ownScaleOpenMs) {
      if (!earliestMs || lane.ownScaleOpenMs < earliestMs) earliestMs = lane.ownScaleOpenMs;
    }
    if (lane.ownScaleEndMs) {
      if (!latestMs || lane.ownScaleEndMs > latestMs) latestMs = lane.ownScaleEndMs;
    }
  });

  if (!earliestMs || !latestMs || latestMs <= earliestMs) return null;

  const spanMs  = latestMs - earliestMs;
  const sameDay = spanMs < 24 * 3600 * 1000;

  lanes.forEach(lane => {
    const laneOpenMs = lane.ownScaleOpenMs || earliestMs;
    const laneEndMs  = lane.ownScaleEndMs  || latestMs;
    lane.ownScaleBarStart  = Math.max(0, (laneOpenMs - earliestMs) / spanMs);
    lane.ownScaleBarEnd    = Math.min(1, (laneEndMs  - earliestMs) / spanMs);
    lane.ownScaleNowPct    = Math.min(1, Math.max(0, (now - earliestMs) / spanMs));
    lane.ownScaleNowInSpan = now >= laneOpenMs && now <= laneEndMs;

    // Position each stage node within the shared span
    if (lane.stageNodes?.length) {
      lane.stageNodes = lane.stageNodes.map(node => ({
        ...node,
        pct: node.endMs
          ? Math.min(100, Math.max(0, Math.round(((node.endMs - earliestMs) / spanMs) * 100)))
          : null,
      }));
    }
  });

  const labels = [];
  for (let i = 0; i <= 4; i++) {
    const pct   = i / 4;
    const ms    = earliestMs + pct * spanMs;
    const d     = new Date(ms);
    const label = sameDay
      ? d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" })
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "Asia/Bangkok" });
    labels.push({ pct: Math.round(pct * 100), label });
  }
  return labels;
}

// ── One lane per unique symbol ────────────────────────────────────────────────

export function computeUniqueLanes(
  positions, activeStrategy, strategyDuration, goldBundle, setBundle,
) {
  if (!Array.isArray(positions) || positions.length === 0) return [];

  const map = {};
  positions.forEach(pos => {
    const sym = pos.symbol;
    if (!map[sym]) {
      map[sym] = {
        symbol: sym, market: pos.market,
        displayName: sym === "THAI_GOLD_BAHT" ? "Thai Gold" : sym.replace(".BK", ""),
        totalQty: 0, totalCost: 0, unrealisedPnL: 0,
        currentPrice: pos.currentPrice || pos.entryPrice,
        strategy: pos.strategy || "manual",
        oldestOpenedAt: pos.openedAt, positionCount: 0,
        stopLoss: pos.stopLoss, takeProfit: pos.takeProfit,
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

    const bundle = lane.market === "gold" ? goldBundle : setBundle;
    const wf     = bundle?.workflow;
    const wfDone = bundle?.workflowDone;
    const stageStatuses  = bundle?.stageStatuses || [];
    const activeStageIdx = bundle?.activeStageIdx || 0;
    const wfActive       = !!wf && !wfDone;

    // Protocol label
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
      lane.protocolDetail = durationMs ? `${Math.round(durationMs / 60000)}m window` : null;
      lane.hasWorkflow    = false;
    } else {
      lane.protocol       = lane.strategy !== "manual" ? lane.strategy : null;
      lane.protocolDetail = null;
      lane.hasWorkflow    = false;
    }

    // Shared clock progress
    lane.timeProgress = getSessionProgress(lane.market);

    // Own scale
    const openMs = lane.oldestOpenedAt ? new Date(lane.oldestOpenedAt).getTime() : now;
    lane.ownScaleOpenMs = openMs;
    if (wfActive) {
      const endDate = getWorkflowEndDate(wf);
      lane.ownScaleEndMs = endDate ? endDate.getTime() : openMs + (4 * 3600 * 1000);
    } else if (durationMs) {
      lane.ownScaleEndMs = openMs + durationMs;
    } else {
      lane.ownScaleEndMs = getSessionWindow(lane.market).end;
    }

    // ── Stage nodes for milestone markers ─────────────────────────────────────
    // Each node gets: id, label, action, timeWindow, endMs, status
    // pct is computed later in computeSharedOwnRuler() once span is known
    if (wfActive && wf.stages?.length) {
      lane.stageNodes = wf.stages.map((stage, idx) => {
        const endDate = parseLastStageEndDate(stage.timeWindow);
        const status  = stageStatuses[idx] || "pending";
        return {
          id:         stage.id || idx + 1,
          label:      stage.label || `S${idx + 1}`,
          action:     stage.action || "HOLD",
          timeWindow: stage.timeWindow || "",
          endMs:      endDate ? endDate.getTime() : null,
          status,                    // "pending" | "active" | "win" | "loss" | "skipped"
          isActive:   idx === activeStageIdx,
          pct:        null,          // filled by computeSharedOwnRuler
        };
      });
    } else {
      lane.stageNodes = [];
    }

    // Strategy expired
    const strategyExpired = !wfActive && durationMs ? (now - openMs) > durationMs : false;
    lane.strategyExpired = strategyExpired;

    // Plan status
    if (wfActive) {
      const hasLoss = stageStatuses.some(s => s === "loss");
      const allGood = stageStatuses.every(s => s === "win" || s === "pending" || s === "active");
      if (bundle?.fallbackTriggered) lane.planStatus = "at_risk";
      else if (hasLoss)              lane.planStatus = "late";
      else if (allGood)              lane.planStatus = "on_plan";
      else                           lane.planStatus = "late";
    } else if (strategyExpired) {
      lane.planStatus = "late";
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
    ma_crossover: "MA Crossover", rsi_reversion: "RSI Mean Reversion",
    breakout_volume: "Volume Breakout", golden_cross: "Golden / Death Cross",
    support_bounce: "Support / Resistance Bounce", off: null,
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

// ── AI battlefield advisor — fixed response parser ────────────────────────────

/**
 * The Worker /api/strategy ALWAYS returns a workflow JSON object:
 * { workflowName, sentiment, confidence, reasoning, stages[], ... }
 *
 * We extract the meaningful parts and format as readable 3-sentence advice.
 * Never show raw JSON.
 */
export async function fetchBattlefieldAdvisor({ portfolio, assetStats, goalProgress, goldBundle, setBundle, lanes }) {
  try {
    const balance  = portfolio?.balance || 0;
    const posCount = portfolio?.positions?.length || 0;

    const laneLines = (lanes || []).map(l =>
      `${l.displayName} (${l.market}): cost ฿${Math.round(l.totalCost).toLocaleString()} | open P&L ฿${Math.round(l.unrealisedPnL).toLocaleString()} | protocol: ${l.protocol || "none"} | status: ${l.planStatus}${l.hasWorkflow ? ` | stage: ${l.protocolDetail || "active"}` : ""}${l.strategyExpired ? " | ⚠️ expired" : ""}`
    ).join("\n");

    const statsLines = Object.values(assetStats || {}).map(s =>
      `${s.symbol}: ${s.tradeCount} trades | win ${s.winRate}% | total P&L ฿${Math.round(s.totalPnl)}`
    ).join("\n");

    const gp = goalProgress || { todayPnl: 0, goal: DAILY_GOAL, pct: 0 };
    const goldWfName = goldBundle?.workflow?.workflowName || goldBundle?.workflow?.name;
    const setWfName  = setBundle?.workflow?.workflowName  || setBundle?.workflow?.name;

    const prompt = `BATTLEFIELD ADVISOR — helicopter view of my whole portfolio.

LIVE POSITIONS:
${laneLines || "No open positions"}

HISTORICAL STATS:
${statsLines || "No history loaded"}

CASH: ฿${Math.round(balance).toLocaleString()} | GOAL: ฿${gp.goal}/day | Today P&L: ฿${gp.todayPnl} (${gp.pct}%)
GOLD WORKFLOW: ${goldWfName || "none"} | SET WORKFLOW: ${setWfName || "none"}

Respond in plain text — NO JSON. Give exactly 3 sentences:
1. What is earning and what is bleeding capital right now (use ฿ amounts)
2. The single biggest risk on this battlefield
3. One concrete counter-measure to execute immediately

Do not create a strategy workflow. Plain conversational text only.`;

    const res = await fetch(WORKER_STRAT, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt, market: "gold", symbol: "PORTFOLIO",
        currentPrice: 0, cashBalance: balance,
        openPositions: posCount, recentCloses: [],
      }),
    });

    const json = await res.json();
    if (!json.success) return `Worker error: ${json.error || "unknown"}`;

    const d = json.data;

    // Handle all possible Worker response shapes
    if (typeof d === "string" && d.trim().length > 0) return d.trim();
    if (d?.advice  && typeof d.advice  === "string") return d.advice.trim();
    if (d?.summary && typeof d.summary === "string") return d.summary.trim();

    // Worker returned a workflow object (most common case) — extract readable text
    if (d && typeof d === "object") {
      const parts = [];

      // Reasoning from the AI (2-3 sentences about market conditions)
      if (d.reasoning) parts.push(d.reasoning);

      // Sentiment + confidence
      if (d.sentiment && d.confidence) {
        const sentimentLine = `Overall outlook: ${d.sentiment} (${d.confidence} confidence).`;
        if (!d.reasoning) parts.push(sentimentLine);
      }

      // Key action from first active/pending stage
      if (d.stages?.length) {
        const activeStage = d.stages.find(s => s.action !== "HOLD") || d.stages[0];
        if (activeStage) {
          parts.push(
            `Suggested action: ${activeStage.action} — ${activeStage.label || ""}` +
            (activeStage.timeWindow ? ` (${activeStage.timeWindow})` : "") +
            (activeStage.note ? `. ${activeStage.note}` : "") + "."
          );
        }
      }

      // Fallback rule
      if (d.fallbackRule) parts.push(`Fallback: ${d.fallbackRule}`);

      if (parts.length > 0) return parts.join(" ");

      // Last resort — workflow name only
      if (d.workflowName) return `AI generated plan "${d.workflowName}". For full workflow execution, use AI Assist in Gold or SET tab.`;
    }

    return "AI advisor returned an unexpected response. Try asking again.";
  } catch (err) {
    return `AI advisor error: ${err.message}`;
  }
}
