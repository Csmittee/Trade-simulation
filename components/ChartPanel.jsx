/**
 * ChartPanel.jsx
 * Candlestick + Line chart with MA5/MA20 overlay.
 * Hover 1.5s on any candle → triggers Insider Intel fetch.
 *
 * Props:
 *   data: Array of { time, open, high, low, close, volume }
 *   symbol: string (e.g. "XAUUSD", "PTT.BK")
 *   market: "gold" | "set"
 *   onIntelRequest: (symbol, date) => Promise<intelObject>
 */

import { useState, useRef, useCallback } from "react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import Tooltip, { TooltipIcon } from "./Tooltip.jsx";
import config from "../../config.js";

// Compute Moving Average over an array of close prices
function calcMA(data, period) {
  return data.map((d, i) => {
    if (i < period - 1) return { ...d, [`ma${period}`]: null };
    const slice = data.slice(i - period + 1, i + 1);
    const avg = slice.reduce((s, x) => s + x.close, 0) / period;
    return { ...d, [`ma${period}`]: parseFloat(avg.toFixed(2)) };
  });
}

// Merge MA calculations into data
function enrichData(raw) {
  let d = calcMA(raw, 5);
  d = calcMA(d, 20);
  return d;
}

// Custom candlestick bar shape
function CandlestickBar(props) {
  const { x, y, width, height, open, close, high, low, payload } = props;
  if (!payload) return null;

  const isUp = payload.close >= payload.open;
  const color = isUp ? "#22c55e" : "#ef4444";
  const bodyTop    = Math.min(payload.open, payload.close);
  const bodyBottom = Math.max(payload.open, payload.close);
  const bodyHeight = Math.max(2, bodyBottom - bodyTop); // at least 2px visible

  // These are in data units — need chart's scale. Recharts passes pixel y/height.
  // We use the Bar's y/height (already scaled) as the body.
  const wickX = x + width / 2;

  return (
    <g>
      {/* Upper wick */}
      <line x1={wickX} y1={y - 4}          x2={wickX} y2={y}          stroke={color} strokeWidth={1.5} />
      {/* Body */}
      <rect x={x + 1} y={y} width={width - 2} height={Math.max(2, height)} fill={color} opacity={0.9} rx={1} />
      {/* Lower wick */}
      <line x1={wickX} y1={y + height}      x2={wickX} y2={y + height + 4} stroke={color} strokeWidth={1.5} />
    </g>
  );
}

// Insider Intel overlay bubble
function IntelBubble({ intel, position }) {
  if (!intel) return null;

  const sentimentColor = {
    bullish: "#22c55e",
    bearish: "#ef4444",
    neutral: "#f59e0b",
  }[intel.sentiment] || "#888";

  return (
    <div
      className="intel-bubble"
      style={{ left: position.x, top: position.y }}
    >
      <div className="intel-header">
        <span className="intel-label">⚡ INSIDER INTEL</span>
        <span className="intel-sentiment" style={{ color: sentimentColor }}>
          {intel.sentiment?.toUpperCase()}
        </span>
        <span className="intel-confidence">{intel.confidence} confidence</span>
      </div>
      <ul className="intel-factors">
        {intel.factors?.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
      {intel.cached && (
        <div className="intel-cached-note">📦 Cached intel — last updated today</div>
      )}
    </div>
  );
}

// Custom recharts tooltip (price details on hover)
function PriceTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;

  const isUp = d.close >= d.open;
  return (
    <div className="price-tooltip">
      <div className="price-tooltip-time">{label}</div>
      <div className="price-tooltip-row">O <span>{d.open?.toLocaleString()}</span></div>
      <div className="price-tooltip-row">H <span style={{ color: "#22c55e" }}>{d.high?.toLocaleString()}</span></div>
      <div className="price-tooltip-row">L <span style={{ color: "#ef4444" }}>{d.low?.toLocaleString()}</span></div>
      <div className={`price-tooltip-row ${isUp ? "up" : "down"}`}>
        C <span>{d.close?.toLocaleString()}</span>
      </div>
      {d.ma5  && <div className="price-tooltip-row ma5">MA5 <span>{d.ma5}</span></div>}
      {d.ma20 && <div className="price-tooltip-row ma20">MA20 <span>{d.ma20}</span></div>}
    </div>
  );
}

