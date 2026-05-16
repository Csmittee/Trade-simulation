/**
 * ChartPanel.jsx
 * Candlestick + Line chart with MA5/MA20 overlay.
 *
 * Timeframe fix (Phase 2): clicking 1D/1W/1M now calls onTimeframeChange(tf)
 * so the parent injector can re-fetch historical data with the correct
 * range/interval from the Worker. Chart shows a loading spinner while fetching.
 *
 * Props:
 *   data              — OHLC candle array from injector
 *   symbol            — e.g. "XAUUSD", "PTT.BK"
 *   market            — "gold" | "set"
 *   timeframe         — "1D" | "1W" | "1M" (controlled by parent)
 *   historyLoading    — true while injector is fetching new timeframe data
 *   onTimeframeChange — (tf: "1D"|"1W"|"1M") => void
 *   onIntelRequest    — (symbol, date) => Promise<intel>
 */

import { useState, useRef, useCallback, useEffect } from "react";
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer,
} from "recharts";
import Tooltip from "./Tooltip.jsx";
import config from "../../config.js";

const CHART_MARGIN = { top: 8, right: 16, left: 8, bottom: 8 };
const Y_AXIS_WIDTH = 72;
const CHART_HEIGHT = 320;

// ── Moving Average ────────────────────────────────────────────────────────────
function calcMA(data, period) {
  // Only compute MA over real candles — skip gap markers entirely
  // otherwise MA drops to 0 across gaps causing dramatic vertical spikes
  return data.map((d, i) => {
    if (d.isGap || d.close == null) return { ...d, [`ma${period}`]: null };
    // Collect the last `period` real (non-gap) closes going backwards
    const realCloses = [];
    for (let j = i; j >= 0 && realCloses.length < period; j--) {
      if (!data[j].isGap && data[j].close != null) realCloses.push(data[j].close);
    }
    if (realCloses.length < period) return { ...d, [`ma${period}`]: null };
    const avg = realCloses.reduce((s, v) => s + v, 0) / period;
    return { ...d, [`ma${period}`]: parseFloat(avg.toFixed(2)) };
  });
}
function enrichData(raw) {
  let d = calcMA(raw, 5);
  d = calcMA(d, 20);
  return d;
}

// ── Candlestick SVG Overlay ───────────────────────────────────────────────────
function CandlestickOverlay({ data, containerWidth, yDomain }) {
  if (!data?.length || !containerWidth) return null;

  const drawW = containerWidth - CHART_MARGIN.left - CHART_MARGIN.right - Y_AXIS_WIDTH;
  const drawH = CHART_HEIGHT  - CHART_MARGIN.top  - CHART_MARGIN.bottom;
  const origX = CHART_MARGIN.left + Y_AXIS_WIDTH;
  const origY = CHART_MARGIN.top;

  // Use yDomain from parent (same as Recharts YAxis) so overlay aligns perfectly
  const yMin = yDomain?.[0] ?? Math.min(...data.flatMap(d => [d.low].filter(Boolean)));
  const yMax = yDomain?.[1] ?? Math.max(...data.flatMap(d => [d.high].filter(Boolean)));
  if (yMin === yMax) return null;

  const toY   = price => origY + drawH - ((price - yMin) / (yMax - yMin)) * drawH;
  const slotW = drawW / data.length;
  const bodyW = Math.max(2, Math.floor(slotW * 0.55));

  return (
    <svg style={{ position:"absolute", top:0, left:0, width:containerWidth, height:CHART_HEIGHT, pointerEvents:"none" }}>
      {data.map((d, i) => {
        // Skip gap markers — they render as blank space naturally
        if (d.isGap || d.open == null || d.close == null || d.high == null || d.low == null) return null;
        const isUp       = d.close >= d.open;
        const color      = isUp ? "#22c55e" : "#ef4444";
        const xC         = origX + i * slotW + slotW / 2;
        const yHigh      = toY(d.high);
        const yLow       = toY(d.low);
        const bodyTop    = Math.min(toY(d.open), toY(d.close));
        const bodyBottom = Math.max(toY(d.open), toY(d.close));
        const bodyH      = Math.max(2, bodyBottom - bodyTop);
        return (
          <g key={i}>
            <line x1={xC} y1={yHigh} x2={xC} y2={bodyTop} stroke={color} strokeWidth={1.5} />
            <rect x={xC - bodyW/2} y={bodyTop} width={bodyW} height={bodyH} fill={color} opacity={0.85} rx={1} />
            <line x1={xC} y1={bodyBottom} x2={xC} y2={yLow} stroke={color} strokeWidth={1.5} />
          </g>
        );
      })}
    </svg>
  );
}

