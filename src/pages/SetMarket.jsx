  /**
 * SetMarket.jsx
 * Phase 4:
 *   - 3-panel independent scroll layout (market-body + panel-bottom)
 *   - activeStrategy now passed in from Dashboard (BUG001 fix)
 *   - Activity log events pushed via onActivityEvent
 *   - Panel 3 collapse toggle
 */

import { useState, useCallback } from "react";
import ChartPanel    from "../components/ChartPanel.jsx";
import OrderPanel    from "../components/OrderPanel.jsx";
import StrategyPanel from "../components/StrategyPanel.jsx";
import ActivityLog   from "../components/ActivityLog.jsx";
import Tooltip, { TooltipIcon } from "../components/Tooltip.jsx";
import { useSetMarket } from "../injectors/set-injector.js";
import { useFetchIntel } from "../injectors/intel-injector.js";
import { calcPortfolioSummary, calcHourlyPnL, executeSellQty } from "../core/portfolio-engine.js";
import { makeActivityEvent } from "../components/ActivityLog.jsx";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell } from "recharts";
import config from "../../config.js";

const WATCHLIST = config.data.set.watchlistDefault;
const WORKER    = config.workers.base;

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

function WatchlistRow({ symbol, quote, isActive, onClick }) {
  const changeUp = (quote?.changePct || 0) >= 0;
  return (
    <button className={`watchlist-row ${isActive ? "active" : ""}`} onClick={() => onClick(symbol)}>
      <div className="wl-left">
        <span className="wl-symbol">{symbol.replace(".BK", "")}</span>
        {quote?.name && <span className="wl-name">{quote.name}</span>}
      </div>
      <div className="wl-right">
        {!quote ? (
          <span className="wl-loading">—</span>
        ) : (
          <>
            <span className="wl-price">฿{quote.price?.toFixed(2)}</span>
            <span className={`wl-change ${changeUp ? "up" : "down"}`}>
              {changeUp ? "▲" : "▼"} {Math.abs(quote.changePct || 0).toFixed(2)}%
            </span>
          </>
        )}
      </div>
    </button>
  );
}