export default function ChartPanel({ data = [], symbol, market, onIntelRequest }) {
  const [chartType, setChartType] = useState("candlestick");
  const [timeframe, setTimeframe] = useState("1D");
  const [showMA5, setShowMA5] = useState(true);
  const [showMA20, setShowMA20] = useState(true);
  const [intel, setIntel] = useState(null);
  const [intelPos, setIntelPos] = useState({ x: 0, y: 0 });
  const [intelLoading, setIntelLoading] = useState(false);

  const hoverTimer = useRef(null);
  const intelCache = useRef({});  // local session cache (Worker has 24hr KV cache)

  const enriched = enrichData(data);

  // ── Insider Intel Hover ──────────────────────────────────────────────────────
  const handleMouseEnterBar = useCallback((barData, event) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(async () => {
      const dateKey = barData?.payload?.time || "unknown";
      const cacheKey = `${symbol}:${dateKey}`;

      let result = intelCache.current[cacheKey];

      if (!result) {
        setIntelLoading(true);
        try {
          result = await onIntelRequest(symbol, dateKey);
          intelCache.current[cacheKey] = result;
        } catch (e) {
          result = {
            factors: ["Intel unavailable — check Worker connection"],
            sentiment: "neutral",
            confidence: "low",
          };
        } finally {
          setIntelLoading(false);
        }
      }

      const rect = event?.target?.getBoundingClientRect?.();
      setIntelPos({ x: (rect?.left || 200) + 10, y: (rect?.top || 200) - 160 });
      setIntel({ ...result, cached: !!intelCache.current[cacheKey] });
    }, config.ai.hoverDelayMs);
  }, [symbol, onIntelRequest]);

  const handleMouseLeaveBar = useCallback(() => {
    clearTimeout(hoverTimer.current);
    setIntel(null);
  }, []);

  const TIMEFRAMES = ["1D", "1W", "1M"];

  return (
    <div className="chart-panel">
      {/* ── Chart Controls ── */}
      <div className="chart-controls">
        <div className="chart-type-toggle">
          <Tooltip id="tooltip-chart-candlestick">
            <button
              className={`ctrl-btn ${chartType === "candlestick" ? "active" : ""}`}
              onClick={() => setChartType("candlestick")}
            >
              Candles
            </button>
          </Tooltip>
          <Tooltip id="tooltip-chart-line">
            <button
              className={`ctrl-btn ${chartType === "line" ? "active" : ""}`}
              onClick={() => setChartType("line")}
            >
              Line
            </button>
          </Tooltip>
        </div>

        <div className="timeframe-toggle">
          {TIMEFRAMES.map(tf => (
            <Tooltip key={tf} id={`tooltip-chart-timeframe-${tf}`}>
              <button
                className={`ctrl-btn ${timeframe === tf ? "active" : ""}`}
                onClick={() => setTimeframe(tf)}
              >
                {tf}
              </button>
            </Tooltip>
          ))}
        </div>

        <div className="ma-toggles">
          <Tooltip id="tooltip-chart-ma5">
            <button
              className={`ma-btn ma5 ${showMA5 ? "active" : ""}`}
              onClick={() => setShowMA5(v => !v)}
            >
              MA5
            </button>
          </Tooltip>
          <Tooltip id="tooltip-chart-ma20">
            <button
              className={`ma-btn ma20 ${showMA20 ? "active" : ""}`}
              onClick={() => setShowMA20(v => !v)}
            >
              MA20
            </button>
          </Tooltip>
          <Tooltip id="tooltip-chart-insider">
            <span className="intel-hint">⚡ Hover candle 1.5s for intel</span>
          </Tooltip>
        </div>
      </div>

      {/* ── Chart ── */}
      <div className="chart-container">
        {enriched.length === 0 ? (
          <div className="chart-loading">Loading price data...</div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={enriched} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="time"
                tick={{ fill: "#9ca3af", fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
              />
              <YAxis
                domain={["auto", "auto"]}
                tick={{ fill: "#9ca3af", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={v => v.toLocaleString()}
                width={70}
              />
              <RechartsTooltip content={<PriceTooltip />} />

              {chartType === "candlestick" ? (
                <Bar
                  dataKey="close"
                  shape={<CandlestickBar />}
                  onMouseEnter={handleMouseEnterBar}
                  onMouseLeave={handleMouseLeaveBar}
                  isAnimationActive={false}
                />
              ) : (
                <Line
                  type="monotone"
                  dataKey="close"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  onMouseEnter={handleMouseEnterBar}
                  onMouseLeave={handleMouseLeaveBar}
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

        {/* Insider Intel Overlay */}
        {intelLoading && (
          <div className="intel-loading">⚡ Fetching intel...</div>
        )}
        {intel && !intelLoading && (
          <IntelBubble intel={intel} position={intelPos} />
        )}
      </div>

      {/* ── Legend ── */}
      <div className="chart-legend">
        {showMA5  && <span className="legend-item ma5">— MA5</span>}
        {showMA20 && <span className="legend-item ma20">— MA20</span>}
        <span className="legend-item up">■ Up</span>
        <span className="legend-item down">■ Down</span>
      </div>
    </div>
  );
}