// ── Price Tooltip ─────────────────────────────────────────────────────────────
function PriceTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const d    = payload[0]?.payload;
  if (!d) return null;
  const isUp   = d.close >= d.open;
  const change = d.open ? (((d.close - d.open) / d.open) * 100).toFixed(2) : null;
  return (
    <div className="price-tooltip">
      <div className="price-tooltip-time">{label}</div>
      <div className="price-tooltip-row">O <span>{d.open?.toLocaleString()}</span></div>
      <div className="price-tooltip-row">H <span style={{color:"#22c55e"}}>{d.high?.toLocaleString()}</span></div>
      <div className="price-tooltip-row">L <span style={{color:"#ef4444"}}>{d.low?.toLocaleString()}</span></div>
      <div className={`price-tooltip-row ${isUp?"up":"down"}`}>C <span>{d.close?.toLocaleString()}</span></div>
      {change !== null && <div className={`price-tooltip-row ${isUp?"up":"down"}`}>% <span>{isUp?"+":""}{change}%</span></div>}
      {d.ma5  && <div className="price-tooltip-row ma5">MA5 <span>{d.ma5?.toLocaleString()}</span></div>}
      {d.ma20 && <div className="price-tooltip-row ma20">MA20 <span>{d.ma20?.toLocaleString()}</span></div>}
    </div>
  );
}

