/**
 * GoldMarket.jsx
 * Phase 6 redesign — bottom panel overhaul:
 *   - Removed Open/Closed tab row — replaced with Active / All Session toggle button
 *   - All Session shows closedTrades from portfolio memory (no D1 fetch)
 *   - Sell desk collapsed by default, expands on click
 *   - Activity log zone removed — replaced with single placeholder line
 */

import { useState, useCallback } from "react";
import ChartPanel    from "../components/ChartPanel.jsx";
import OrderPanel    from "../components/OrderPanel.jsx";
import StrategyPanel from "../components/StrategyPanel.jsx";
import Tooltip, { TooltipIcon } from "../components/Tooltip.jsx";
import { useGoldMarket } from "../injectors/gold-injector.js";
import { useFetchIntel }  from "../injectors/intel-injector.js";
import { calcPortfolioSummary, calcHourlyPnL, executeSellQty } from "../core/portfolio-engine.js";
import { makeActivityEvent } from "../components/ActivityLog.jsx";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell } from "recharts";
import config from "../../config.js";

const WORKER = config.workers.base;

async function logTradeToD1(trade) {
  try {
    await fetch(`${WORKER}/api/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trade),
    });
  } catch (e) {
    console.warn("D1 trade log failed (non-critical):", e.message);
  }
}

export default function GoldMarket({
  portfolio,
  setPortfolio,
  enforceHours,
  onAIStrategy,
  activeStrategy,
  onStrategyChange,
  autoExecute,
  onAutoExecuteChange,
  strategyDuration,
  onStrategyDurationChange,
  activityEvents,
  onActivityEvent,
  onLoadMoreLogs,
  logLoading,
  logHasMore,
  workflow, setWorkflow,
  stageStatuses, setStageStatuses,
  activeStageIdx, setActiveStageIdx,
  consecutiveRed, setConsecutiveRed,
  workflowDone, setWorkflowDone,
  fallbackTriggered, setFallbackTriggered,
  stagePnl, setStagePnl,
  aiWorkflowActive,
}) {
  const [activeSymbol,    setActiveSymbol]    = useState("THAI_GOLD_BAHT");
  const [timeframe,       setTimeframe]       = useState("1D");
  const [panel3Collapsed, setPanel3Collapsed] = useState(false);
  const [orderMode,       setOrderMode]       = useState("manual");
  const [sellQty,         setSellQty]         = useState("");

  // ── Positions view toggle (Active = open only | All Session = open + in-memory closed)
  const [posView, setPosView] = useState("active"); // "active" | "all"

  // ── Sell desk collapsed by default ───────────────────────────────────────────
  const [sellDeskOpen, setSellDeskOpen] = useState(false);

  // ── Intel hook ───────────────────────────────────────────────────────────────
  const fetchIntel = useFetchIntel();

  const {
    goldData, priceHistory, loading, error, partial,
    lastUpdated, historyLoading, marketOpen,
    handleBuy, handleSell,
  } = useGoldMarket({ portfolio, setPortfolio, enforceHours, timeframe });

  const summary       = calcPortfolioSummary(portfolio);
  const closedTrades  = Array.isArray(portfolio?.closedTrades) ? portfolio.closedTrades : [];
  const positions     = Array.isArray(portfolio?.positions)    ? portfolio.positions    : [];
  const hourlyPnL     = calcHourlyPnL(closedTrades.filter(t => t.market === "gold"));
  const goldPositions = positions.filter(p => p.market === "gold");

  // In-memory closed trades for this market (session only, no D1 fetch)
  const sessionClosed = closedTrades.filter(t => t.market === "gold");

  const currentPrice = activeSymbol === "THAI_GOLD_BAHT"
    ? goldData?.thaiGold?.price
    : goldData?.xauusd?.price;

  const priceCurrency = activeSymbol === "THAI_GOLD_BAHT" ? "THB" : "USD";
  const priceUnit     = activeSymbol === "THAI_GOLD_BAHT" ? "/ baht-weight" : "/ troy oz";

  function pushEvent(params) {
    onActivityEvent?.(makeActivityEvent({ market: "gold", ...params }));
  }

  const handleStrategyBuy = useCallback(async (order) => {
    const result = await handleBuy(order);
    if (result?.trade) {
      pushEvent({ type: "buy", symbol: order.symbol, price: order.price, detail: `${order.strategy || activeStrategy} × ${order.qty}` });
      logTradeToD1({ id: result.trade.id, symbol: order.symbol, market: "gold", side: "buy", qty: order.qty, entry_price: order.price, exit_price: null, pnl: null, strategy: order.strategy || activeStrategy, opened_at: new Date().toISOString(), closed_at: null, sim_mode: 1 });
    }
  }, [handleBuy, activeStrategy]);

  const handleStrategySell = useCallback(async (positionId, price) => {
    const goldPos = (portfolio?.positions || []).filter(p => p.market === "gold" && p.symbol === "THAI_GOLD_BAHT");
    const totalQty = goldPos.reduce((s, p) => s + p.qty, 0);
    if (totalQty === 0) return;
    const result = executeSellQty(portfolio, "gold", "THAI_GOLD_BAHT", totalQty, price || currentPrice);
    if (result.error) {
      pushEvent({ type: "block", symbol: "THAI_GOLD_BAHT", detail: `Strategy sell rejected: ${result.error}` });
      return;
    }
    setPortfolio(result.portfolio);
    const pnlSign = result.totalPnl >= 0 ? "+" : "";
    pushEvent({ type: "sell", symbol: "THAI_GOLD_BAHT", price: price || currentPrice, detail: `Strategy sold ${totalQty} baht FIFO | Avg entry ฿${Math.round(result.avgEntryPrice)?.toLocaleString()} | P&L: ${pnlSign}฿${Math.round(result.totalPnl)?.toLocaleString()}`, pnl: result.totalPnl });
    result.closedTrades.forEach(t => {
      logTradeToD1({ id: t.id, symbol: t.symbol, market: "gold", side: "sell", qty: t.qty, entry_price: t.entryPrice, exit_price: price || currentPrice, pnl: t.pnl, strategy: t.strategy || activeStrategy, opened_at: t.openedAt, closed_at: t.closedAt, sim_mode: 1 });
    });
  }, [handleSell, portfolio, currentPrice, activeStrategy]);

  function handleStrategyEvent(ev) {
    pushEvent({ ...ev, symbol: activeSymbol });
  }

  // ── Global Sell Desk (FIFO) ───────────────────────────────────────────────
  function handleSellDesk() {
    const qty = parseFloat(sellQty);
    if (!qty || qty <= 0) return;
    const price = currentPrice;
    if (!price) return;
    const result = executeSellQty(portfolio, "gold", "THAI_GOLD_BAHT", qty, price);
    if (result.error) {
      pushEvent({ type: "block", symbol: "THAI_GOLD_BAHT", detail: `Sell rejected: ${result.error}` });
      return;
    }
    setPortfolio(result.portfolio);
    const pnlSign = result.totalPnl >= 0 ? "+" : "";
    pushEvent({
      type:   "sell",
      symbol: "THAI_GOLD_BAHT",
      price,
      detail: `Sold ${qty} baht FIFO @ ฿${price?.toLocaleString("en-US",{maximumFractionDigits:0})} | Avg entry ฿${Math.round(result.avgEntryPrice)?.toLocaleString()} | P&L: ${pnlSign}฿${Math.round(result.totalPnl)?.toLocaleString()}`,
      pnl:    result.totalPnl,
    });
    result.closedTrades.forEach(t => {
      logTradeToD1({ id: t.id, symbol: t.symbol, market: "gold", side: "sell", qty: t.qty, entry_price: t.entryPrice, exit_price: price, pnl: t.pnl, strategy: t.strategy || "manual", opened_at: t.openedAt, closed_at: t.closedAt, sim_mode: 1 });
    });
    setSellQty("");
    setSellDeskOpen(false);
  }

  return (
    <div className="market-page gold-market">

      {/* ── Ticker Header ── */}
      <div className="ticker-header">
        <div className="symbol-tabs">
          {[
            { key: "THAI_GOLD_BAHT", label: "Thai Gold (บาท)", sublabel: "96.5% purity" },
            { key: "XAUUSD",         label: "XAUUSD",          sublabel: "spot USD" },
          ].map(({ key, label, sublabel }) => (
            <button key={key} className={`symbol-tab ${activeSymbol === key ? "active" : ""}`} onClick={() => setActiveSymbol(key)}>
              <span className="symbol-name">{label}</span>
              <span className="symbol-sub">{sublabel}</span>
            </button>
          ))}
        </div>

        <div className="price-display">
          {loading ? <span className="price-loading">Loading...</span>
          : error   ? <span className="price-error">⚠ {error}</span>
          : (
            <>
              <span className="price-main">{priceCurrency} {currentPrice?.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
              <span className="price-unit">{priceUnit}</span>
              {partial && <Tooltip content="One data source is unavailable. Price may be approximate."><span className="partial-warning">⚠ Partial data</span></Tooltip>}
            </>
          )}
        </div>

        <div className="ticker-meta">
          {goldData && (
            <>
              <span className="meta-item">USD/THB: <strong>{goldData.thbRate?.rate?.toFixed(2)}</strong></span>
              <span className="meta-item">Updated: <strong>{lastUpdated?.toLocaleTimeString()}</strong></span>
            </>
          )}
        </div>
      </div>

      {/* ── Main Body ── */}
      <div className="market-body">

        {/* Left column */}
        <div className="panel-left">

          <div className="panel-chart">
            {/* ── Chart Panel ── */}
            <ChartPanel
              data={priceHistory}
              symbol={activeSymbol}
              market="gold"
              timeframe={timeframe}
              historyLoading={historyLoading}
              onTimeframeChange={setTimeframe}
              onIntelRequest={(symbol, date) => fetchIntel(symbol, date, "gold")}
            />

            {hourlyPnL.length > 0 && (
              <div className="hourly-pnl">
                <div className="section-title">
                  Hourly P&L — Gold
                  <TooltipIcon content="Profit or loss from gold trades by hour." />
                </div>
                <ResponsiveContainer width="100%" height={80}>
                  <BarChart data={hourlyPnL} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                    <XAxis dataKey="hour" tick={{ fill: "#9ca3af", fontSize: 10 }} tickLine={false} />
                    <YAxis hide domain={["auto", "auto"]} />
                    <Bar dataKey="pnl" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                      {hourlyPnL.map((entry, i) => (
                        <Cell key={i} fill={entry.pnl >= 0 ? "#22c55e" : "#ef4444"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            <div className="market-info-bar" style={{ padding: 0, border: "none" }}>
              <Tooltip content="Thai gold price: XAUUSD × USD/THB × 96.5% purity, rounded ฿50.">
                <span className="info-item">ℹ Thai gold formula: XAUUSD × THB rate × 0.965</span>
              </Tooltip>
              <Tooltip content="Gold market open Mon–Fri 24 hours. Closed weekends.">
                <span className="info-item">⏰ Gold hours: Mon–Fri 24×5</span>
              </Tooltip>
              <Tooltip content="Min 1 baht-weight (15.244g at 96.5% purity). No commission.">
                <span className="info-item">📦 Min: 1 baht-weight | No commission</span>
              </Tooltip>
            </div>
          </div>

          {/* ── Panel Bottom — positions only ── */}
          <div className={`panel-bottom ${panel3Collapsed ? "collapsed" : ""}`}>
            <div className="panel3-header">
              <span className="panel3-title">
                Positions ({goldPositions.length})
                {posView === "all" && sessionClosed.length > 0 && (
                  <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> · {sessionClosed.length} closed this session</span>
                )}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {/* Active / All Session toggle */}
                <div className="pos-view-toggle">
                  <button
                    className={`pos-view-btn ${posView === "active" ? "active" : ""}`}
                    onClick={() => setPosView("active")}
                  >Active</button>
                  <button
                    className={`pos-view-btn ${posView === "all" ? "active" : ""}`}
                    onClick={() => setPosView("all")}
                  >All Session</button>
                </div>
                <button className="panel3-collapse-btn" onClick={() => setPanel3Collapsed(v => !v)}>
                  {panel3Collapsed ? "▲ Show" : "▼ Hide"}
                </button>
              </div>
            </div>

            {!panel3Collapsed && (
              <div className="panel-bottom-body panel-bottom-body--single">

                {/* ── Unified scrollable positions zone ── */}
                <div className="panel-bottom-zone positions-zone pz-unified">
                  {(() => {
                    // Build unified row list: open positions + (if All Session) closed trades
                    const openRows = goldPositions.map(pos => ({ ...pos, _rowType: "open" }));
                    const closedRows = posView === "all"
                      ? sessionClosed.map(t => ({ ...t, _rowType: "closed" }))
                      : [];
                    const allRows = [...openRows, ...closedRows];

                    if (allRows.length === 0) {
                      return (
                        <div className="empty-state">
                          {posView === "active" ? "No open positions." : "No trades this session."}
                        </div>
                      );
                    }
                    return (
                      <div className="positions-table positions-table--10col">
                        {/* 10-column header */}
                        <div className="pos-row pos-row--10col header">
                          <span>Symbol</span><span>Qty</span><span>Entry</span><span>Price</span>
                          <span>P&L</span><span>P&L%</span><span>Stop</span><span>Target</span>
                          <span>Strategy</span><span>Status</span>
                        </div>
                        {allRows.map((row, i) => {
                          if (row._rowType === "open") {
                            const pnlUp = row.unrealisedPnL >= 0;
                            return (
                              <div key={row.id || i} className="pos-row pos-row--10col">
                                <span className="pos-symbol">{row.symbol}</span>
                                <span>{row.qty}</span>
                                <span>฿{row.entryPrice?.toLocaleString()}</span>
                                <span>฿{row.currentPrice?.toLocaleString()}</span>
                                <span className={pnlUp ? "pnl-up" : "pnl-down"}>
                                  {pnlUp ? "+" : ""}฿{row.unrealisedPnL?.toLocaleString("en-US", { minimumFractionDigits: 0 })}
                                </span>
                                <span className={pnlUp ? "pnl-up" : "pnl-down"}>
                                  {pnlUp ? "+" : ""}{row.unrealisedPnLPct?.toFixed(2)}%
                                </span>
                                <span className="pos-stop">{row.stopLoss   ? `฿${row.stopLoss}`   : "—"}</span>
                                <span className="pos-tp">  {row.takeProfit ? `฿${row.takeProfit}` : "—"}</span>
                                <span className="pos-strategy">{row.strategy !== "manual" ? `🤖 ${row.strategy}` : "—"}</span>
                                <span className="pos-status pos-status--active">ACTIVE</span>
                              </div>
                            );
                          } else {
                            // closed trade row
                            const pnlUp = (row.pnl ?? 0) >= 0;
                            return (
                              <div key={row.id || i} className="pos-row pos-row--10col pos-row--closed">
                                <span className="pos-symbol">{row.symbol}</span>
                                <span>{row.qty}</span>
                                <span>฿{Math.round(row.entryPrice)?.toLocaleString()}</span>
                                <span>{row.exitPrice ? `฿${Math.round(row.exitPrice)?.toLocaleString()}` : "—"}</span>
                                <span className={pnlUp ? "pnl-up" : "pnl-down"}>
                                  {row.pnl != null ? `${pnlUp ? "+" : ""}฿${Math.round(row.pnl)?.toLocaleString()}` : "—"}
                                </span>
                                <span className={pnlUp ? "pnl-up" : "pnl-down"}>—</span>
                                <span>—</span>
                                <span>—</span>
                                <span className="pos-strategy">{row.strategy !== "manual" ? `🤖 ${row.strategy}` : "—"}</span>
                                <span className="pos-status pos-status--closed">CLOSED</span>
                              </div>
                            );
                          }
                        })}
                      </div>
                    );
                  })()}
                </div>

                {/* ── Sell Desk — always pinned below scroll zone, never inside it ── */}
                {(() => {
                  const totalHeld = goldPositions.reduce((s, p) => s + p.qty, 0);
                  const totalCost = goldPositions.reduce((s, p) => s + p.totalCost, 0);
                  const avgEntry  = totalHeld > 0 ? totalCost / totalHeld : 0;
                  const price     = currentPrice || 0;
                  const totalPnl  = goldPositions.reduce((s, p) => s + p.unrealisedPnL, 0);
                  const sellN     = parseFloat(sellQty) || 0;
                  const estPnl    = sellN > 0 ? (price - avgEntry) * sellN : null;
                  const pnlUp     = (estPnl ?? 0) >= 0;
                  const pnlColor  = totalPnl >= 0 ? "pnl-up" : "pnl-down";
                  return (
                    <div className="sell-desk sell-desk--collapsible sell-desk--pinned">
                      {/* Summary line — always visible, springs upward on expand */}
                      <button
                        className="sell-desk-summary-line"
                        onClick={() => setSellDeskOpen(v => !v)}
                      >
                        <span className="sdsl-symbol">THAI GOLD</span>
                        <span className="sdsl-sep">—</span>
                        <span className="sdsl-qty"><strong>{totalHeld}</strong> baht-wt</span>
                        <span className="sdsl-sep">|</span>
                        <span className="sdsl-avg">Avg ฿{totalHeld > 0 ? Math.round(avgEntry)?.toLocaleString() : "—"}</span>
                        <span className="sdsl-sep">|</span>
                        <span className={`sdsl-pnl ${pnlColor}`}>
                          P&L: {totalPnl >= 0 ? "+" : ""}฿{Math.round(totalPnl)?.toLocaleString()}
                        </span>
                        <span className="sdsl-cta">{sellDeskOpen ? "▲ Close" : "▼ Sell"}</span>
                      </button>
                      {/* Expanded controls — grows upward via flex-direction:column-reverse on parent */}
                      {sellDeskOpen && (
                        <div className="sell-desk-body">
                          <div className="sell-desk-controls">
                            <input
                              type="number"
                              className="sell-desk-input"
                              value={sellQty}
                              onChange={e => setSellQty(e.target.value)}
                              placeholder={`Qty (max ${totalHeld})`}
                              min={1} max={totalHeld} step={1}
                            />
                            <button className="sell-desk-all-btn"  onClick={() => setSellQty(String(totalHeld))}>All</button>
                            <button className="sell-desk-half-btn" onClick={() => setSellQty(String(Math.floor(totalHeld / 2) || 1))}>Half</button>
                          </div>
                          {estPnl !== null && (
                            <div className={`sell-desk-preview ${pnlUp ? "pnl-up" : "pnl-down"}`}>
                              Sell {sellN} baht → Est. {pnlUp ? "profit" : "loss"}: {pnlUp ? "+" : ""}฿{Math.round(estPnl)?.toLocaleString()}
                            </div>
                          )}
                          <button
                            className="sell-desk-btn"
                            onClick={handleSellDesk}
                            disabled={!sellQty || parseFloat(sellQty) <= 0 || parseFloat(sellQty) > totalHeld}
                          >
                            ▼ SELL {sellQty || "?"} BAHT-WEIGHT @ MARKET
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* ── Activity log placeholder ── */}
                <div className="activity-log-placeholder">
                  📋 Activity log available in D1 Panel (coming soon)
                </div>

              </div>
            )}
          </div>
        </div>

        {/* Right column — Order + Strategy */}
        <div className="panel-controls">
          <OrderPanel
            market="gold"
            currentPrice={currentPrice}
            portfolio={portfolio}
            onBuy={handleBuy}
            onSell={handleSell}
            marketOpen={marketOpen}
            enforceHours={enforceHours}
            onAIStrategy={onAIStrategy}
            orderMode={orderMode}
            onOrderModeChange={setOrderMode}
            recentCloses={priceHistory.slice(-10).map(c => c.close).filter(Boolean)}
            selectedSymbol="THAI_GOLD_BAHT"
            onLogActivity={onActivityEvent}
            aiWorkflowActive={aiWorkflowActive}
            workflow={workflow} setWorkflow={setWorkflow}
            stageStatuses={stageStatuses} setStageStatuses={setStageStatuses}
            activeStageIdx={activeStageIdx} setActiveStageIdx={setActiveStageIdx}
            consecutiveRed={consecutiveRed} setConsecutiveRed={setConsecutiveRed}
            workflowDone={workflowDone} setWorkflowDone={setWorkflowDone}
            fallbackTriggered={fallbackTriggered} setFallbackTriggered={setFallbackTriggered}
            stagePnl={stagePnl} setStagePnl={setStagePnl}
          />

          {orderMode === "manual" && (
            <StrategyPanel
              market="gold"
              symbol={activeSymbol}
              priceHistory={priceHistory}
              currentPrice={currentPrice}
              portfolio={portfolio}
              activeStrategy={activeStrategy}
              onStrategyChange={onStrategyChange}
              autoExecute={autoExecute}
              onAutoExecuteChange={onAutoExecuteChange}
              strategyDuration={strategyDuration}
              onStrategyDurationChange={onStrategyDurationChange}
              onExecuteBuy={handleStrategyBuy}
              onExecuteSell={handleStrategySell}
              onStrategyEvent={handleStrategyEvent}
            />
          )}
        </div>
      </div>
    </div>
  );
}
