/**
 * GoldMarket.jsx
 * Gold market tab — Thai gold (baht-weight) + XAUUSD display.
 * Phase 3: StrategyPanel wired in — activeStrategy state lives here.
 */

import { useState, useCallback } from "react";
import ChartPanel    from "../components/ChartPanel.jsx";
import OrderPanel    from "../components/OrderPanel.jsx";
import StrategyPanel from "../components/StrategyPanel.jsx";
import Tooltip, { TooltipIcon } from "../components/Tooltip.jsx";
import { useGoldMarket } from "../injectors/gold-injector.js";
import { calcPortfolioSummary, calcHourlyPnL } from "../core/portfolio-engine.js";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell } from "recharts";
import config from "../../config.js";

const WORKER = config.workers.base;

// Log a closed trade to D1 via Worker
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

export default function GoldMarket({ portfolio, setPortfolio, enforceHours, onAIStrategy }) {
  const [activeSymbol,   setActiveSymbol]   = useState("THAI_GOLD_BAHT");
  const [timeframe,      setTimeframe]      = useState("1D");
  const [activeStrategy, setActiveStrategy] = useState(null); // Phase 3

  const {
    goldData,
    priceHistory,
    loading,
    error,
    partial,
    lastUpdated,
    historyLoading,
    marketOpen,
    handleBuy,
    handleSell,
    fetchIntel,
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

  // Strategy → BUY: wrap handleBuy and also log to D1 when it closes
  const handleStrategyBuy = useCallback(async (order) => {
    const result = await handleBuy(order);
    if (result?.trade) {
      // Log the open leg — closed_at and pnl filled later on close
      logTradeToD1({
        id:          result.trade.id,
        symbol:      order.symbol,
        market:      "gold",
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

  // Strategy → SELL: wrap handleSell and log the close to D1
  const handleStrategySell = useCallback(async (positionId, price) => {
    const result = await handleSell(positionId, price);
    if (result?.trade) {
      logTradeToD1({
        id:          result.trade.id,
        symbol:      result.trade.symbol,
        market:      "gold",
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

  return (
    <div className="market-page gold-market">

      {/* ── Price Ticker Header ── */}
      <div className="ticker-header">
        <div className="symbol-tabs">
          {[
            { key: "THAI_GOLD_BAHT", label: "Thai Gold (บาท)", sublabel: "96.5% purity" },
            { key: "XAUUSD",         label: "XAUUSD",          sublabel: "spot USD" },
          ].map(({ key, label, sublabel }) => (
            <button
              key={key}
              className={`symbol-tab ${activeSymbol === key ? "active" : ""}`}
              onClick={() => setActiveSymbol(key)}
            >
              <span className="symbol-name">{label}</span>
              <span className="symbol-sub">{sublabel}</span>
            </button>
          ))}
        </div>

        <div className="price-display">
          {loading ? (
            <span className="price-loading">Loading...</span>
          ) : error ? (
            <span className="price-error">⚠ {error}</span>
          ) : (
            <>
              <span className="price-main">
                {priceCurrency} {currentPrice?.toLocaleString("en-US", { minimumFractionDigits: 2 })}
              </span>
              <span className="price-unit">{priceUnit}</span>
              {partial && (
                <Tooltip content="One data source is unavailable. Price may be approximate.">
                  <span className="partial-warning">⚠ Partial data</span>
                </Tooltip>
              )}
            </>
          )}
        </div>

        <div className="ticker-meta">
          {goldData && (
            <>
              <span className="meta-item">
                USD/THB: <strong>{goldData.thbRate?.rate?.toFixed(2)}</strong>
              </span>
              <span className="meta-item">
                Updated: <strong>{lastUpdated?.toLocaleTimeString()}</strong>
              </span>
            </>
          )}
        </div>
      </div>

      {/* ── Main Layout: Chart + Order Panel ── */}
      <div className="market-layout">

        {/* Left: Chart */}
        <div className="chart-section">
          <ChartPanel
            data={priceHistory}
            symbol={activeSymbol}
            market="gold"
            timeframe={timeframe}
            historyLoading={historyLoading}
            onTimeframeChange={setTimeframe}
            onIntelRequest={fetchIntel}
          />

          {/* Hourly P&L Mini Chart */}
          {hourlyPnL.length > 0 && (
            <div className="hourly-pnl">
              <div className="section-title">
                Hourly P&L — Gold
                <TooltipIcon content="Your profit or loss from gold trades broken down by hour. Green bars = net gain that hour. Red bars = net loss." />
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
        </div>

        {/* Right: Order Panel + Strategy Panel */}
        <div className="order-section">
          <OrderPanel
            market="gold"
            currentPrice={currentPrice}
            portfolio={portfolio}
            onBuy={handleBuy}
            onSell={handleSell}
            marketOpen={marketOpen}
            enforceHours={enforceHours}
            onAIStrategy={onAIStrategy}
          />

          {/* Phase 3: Strategy Panel below Order Panel */}
          <StrategyPanel
            market="gold"
            symbol={activeSymbol}
            priceHistory={priceHistory}
            currentPrice={currentPrice}
            portfolio={portfolio}
            activeStrategy={activeStrategy}
            onStrategyChange={setActiveStrategy}
            onExecuteBuy={handleStrategyBuy}
            onExecuteSell={handleStrategySell}
          />
        </div>
      </div>

      {/* ── Open Positions ── */}
      <div className="positions-section">
        <div className="section-title">
          Open Gold Positions ({goldPositions.length})
          <TooltipIcon content="Your currently open gold trades. Each row shows entry price, current price, unrealised P&L, and stop loss / take profit levels." />
        </div>

        {goldPositions.length === 0 ? (
          <div className="empty-state">No open positions. Place a buy order above to start.</div>
        ) : (
          <div className="positions-table">
            <div className="pos-row header">
              <span>Symbol</span>
              <span>Qty</span>
              <span>Entry</span>
              <span>Current</span>
              <span>P&L</span>
              <span>P&L %</span>
              <span>Stop</span>
              <span>Target</span>
              <span>Strategy</span>
              <span>Action</span>
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
                    <Tooltip content="Close this position at the current market price and realise your profit or loss.">
                      <button
                        className="close-pos-btn"
                        onClick={() => handleSell(pos.id, pos.currentPrice)}
                      >
                        Close
                      </button>
                    </Tooltip>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Gold Market Info ── */}
      <div className="market-info-bar">
        <Tooltip content="Thai gold price is calculated from XAUUSD spot × USD/THB rate × 96.5% purity factor, rounded to nearest ฿50 per market convention.">
          <span className="info-item">ℹ Thai gold formula: XAUUSD × THB rate × 0.965</span>
        </Tooltip>
        <Tooltip content="Gold market is open Monday–Friday, 24 hours. Closed on weekends.">
          <span className="info-item">⏰ Gold hours: Mon–Fri 24×5</span>
        </Tooltip>
        <Tooltip content="Minimum trade size is 1 baht-weight (15.244 grams at 96.5% purity). No brokerage fee — dealer spread is baked into the quoted price.">
          <span className="info-item">📦 Min: 1 baht-weight | No commission</span>
        </Tooltip>
      </div>
    </div>
  );
}