// ── Intel Bubble ──────────────────────────────────────────────────────────────
function IntelBubble({ intel, position }) {
  if (!intel) return null;
  const color = { bullish:"#22c55e", bearish:"#ef4444", neutral:"#f59e0b" }[intel.sentiment] || "#888";
  return (
    <div className="intel-bubble" style={{ left:position.x, top:position.y }}>
      <div className="intel-header">
        <span className="intel-label">⚡ INSIDER INTEL</span>
        <span className="intel-sentiment" style={{color}}>{intel.sentiment?.toUpperCase()}</span>
        <span className="intel-confidence">{intel.confidence} confidence</span>
      </div>
      <ul className="intel-factors">{intel.factors?.map((f,i) => <li key={i}>{f}</li>)}</ul>
      {intel.cached && <div className="intel-cached-note">📦 Cached — last updated today</div>}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function ChartPanel({
  data = [],
  symbol,
  market,
  timeframe,           // controlled by parent
  historyLoading,      // true while injector re-fetches for new timeframe
  onTimeframeChange,   // (tf) => void — parent re-fetches when this fires
  onIntelRequest,
}) {
  const [chartType, setChartType]           = useState("candlestick");
  const [showMA5, setShowMA5]               = useState(true);
  const [showMA20, setShowMA20]             = useState(true);
  const [intel, setIntel]                   = useState(null);
  const [intelPos, setIntelPos]             = useState({ x:0, y:0 });
  const [intelLoading, setIntelLoading]     = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);

  const hoverTimer   = useRef(null);
  const intelCache   = useRef({});
  const containerRef = useRef(null);

  const enriched = enrichData(data);

  // Measure container for SVG overlay
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      setContainerWidth(Math.floor(entries[0].contentRect.width));
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Y domain — must match overlay calculation
  // Filter out gap markers for price calculations
  const realCandles = enriched.filter(d => !d.isGap && d.close != null);

  const yDomain = (() => {
    if (!realCandles.length) return ["auto", "auto"];
    const prices = realCandles.flatMap(d => [d.high, d.low].filter(Boolean));
    if (!prices.length) return ["auto", "auto"];
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const pad  = (maxP - minP) * 0.1 || maxP * 0.01;
    return [Math.floor(minP - pad), Math.ceil(maxP + pad)];
  })();

  // Clear intel cache when symbol or timeframe changes
  useEffect(() => { intelCache.current = {}; }, [symbol, timeframe]);

  const handleChartMouseMove = useCallback((chartData, event) => {
    if (!chartData?.activePayload?.[0]) return;
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(async () => {
      const d        = chartData.activePayload[0].payload;
      const dateKey  = d?.time || "unknown";
      const cacheKey = `${symbol}:${dateKey}`;
      let result = intelCache.current[cacheKey];
      if (!result) {
        setIntelLoading(true);
        try {
          result = await onIntelRequest(symbol, dateKey);
          intelCache.current[cacheKey] = result;
        } catch {
          result = { factors:["Intel unavailable — check Worker connection"], sentiment:"neutral", confidence:"low" };
        } finally {
          setIntelLoading(false);
        }
      }
      setIntelPos({ x:(event?.clientX||300)+12, y:(event?.clientY||200)-160 });
      setIntel({ ...result, cached:!!intelCache.current[cacheKey] });
    }, config.ai.hoverDelayMs);
  }, [symbol, onIntelRequest]);

  const handleChartMouseLeave = useCallback(() => {
    clearTimeout(hoverTimer.current);
    setIntel(null);
  }, []);

  const handleTimeframe = (tf) => {
    if (tf === timeframe) return;
    onTimeframeChange(tf);
  };

  const isLoading = historyLoading || (data.length === 0);

  return (
    <div className="chart-panel">
      {/* Controls */}
      <div className="chart-controls">
        <div className="chart-type-toggle">
          <Tooltip id="tooltip-chart-candlestick">
            <button className={`ctrl-btn ${chartType==="candlestick"?"active":""}`} onClick={()=>setChartType("candlestick")}>Candles</button>
          </Tooltip>
          <Tooltip id="tooltip-chart-line">
            <button className={`ctrl-btn ${chartType==="line"?"active":""}`} onClick={()=>setChartType("line")}>Line</button>
          </Tooltip>
        </div>
        <div className="timeframe-toggle">
          {["1D","1W","1M"].map(tf => (
            <Tooltip key={tf} id={`tooltip-chart-timeframe-${tf}`}>
              <button
                className={`ctrl-btn ${timeframe===tf?"active":""} ${historyLoading&&timeframe===tf?"loading":""}`}
                onClick={() => handleTimeframe(tf)}
                disabled={historyLoading}
              >
                {historyLoading && timeframe===tf ? "..." : tf}
              </button>
            </Tooltip>
          ))}
        </div>
        <div className="ma-toggles">
          <Tooltip id="tooltip-chart-ma5">
            <button className={`ma-btn ma5 ${showMA5?"active":""}`} onClick={()=>setShowMA5(v=>!v)}>MA5</button>
          </Tooltip>
          <Tooltip id="tooltip-chart-ma20">
            <button className={`ma-btn ma20 ${showMA20?"active":""}`} onClick={()=>setShowMA20(v=>!v)}>MA20</button>
          </Tooltip>
          <Tooltip id="tooltip-chart-insider">
            <span className="intel-hint">⚡ Hover 1.5s for intel</span>
          </Tooltip>
        </div>
      </div>

      {/* Chart */}
      <div className="chart-container" ref={containerRef} style={{ position:"relative", minHeight:CHART_HEIGHT }}>
        {isLoading ? (
          <div className="chart-loading">
            {historyLoading ? `Loading ${timeframe} data...` : "Loading price history..."}
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <ComposedChart data={enriched} margin={CHART_MARGIN}
                onMouseMove={handleChartMouseMove} onMouseLeave={handleChartMouseLeave}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="label"
                  tick={{fill:"#9ca3af",fontSize:10}}
                  tickLine={false}
                  axisLine={{stroke:"rgba(255,255,255,0.1)"}}
                  interval="preserveStartEnd"
                  tickFormatter={v => (!v || String(v).startsWith("gap")) ? "" : v}
                />
                <YAxis domain={yDomain} tick={{fill:"#9ca3af",fontSize:11}} tickLine={false}
                  axisLine={false} tickFormatter={v=>v.toLocaleString()} width={Y_AXIS_WIDTH} />
                <RechartsTooltip content={<PriceTooltip />} />
                <Line dataKey="close" stroke="transparent" dot={false} isAnimationActive={false} connectNulls={false} />
                {chartType==="line" && (
                  <Line type="monotone" dataKey="close" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
                )}
                {showMA5 && (
                  <Line type="monotone" dataKey="ma5" stroke="#60a5fa" strokeWidth={1.5} dot={false} strokeDasharray="4 2" isAnimationActive={false} connectNulls={false} />
                )}
                {showMA20 && (
                  <Line type="monotone" dataKey="ma20" stroke="#f97316" strokeWidth={1.5} dot={false} strokeDasharray="6 3" isAnimationActive={false} connectNulls={false} />
                )}
              </ComposedChart>
            </ResponsiveContainer>
            {chartType==="candlestick" && containerWidth>0 && (
              <CandlestickOverlay data={enriched} containerWidth={containerWidth} yDomain={yDomain} />
            )}
          </>
        )}
        {intelLoading && <div className="intel-loading">⚡ Fetching intel...</div>}
        {intel && !intelLoading && <IntelBubble intel={intel} position={intelPos} />}
      </div>

      {/* Legend */}
      <div className="chart-legend">
        {showMA5  && <span className="legend-item ma5">— MA5</span>}
        {showMA20 && <span className="legend-item ma20">— MA20</span>}
        <span className="legend-item up">■ Up</span>
        <span className="legend-item down">■ Down</span>
        <span className="legend-item" style={{color:"#4b5563",marginLeft:"auto"}}>
          {realCandles.length} candles
        </span>
      </div>
    </div>
  );
}
