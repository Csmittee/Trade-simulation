/**
 * ChartPanel.jsx
 * Candlestick + Line chart with MA5/MA20 overlay.
 * Hover 1.5s on any candle → triggers Insider Intel fetch.
 *
 * FIX (Phase 1): Replaced broken custom Bar shape with a proper SVG
 * candlestick layer using Recharts <Customized> — this gives us access
 * to the real pixel scale so wicks and bodies render correctly.
 *
 * Props:
 *   data: Array of { time, open, high, low, close }
 *   symbol: string (e.g. "XAUUSD", "PTT.BK")
 *   market: "gold" | "set"
 *   onIntelRequest: (symbol, date) => Promise<intelObject>
 */

import { useState, useRef, useCallback } from "react";
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer, Customized,
} from "recharts";
import Tooltip, { TooltipIcon } from "./Tooltip.jsx";
import config from "../../config.js";

// ── Moving Average ────────────────────────────────────────────────────────────
function calcMA(data, period) {
  return data.map((d, i) => {
    if (i < period - 1) return { ...d, [`ma${period}`]: null };
    const slice = data.slice(i - period + 1, i + 1);
    const avg = slice.reduce((s, x) => s + x.close, 0) / period;
    return { ...d, [`ma${period}`]: parseFloat(avg.toFixed(2)) };
  });
}

function enrichData(raw) {
  let d = calcMA(raw, 5);
  d = calcMA(d, 20);
  return d;
}

// ── Candlestick SVG Layer ─────────────────────────────────────────────────────
// Uses Recharts <Customized> which receives the full chart context including
// the real yAxis scale — so pixel positions are correct.
function CandlestickLayer({ xAxisMap, yAxisMap, data }) {
  if (!xAxisMap || !yAxisMap || !data?.length) return null;

  // Get the first xAxis and yAxis instances
  const xAxis = Object.values(xAxisMap)[0];
  const yAxis = Object.values(yAxisMap)[0];
  if (!xAxis?.scale || !yAxis?.scale) return null;

  const xScale = xAxis.scale;
  const yScale = yAxis.scale;

  // Bandwidth = width per candle slot
  const bandwidth = xScale.bandwidth ? xScale.bandwidth() : 8;
  const candleWidth = Math.max(2, Math.floor(bandwidth * 0.6));
  const wickWidth = 1.5;

  return (
    <g>
      {data.map((d, i) => {
        if (!d.open || !d.close || !d.high || !d.low) return null;

        const isUp  = d.close >= d.open;
        const color = isUp ? "#22c55e" : "#ef4444";

        // Convert price values → pixel Y positions
        const yOpen  = yScale(d.open);
        const yClose = yScale(d.close);
        const yHigh  = yScale(d.high);
        const yLow   = yScale(d.low);

        // Convert index → pixel X center
        const xCenter = xScale(d.time) + bandwidth / 2;

        const bodyTop    = Math.min(yOpen, yClose);
        const bodyHeight = Math.max(2, Math.abs(yClose - yOpen));

        return (
          <g key={`candle-${i}`}>
            {/* Upper wick — high to body top */}
            <line
              x1={xCenter} y1={yHigh}
              x2={xCenter} y2={bodyTop}
              stroke={color} strokeWidth={wickWidth}
            />
            {/* Body */}
            <rect
              x={xCenter - candleWidth / 2}
              y={bodyTop}
              width={candleWidth}
              height={bodyHeight}
              fill={color}
              opacity={0.85}
              rx={1}
            />
            {/* Lower wick — body bottom to low */}
            <line
              x1={xCenter} y1={bodyTop + bodyHeight}
              x2={xCenter} y2={yLow}
              stroke={color} strokeWidth={wickWidth}
            />
          </g>
        );
      })}
    </g>
  );
}

