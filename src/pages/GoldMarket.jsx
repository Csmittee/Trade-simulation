/**
 * GoldMarket.jsx
 * Phase 4:
 *   - 3-panel independent scroll layout (market-body + panel-bottom)
 *   - activeStrategy now passed in from Dashboard (BUG001 fix)
 *   - Activity log events pushed via onActivityEvent
 *   - Panel 3 collapse toggle
 *   - intel-injector wired (Phase 4)
 *   - OrderPanel gets recentCloses + selectedSymbol + onLogActivity (Phase 4)
 */

import { useState, useCallback } from "react";
import ChartPanel    from "../components/ChartPanel.jsx";
import OrderPanel    from "../components/OrderPanel.jsx";
import StrategyPanel from "../components/StrategyPanel.jsx";
import ActivityLog   from "../components/ActivityLog.jsx";
import Tooltip, { TooltipIcon } from "../components/Tooltip.jsx";
import { useGoldMarket } from "../injectors/gold-injector.js";
import { useFetchIntel }  from "../injectors/intel-injector.js";
import { calcPortfolioSummary, calcHourlyPnL } from "../core/portfolio-engine.js";
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
  activityEvents,
  onActivityEvent,
}) {
  const [activeSymbol,    setActiveSymbol]    = useState("THAI_GOLD_BAHT");
  const [timeframe,       setTimeframe]       = useState("1D");
  const [panel3Collapsed, setPanel3Collapsed] = useState(false);
  const [orderMode,       setOrderMode]       = useState("manual");

  // ── Intel hook (Phase 4) ─────────────────────────────────────────────────────
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
    const result = await handleSell(positionId, price);
    if (result?.trade) {
      pushEvent({ type: "sell", symbol: result.trade.symbol, price, detail: `Closed @ ฿${price?.toLocaleString("en-US", { maximumFractionDigits: 0 })}`, pnl: result.trade.pnl });
      logTradeToD1({ id: result.trade.id, symbol: result.trade.symbol, market: "gold", side: "sell", qty: result.trade.qty, entry_price: result.trade.entryPrice, exit_price: price, pnl: result.trade.pnl, strategy: result.trade.strategy || activeStrategy, opened_at: result.trade.openedAt, closed_at: new Date().toISOString(), sim_mode: 1 });
    }
  }, [handleSell, activeStrategy]);

  function handleStrategyEvent(ev) {
    pushEvent({ ...ev, symbol: activeSymbol });
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

          {/* Panel Bottom — positions + activity */}
          <div className={`panel-bottom ${panel3Collapsed ? "collapsed" : ""}`}>
            <div className="panel3-header">
              <span className="panel3-title">
                Positions ({goldPositions.length}) · Activity ({activityEvents.filter(e => e.market === "gold").length})
              </span>
              <button className="panel3-collapse-btn" onClick={() => setPanel3Collapsed(v => !v)}>
                {panel3Collapsed ? "▲ Show" : "▼ Hide"}
              </button>
            </div>

            {!panel3Collapsed && (
              <div className="panel-bottom-scroll">

                <div>
                  <div className="panel-bottom-section-title">
                    Open Gold Positions
                    <TooltipIcon content="Open gold trades. Entry price, P&L, stop loss and take profit." />
                  </div>
                  {goldPositions.length === 0 ? (
                    <div className="empty-state">No open positions.</div>
                  ) : (
                    <div className="positions-table">
                      <div className="pos-row header">
                        <span>Symbol</span><span>Qty</span><span>Entry</span><span>Current</span>
                        <span>P&L</span><span>P&L%</span><span>Stop</span><span>Target</span>
                        <span>Strategy</span><span>Action</span>
                      </div>
                      {goldPositions.map(pos => {
                        const pnlUp = pos.unrealisedPnL >= 0;
                        return (
                          <div key={pos.id} className="pos-row">
                            <span className="pos-symbol">{pos.symbol}</span>
                            <span>{pos.qty}</span>
                            <span>฿{pos.entryPrice?.toLocaleString()}</span>
                            <span>฿{pos.currentPrice?.toLocaleString()}</span>
                            <span className={pnlUp ? "pnl-up" : "pnl-down"}>
                              {pnlUp ? "+" : ""}฿{pos.unrealisedPnL?.toLocaleString("en-US", { minimumFractionDigits: 0 })}
                            </span>
                            <span className={pnlUp ? "pnl-up" : "pnl-down"}>
                              {pnlUp ? "+" : ""}{pos.unrealisedPnLPct?.toFixed(2)}%
                            </span>
                            <span className="pos-stop">{pos.stopLoss   ? `฿${pos.stopLoss}`   : "—"}</span>
                            <span className="pos-tp">  {pos.takeProfit ? `฿${pos.takeProfit}` : "—"}</span>
                            <span className="pos-strategy">{pos.strategy !== "manual" ? `🤖 ${pos.strategy}` : "—"}</span>
                            <span>
                              <Tooltip content="Close at current market price.">
                                <button className="close-pos-btn" onClick={() => {
                                  const result = handleSell(pos.id, pos.currentPrice);
                                  if (!result?.error) {
                                    pushEvent({ type: "sell", symbol: pos.symbol, price: pos.currentPrice, detail: `Closed × ${pos.qty} @ ฿${pos.currentPrice?.toLocaleString("en-US", { maximumFractionDigits: 0 })} | P&L: ${pos.unrealisedPnL >= 0 ? "+" : ""}฿${pos.unrealisedPnL?.toLocaleString("en-US", { maximumFractionDigits: 0 })}`, pnl: pos.unrealisedPnL });
                                  }
                                }}>Close</button>
                              </Tooltip>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div>
                  <div className="panel-bottom-section-title">
                    Activity Log — Gold
                    <TooltipIcon content="Every signal, arm, buy, sell, SL/TP hit and blocked trade." />
                    {activityEvents.filter(e => e.market === "gold").length > 0 && (
                      <button className="activity-clear-btn" onClick={() => onActivityEvent?.("__clear__gold")}>Clear</button>
                    )}
                  </div>
                  <ActivityLog
                    events={activityEvents.filter(e => e.market === "gold")}
                    onClear={() => onActivityEvent?.("__clear__gold")}
                  />
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