export default function SetMarket({
  portfolio,
  setPortfolio,
  enforceHours,
  onAIStrategy,
  // Phase 4 — lifted from local state into Dashboard
  activeStrategy,
  onStrategyChange,
  // Phase 4 — activity log
  activityEvents,
  onActivityEvent,
  // Lifted workflow state (BUG002)
  workflow, setWorkflow,
  stageStatuses, setStageStatuses,
  activeStageIdx, setActiveStageIdx,
  consecutiveRed, setConsecutiveRed,
  workflowDone, setWorkflowDone,
  fallbackTriggered, setFallbackTriggered,
  stagePnl, setStagePnl,
  aiWorkflowActive, // BUG003
}) {
  const [activeSymbol,    setActiveSymbol]    = useState(WATCHLIST[0]);
  const [timeframe,       setTimeframe]       = useState("1D");
  const [panel3Collapsed, setPanel3Collapsed] = useState(false);
  const [orderMode,       setOrderMode]       = useState("manual"); // "manual" | "ai"
  const [sellQty,         setSellQty]         = useState("");

  const {
    watchlistData, activeQuote, priceHistory, historyLoading,
    loading, error, lastUpdated, marketOpen,
    handleBuy, handleSell,
  } = useSetMarket({ activeSymbol, portfolio, setPortfolio, enforceHours, timeframe });

  const closedTrades = Array.isArray(portfolio?.closedTrades) ? portfolio.closedTrades : [];
  const positions    = Array.isArray(portfolio?.positions)    ? portfolio.positions    : [];
  const hourlyPnL    = calcHourlyPnL(closedTrades.filter(t => t.market === "set"));
  const setPositions = positions.filter(p => p.market === "set");
  const currentPrice = activeQuote?.price || null;

  const fetchIntel = useFetchIntel();

  const handleSymbolChange = (sym) => {
    setActiveSymbol(sym);
    setTimeframe("1D");
    // Note: activeStrategy intentionally NOT reset here — it persists across symbol switches (BUG001 fix)
  };

  // ── Activity push helper ─────────────────────────────────────────────────────
  function pushEvent(params) {
    onActivityEvent?.(makeActivityEvent({ market: "set", ...params }));
  }

  // ── Strategy BUY ─────────────────────────────────────────────────────────────
  const handleStrategyBuy = useCallback(async (order) => {
    const result = await handleBuy(order);
    if (result?.error) {
      console.warn("[StrategyBuy SET] rejected:", result.error);
      pushEvent({ type: "block", symbol: order.symbol, detail: `Rejected: ${result.error}` });
      return result;
    }
    if (result?.trade) {
      pushEvent({
        type:   "buy",
        symbol: order.symbol,
        price:  order.price,
        detail: `${order.strategy || activeStrategy} × ${order.qty}`,
      });
      logTradeToD1({
        id:          result.trade.id,
        symbol:      order.symbol,
        market:      "set",
        side:        "buy",
        qty:         order.qty,
        entry_price: order.price,
        exit_price:  null,
        pnl:         null,
        strategy:    order.strategy || activeStrategy,
        opened_at:   new Date().toISOString(),
        closed_at:   null,
        sim_mode:    1,
      });
    }
    return result;
  }, [handleBuy, activeStrategy]);

  // ── Strategy SELL ────────────────────────────────────────────────────────────
  const handleStrategySell = useCallback(async (positionId, price) => {
    const setPos = (portfolio?.positions || []).filter(p => p.market === "set" && p.symbol === activeSymbol);
    const totalQty = setPos.reduce((s, p) => s + p.qty, 0);
    if (totalQty === 0) return;
    const result = executeSellQty(portfolio, "set", activeSymbol, totalQty, price || currentPrice);
    if (result.error) {
      pushEvent({ type: "block", symbol: activeSymbol, detail: `Strategy sell rejected: ${result.error}` });
      return;
    }
    setPortfolio(result.portfolio);
    const pnlSign = result.totalPnl >= 0 ? "+" : "";
    pushEvent({ type: "sell", symbol: activeSymbol, price: price || currentPrice, detail: `Strategy sold ${totalQty} shares FIFO | Avg entry ฿${result.avgEntryPrice?.toFixed(2)} | P&L: ${pnlSign}฿${Math.round(result.totalPnl)?.toLocaleString()}`, pnl: result.totalPnl });
    result.closedTrades.forEach(t => {
      logTradeToD1({ id: t.id, symbol: t.symbol, market: "set", side: "sell", qty: t.qty, entry_price: t.entryPrice, exit_price: price || currentPrice, pnl: t.pnl, strategy: t.strategy || activeStrategy, opened_at: t.openedAt, closed_at: t.closedAt, sim_mode: 1 });
    });
  }, [portfolio, currentPrice, activeSymbol, activeStrategy]);

  // ── Global Sell Desk (FIFO) ───────────────────────────────────────────────
  function handleSellDesk() {
    const qty = parseFloat(sellQty);
    if (!qty || qty <= 0) return;
    const price = currentPrice;
    if (!price) return;
    const result = executeSellQty(portfolio, "set", activeSymbol, qty, price);
    if (result.error) {
      pushEvent({ type: "block", symbol: activeSymbol, detail: `Sell rejected: ${result.error}` });
      return;
    }
    setPortfolio(result.portfolio);
    const pnlSign = result.totalPnl >= 0 ? "+" : "";
    pushEvent({ type: "sell", symbol: activeSymbol, price, detail: `Sold ${qty} shares FIFO @ ฿${price?.toFixed(2)} | Avg entry ฿${result.avgEntryPrice?.toFixed(2)} | P&L: ${pnlSign}฿${Math.round(result.totalPnl)?.toLocaleString()}`, pnl: result.totalPnl });
    result.closedTrades.forEach(t => {
      logTradeToD1({ id: t.id, symbol: t.symbol, market: "set", side: "sell", qty: t.qty, entry_price: t.entryPrice, exit_price: price, pnl: t.pnl, strategy: t.strategy || "manual", opened_at: t.openedAt, closed_at: t.closedAt, sim_mode: 1 });
    });
    setSellQty("");
  }

  // ── Strategy events (signal / armed / block) forwarded from StrategyPanel ────
  function handleStrategyEvent(ev) {
    pushEvent({ ...ev, symbol: activeSymbol });
  }

  const setEventsCount = activityEvents.filter(e => e.market === "set").length;

  return (
    <div className="market-page set-market">

      {/* ── Ticker Header (fixed height strip) ── */}
      <div className="ticker-header">
        <div className="set-header-left">
          <span className="set-market-title">📈 SET / MAI</span>
          <span className="set-delayed-badge">
            ⚠ 15-min delayed
            <Tooltip content="SET data is provided by Yahoo Finance on a 15-minute delay. Acceptable for learning and simulation — do not use for real-time execution decisions.">
              <span className="delayed-info">ⓘ</span>
            </Tooltip>
          </span>
        </div>

        <div className="price-display">
          {loading ? (
            <span className="price-loading">Loading SET data...</span>
          ) : error ? (
            <span className="price-error">⚠ {error}</span>
          ) : activeQuote ? (
            <>
              <span className="set-active-symbol">{activeSymbol.replace(".BK", "")}</span>
              <span className="price-main">฿{activeQuote.price?.toFixed(2)}</span>
              <span className={`set-change ${activeQuote.changePct >= 0 ? "pnl-up" : "pnl-down"}`}>
                {activeQuote.changePct >= 0 ? "▲" : "▼"} {Math.abs(activeQuote.changePct || 0).toFixed(2)}%
              </span>
            </>
          ) : null}
        </div>

        <div className="ticker-meta">
          {activeQuote && (
            <>
              <span className="meta-item">O: <strong>฿{activeQuote.open?.toFixed(2)}</strong></span>
              <span className="meta-item">H: <strong style={{color:"#22c55e"}}>฿{activeQuote.high?.toFixed(2)}</strong></span>
              <span className="meta-item">L: <strong style={{color:"#ef4444"}}>฿{activeQuote.low?.toFixed(2)}</strong></span>
              <span className="meta-item">Vol: <strong>{(activeQuote.volume/1000000).toFixed(1)}M</strong></span>
              <span className="meta-item">Updated: <strong>{lastUpdated?.toLocaleTimeString()}</strong></span>
            </>
          )}
        </div>
      </div>

      {/* ── Main Body: Watchlist | Left column (chart + bottom) | Right column (controls) ── */}
      <div className="market-body">

        {/* Watchlist — leftmost column, full height scroll */}
        <div className="panel-watchlist">
          <div className="watchlist-panel">
            <div className="section-title">
              Watchlist
              <TooltipIcon content="8 major SET/MAI stocks. Click to view chart and trade. Prices 15-min delayed." />
            </div>
            <div className="watchlist-list">
              {WATCHLIST.map(sym => (
                <WatchlistRow
                  key={sym}
                  symbol={sym}
                  quote={watchlistData[sym]}
                  isActive={sym === activeSymbol}
                  onClick={handleSymbolChange}
                />
              ))}
            </div>
            <div className="set-market-info">
              <div className="info-item">⏰ Session 1: 10:00–12:30 ICT</div>
              <div className="info-item">⏰ Session 2: 14:30–17:00 ICT</div>
              <div className="info-item">📦 Min lot: 100 shares</div>
              <div className="info-item">💸 Commission: 0.157% + VAT</div>
            </div>
          </div>
        </div>

        {/* Left column — chart on top, positions+log stacked below */}
        <div className="panel-left">

          {/* Chart — scrollable */}
          <div className="panel-chart">
            <ChartPanel
              data={priceHistory}
              symbol={activeSymbol}
              market="set"
              timeframe={timeframe}
              historyLoading={historyLoading}
              onTimeframeChange={setTimeframe}
              onIntelRequest={(symbol, date) => fetchIntel(symbol, date, "set")}
            />

            {hourlyPnL.length > 0 && (
              <div className="hourly-pnl">
                <div className="section-title">
                  Hourly P&L — SET
                  <TooltipIcon content="Profit or loss from SET trades by hour." />
                </div>
                <ResponsiveContainer width="100%" height={80}>
                  <BarChart data={hourlyPnL} margin={{ top:4, right:8, left:8, bottom:0 }}>
                    <XAxis dataKey="hour" tick={{fill:"#9ca3af",fontSize:10}} tickLine={false} />
                    <YAxis hide domain={["auto","auto"]} />
                    <Bar dataKey="pnl" radius={[2,2,0,0]} isAnimationActive={false}>
                      {hourlyPnL.map((e,i) => <Cell key={i} fill={e.pnl>=0?"#22c55e":"#ef4444"} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            <div className="market-info-bar" style={{ padding: 0, border: "none" }}>
              <Tooltip content="SET data is 15 minutes delayed via Yahoo Finance.">
                <span className="info-item">⚠ Prices 15-min delayed</span>
              </Tooltip>
              <Tooltip content="Commission: 0.157% of trade value (min ฿50) + 7% VAT + 0.1% transfer fee on sell.">
                <span className="info-item">💸 Commission: 0.157% + VAT + 0.1% transfer</span>
              </Tooltip>
              <Tooltip content="SET minimum order is 1 lot = 100 shares.">
                <span className="info-item">📦 Min: 1 lot = 100 shares</span>
              </Tooltip>
            </div>
          </div>

          {/* Panel Bottom — positions + activity log stacked below chart */}
          <div className={`panel-bottom ${panel3Collapsed ? "collapsed" : ""}`}>
            <div className="panel3-header">
              <span className="panel3-title">
                Positions ({setPositions.length}) · Activity ({setEventsCount})
              </span>
              <button
                className="panel3-collapse-btn"
                onClick={() => setPanel3Collapsed(v => !v)}
              >
                {panel3Collapsed ? "▲ Show" : "▼ Hide"}
              </button>
            </div>

            {!panel3Collapsed && (
              <div className="panel-bottom-body">

                {/* Positions */}
                <div className="panel-bottom-zone positions-zone">
                  <div className="panel-bottom-section-title">
                    Open SET Positions
                    <TooltipIcon content="Open SET/MAI positions. Commission and transfer fees already deducted from P&L." />
                  </div>
                  {setPositions.length === 0 ? (
                    <div className="empty-state">No open positions. Select a stock and place a buy order.</div>
                  ) : (
                    <>
                      <div className="positions-table">
                        <div className="pos-row header">
                          <span>Symbol</span><span>Qty</span><span>Entry</span><span>Current</span>
                          <span>P&L</span><span>P&L%</span><span>Stop</span><span>Target</span>
                          <span>Strategy</span>
                        </div>
                        {setPositions.map(pos => {
                          const pnlUp = pos.unrealisedPnL >= 0;
                          return (
                            <div key={pos.id} className="pos-row">
                              <span className="pos-symbol">{pos.symbol?.replace(".BK","")}</span>
                              <span>{pos.qty?.toLocaleString()}</span>
                              <span>฿{pos.entryPrice?.toFixed(2)}</span>
                              <span>฿{pos.currentPrice?.toFixed(2)}</span>
                              <span className={pnlUp?"pnl-up":"pnl-down"}>
                                {pnlUp?"+":""}฿{pos.unrealisedPnL?.toLocaleString("en-US",{minimumFractionDigits:0})}
                              </span>
                              <span className={pnlUp?"pnl-up":"pnl-down"}>
                                {pnlUp?"+":""}{pos.unrealisedPnLPct?.toFixed(2)}%
                              </span>
                              <span className="pos-stop">{pos.stopLoss   ? `฿${pos.stopLoss}`   : "—"}</span>
                              <span className="pos-tp">  {pos.takeProfit ? `฿${pos.takeProfit}` : "—"}</span>
                              <span className="pos-strategy">{pos.strategy !== "manual" ? `🤖 ${pos.strategy}` : "—"}</span>
                            </div>
                          );
                        })}
                      </div>

                      {/* ── Global Sell Desk ── */}
                      {(() => {
                        const symPos     = setPositions.filter(p => p.symbol === activeSymbol);
                        const totalHeld  = symPos.reduce((s, p) => s + p.qty, 0);
                        const totalCost  = symPos.reduce((s, p) => s + p.totalCost, 0);
                        const avgEntry   = totalHeld > 0 ? totalCost / totalHeld : 0;
                        const price      = currentPrice || 0;
                        const sellN      = parseFloat(sellQty) || 0;
                        const estPnl     = sellN > 0 ? (price - avgEntry) * sellN : null;
                        const pnlUp      = estPnl >= 0;
                        const totalPnl   = symPos.reduce((s,p)=>s+p.unrealisedPnL,0);
                        if (totalHeld === 0) return <div className="empty-state" style={{fontSize:"11px"}}>Switch to the active symbol to sell.</div>;
                        return (
                          <div className="sell-desk">
                            <div className="sell-desk-summary">
                              <span><strong>{activeSymbol?.replace(".BK","")}</strong> — {totalHeld?.toLocaleString()} shares</span>
                              <span>Avg entry <strong>฿{avgEntry?.toFixed(2)}</strong></span>
                              <span>Now <strong>฿{price?.toFixed(2)}</strong></span>
                              <span className={totalPnl >= 0 ? "pnl-up" : "pnl-down"}>
                                P&L: {totalPnl >= 0 ? "+" : ""}฿{Math.round(totalPnl)?.toLocaleString()}
                              </span>
                            </div>
                            <div className="sell-desk-controls">
                              <input
                                type="number"
                                className="sell-desk-input"
                                value={sellQty}
                                onChange={e => setSellQty(e.target.value)}
                                placeholder={`Sell how many? (max ${totalHeld?.toLocaleString()})`}
                                min={100}
                                max={totalHeld}
                                step={100}
                              />
                              <button className="sell-desk-all-btn"  onClick={() => setSellQty(String(totalHeld))}>All</button>
                              <button className="sell-desk-half-btn" onClick={() => setSellQty(String(Math.floor(totalHeld / 200) * 100 || 100))}>Half</button>
                            </div>
                            {estPnl !== null && (
                              <div className={`sell-desk-preview ${pnlUp ? "pnl-up" : "pnl-down"}`}>
                                Sell {sellN?.toLocaleString()} shares → Est. {pnlUp ? "profit" : "loss"}: {pnlUp ? "+" : ""}฿{Math.round(estPnl)?.toLocaleString()}
                              </div>
                            )}
                            <button
                              className="sell-desk-btn"
                              onClick={handleSellDesk}
                              disabled={!sellQty || parseFloat(sellQty) <= 0 || parseFloat(sellQty) > totalHeld}
                            >
                              ▼ SELL {sellQty ? parseInt(sellQty)?.toLocaleString() : "?"} SHARES @ MARKET
                            </button>
                          </div>
                        );
                      })()}
                    </>
                  )}
                </div>

                {/* Activity Log */}
                <div className="panel-bottom-zone log-zone">
                  <div className="panel-bottom-section-title">
                    Activity Log — SET
                    <TooltipIcon content="Every signal, arm, buy, sell, SL/TP hit and blocked trade. Grouped by hour." />
                    {setEventsCount > 0 && (
                      <button className="activity-clear-btn" onClick={() => onActivityEvent?.("__clear__set")}>
                        Clear
                      </button>
                    )}
                  </div>
                  <ActivityLog
                    events={activityEvents.filter(e => e.market === "set")}
                    onClear={() => onActivityEvent?.("__clear__set")}
                  />
                </div>

              </div>
            )}
          </div>
        </div>

        {/* Right column — Order + Strategy, full height scroll */}
        <div className="panel-controls">
          <OrderPanel
            market="set"
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
            selectedSymbol={activeSymbol}
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

          {/* StrategyPanel only shows when Manual tab is active */}
          {orderMode === "manual" && (
            <StrategyPanel
              market="set"
              symbol={activeSymbol}
              priceHistory={priceHistory}
              currentPrice={currentPrice}
              portfolio={portfolio}
              activeStrategy={activeStrategy}
              onStrategyChange={onStrategyChange}
              onExecuteBuy={handleStrategyBuy}
              onExecuteSell={handleStrategySell}
              onStrategyEvent={handleStrategyEvent}
              aiWorkflowActive={aiWorkflowActive}
            />
          )}
        </div>
      </div>
    </div>
  );
}