// ── Price Tooltip ─────────────────────────────────────────────────────────────
function PriceTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;

  const isUp = d.close >= d.open;
  const change = d.open ? (((d.close - d.open) / d.open) * 100).toFixed(2) : null;

  return (
    <div className="price-tooltip">
      <div className="price-tooltip-time">{label}</div>
      <div className="price-tooltip-row">O <span>{d.open?.toLocaleString()}</span></div>
      <div className="price-tooltip-row">H <span style={{ color: "#22c55e" }}>{d.high?.toLocaleString()}</span></div>
      <div className="price-tooltip-row">L <span style={{ color: "#ef4444" }}>{d.low?.toLocaleString()}</span></div>
      <div className={`price-tooltip-row ${isUp ? "up" : "down"}`}>
        C <span>{d.close?.toLocaleString()}</span>
      </div>
      {change !== null && (
        <div className={`price-tooltip-row ${isUp ? "up" : "down"}`}>
          % <span>{isUp ? "+" : ""}{change}%</span>
        </div>
      )}
      {d.ma5  && <div className="price-tooltip-row ma5">MA5 <span>{d.ma5?.toLocaleString()}</span></div>}
      {d.ma20 && <div className="price-tooltip-row ma20">MA20 <span>{d.ma20?.toLocaleString()}</span></div>}
    </div>
  );
}

