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
import { calcPortfolioSummary, calcHourlyPnL } from "../core/portfolio-engine.js";
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
}) {
  const [activeSymbol,    setActiveSymbol]    = useState(WATCHLIST[0]);
  const [timeframe,       setTimeframe]       = useState("1D");
  const [panel3Collapsed, setPanel3Collapsed] = useState(false);
  const [orderMode,       setOrderMode]       = useState("manual"); // "manual" | "ai"

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

  const fetchIntel = async () => ({
    factors:   ["Intel not available for SET in Phase 3 — coming in Phase 4"],
    sentiment: "neutral",
    confidence: "low",
  });

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
  }, [handleBuy, activeStrategy]);

  // ── Strategy SELL ────────────────────────────────────────────────────────────
  const handleStrategySell = useCallback(async (positionId, price) => {
    const result = await handleSell(positionId, price);
    if (result?.trade) {
      pushEvent({
        type:   "sell",
        symbol: result.trade.symbol,
        price,
        detail: `Closed @ ฿${price?.toFixed(2)}`,
        pnl:    result.trade.pnl,
      });
      logTradeToD1({
        id:          result.trade.id,
        symbol:      result.trade.symbol,
        market:      "set",
        side:        "sell",
        qty:         result.trade.qty,
        entry_price: result.trade.entryPrice,
        exit_price:  price,
        pnl:         result.trade.pnl,
        strategy:    result.trade.strategy || activeStrategy,
        opened_at:   result.trade.openedAt,
        closed_at:   new Date().toISOString(),
        sim_mode:    1,
      });
    }
  }, [handleSell, activeStrategy]);

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
              onIntelRequest={fetchIntel}
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
              <div className="panel-bottom-scroll">

                {/* Positions */}
                <div>
                  <div className="panel-bottom-section-title">
                    Open SET Positions
                    <TooltipIcon content="Open SET/MAI positions. Commission and transfer fees already deducted from P&L." />
                  </div>
                  {setPositions.length === 0 ? (
                    <div className="empty-state">No open positions. Select a stock and place a buy order.</div>
                  ) : (
                    <div className="positions-table">
                      <div className="pos-row header">
                        <span>Symbol</span><span>Qty</span><span>Entry</span><span>Current</span>
                        <span>P&L</span><span>P&L%</span><span>Stop</span><span>Target</span>
                        <span>Strategy</span><span>Action</span>
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
                            <span>
                              <Tooltip content="Close at current market price.">
                                <button className="close-pos-btn" onClick={() => handleSell(pos.id, pos.currentPrice)}>Close</button>
                              </Tooltip>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Activity Log */}
                <div>
                  <div className="panel-bottom-section-title">
                    Activity Log — SET
                    <TooltipIcon content="Every signal, arm, buy, sell, SL/TP hit and blocked trade." />
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
            />
          )}
        </div>
      </div>
    </div>
  );
}