// ── Intel Bubble ──────────────────────────────────────────────────────────────
function IntelBubble({ intel, position }) {
  if (!intel) return null;
  const sentimentColor = {
    bullish: "#22c55e",
    bearish: "#ef4444",
    neutral: "#f59e0b",
  }[intel.sentiment] || "#888";

  return (
    <div className="intel-bubble" style={{ left: position.x, top: position.y }}>
      <div className="intel-header">
        <span className="intel-label">⚡ INSIDER INTEL</span>
        <span className="intel-sentiment" style={{ color: sentimentColor }}>
          {intel.sentiment?.toUpperCase()}
        </span>
        <span className="intel-confidence">{intel.confidence} confidence</span>
      </div>
      <ul className="intel-factors">
        {intel.factors?.map((f, i) => <li key={i}>{f}</li>)}
      </ul>
      {intel.cached && (
        <div className="intel-cached-note">📦 Cached intel — last updated today</div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function ChartPanel({ data = [], symbol, market, onIntelRequest }) {
  const [chartType, setChartType]   = useState("candlestick");
  const [timeframe, setTimeframe]   = useState("1D");
  const [showMA5, setShowMA5]       = useState(true);
  const [showMA20, setShowMA20]     = useState(true);
  const [intel, setIntel]           = useState(null);
  const [intelPos, setIntelPos]     = useState({ x: 0, y: 0 });
  const [intelLoading, setIntelLoading] = useState(false);

  const hoverTimer  = useRef(null);
  const intelCache  = useRef({});
  const chartRef    = useRef(null);

  const enriched = enrichData(data);

  // Filter data by timeframe
  const filteredData = (() => {
    if (timeframe === "1D") return enriched.slice(-78);   // ~1 trading day at 5m
    if (timeframe === "1W") return enriched.slice(-390);  // ~1 week at 5m
    return enriched;                                       // 1M = all
  })();

  // ── Intel hover on chart area ─────────────────────────────────────────────
  const handleChartMouseEnter = useCallback((chartData, event) => {
    if (!chartData?.activePayload?.[0]) return;
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(async () => {
      const d = chartData.activePayload[0].payload;
      const dateKey  = d?.time || "unknown";
      const cacheKey = `${symbol}:${dateKey}`;

      let result = intelCache.current[cacheKey];
      if (!result) {
        setIntelLoading(true);
        try {
          result = await onIntelRequest(symbol, dateKey);
          intelCache.current[cacheKey] = result;
        } catch {
          result = {
            factors: ["Intel unavailable — check Worker connection"],
            sentiment: "neutral",
            confidence: "low",
          };
        } finally {
          setIntelLoading(false);
        }
      }

      setIntelPos({ x: (event?.clientX || 300) + 12, y: (event?.clientY || 200) - 160 });
      setIntel({ ...result, cached: !!intelCache.current[cacheKey] });
    }, config.ai.hoverDelayMs);
  }, [symbol, onIntelRequest]);

  const handleChartMouseLeave = useCallback(() => {
    clearTimeout(hoverTimer.current);
    setIntel(null);
  }, []);

  const TIMEFRAMES = ["1D", "1W", "1M"];

  // Y-axis domain with padding so candles don't touch edges
  const yDomain = (() => {
    if (!filteredData.length) return ["auto", "auto"];
    const prices = filteredData.flatMap(d => [d.high, d.low].filter(Boolean));
    if (!prices.length) return ["auto", "auto"];
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const pad = (max - min) * 0.1 || max * 0.01;
    return [Math.floor(min - pad), Math.ceil(max + pad)];
  })();

  return (
    <div className="chart-panel" ref={chartRef}>

      {/* ── Controls ── */}
      <div className="chart-controls">
        <div className="chart-type-toggle">
          <Tooltip id="tooltip-chart-candlestick">
            <button
              className={`ctrl-btn ${chartType === "candlestick" ? "active" : ""}`}
              onClick={() => setChartType("candlestick")}
            >Candles</button>
          </Tooltip>
          <Tooltip id="tooltip-chart-line">
            <button
              className={`ctrl-btn ${chartType === "line" ? "active" : ""}`}
              onClick={() => setChartType("line")}
            >Line</button>
          </Tooltip>
        </div>

        <div className="timeframe-toggle">
          {TIMEFRAMES.map(tf => (
            <Tooltip key={tf} id={`tooltip-chart-timeframe-${tf}`}>
              <button
                className={`ctrl-btn ${timeframe === tf ? "active" : ""}`}
                onClick={() => setTimeframe(tf)}
              >{tf}</button>
            </Tooltip>
          ))}
        </div>

        <div className="ma-toggles">
          <Tooltip id="tooltip-chart-ma5">
            <button
              className={`ma-btn ma5 ${showMA5 ? "active" : ""}`}
              onClick={() => setShowMA5(v => !v)}
            >MA5</button>
          </Tooltip>
          <Tooltip id="tooltip-chart-ma20">
            <button
              className={`ma-btn ma20 ${showMA20 ? "active" : ""}`}
              onClick={() => setShowMA20(v => !v)}
            >MA20</button>
          </Tooltip>
          <Tooltip id="tooltip-chart-insider">
            <span className="intel-hint">⚡ Hover 1.5s for intel</span>
          </Tooltip>
        </div>
      </div>

      {/* ── Chart ── */}
      <div className="chart-container">
        {filteredData.length === 0 ? (
          <div className="chart-loading">
            {data.length === 0 ? "Loading price history..." : "No data for this timeframe"}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart
              data={filteredData}
              margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
              onMouseMove={handleChartMouseEnter}
              onMouseLeave={handleChartMouseLeave}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="time"
                tick={{ fill: "#9ca3af", fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
                interval="preserveStartEnd"
              />
              <YAxis
                domain={yDomain}
                tick={{ fill: "#9ca3af", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={v => v.toLocaleString()}
                width={72}
              />
              <RechartsTooltip content={<PriceTooltip />} />

              {/* Invisible line so Recharts builds its scale — required for Customized to work */}
              <Line
                dataKey="close"
                stroke="transparent"
                dot={false}
                isAnimationActive={false}
              />

              {/* Candlestick layer — only shown in candlestick mode */}
              {chartType === "candlestick" && (
                <Customized component={CandlestickLayer} data={filteredData} />
              )}

              {/* Visible price line — only shown in line mode */}
              {chartType === "line" && (
                <Line
                  type="monotone"
                  dataKey="close"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              )}

              {showMA5 && (
                <Line
                  type="monotone"
                  dataKey="ma5"
                  stroke="#60a5fa"
                  strokeWidth={1.5}
                  dot={false}
                  strokeDasharray="4 2"
                  isAnimationActive={false}
                />
              )}
              {showMA20 && (
                <Line
                  type="monotone"
                  dataKey="ma20"
                  stroke="#f97316"
                  strokeWidth={1.5}
                  dot={false}
                  strokeDasharray="6 3"
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}

        {intelLoading && <div className="intel-loading">⚡ Fetching intel...</div>}
        {intel && !intelLoading && <IntelBubble intel={intel} position={intelPos} />}
      </div>

      {/* ── Legend ── */}
      <div className="chart-legend">
        {showMA5  && <span className="legend-item ma5">— MA5</span>}
        {showMA20 && <span className="legend-item ma20">— MA20</span>}
        <span className="legend-item up">■ Up</span>
        <span className="legend-item down">■ Down</span>
        <span className="legend-item" style={{ color: "#4b5563", marginLeft: "auto" }}>
          {filteredData.length} candles
        </span>
      </div>
    </div>
  );
}
