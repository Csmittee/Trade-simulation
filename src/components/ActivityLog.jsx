/**
 * ActivityLog.jsx
 * Phase 4 — Real-time feed of all strategy and trade events.
 * Events grouped by hour. Each hour is collapsible.
 * Collapsed summary shows: count, buy/sell counts, total P&L impact.
 *
 * Event shape: { id, time, type, market, symbol, price, detail, pnl }
 * Types: signal | armed | disarm | buy | sell | sl | tp | block | info
 */

import { useRef, useEffect, useState } from "react";
import { TooltipIcon } from "./Tooltip.jsx";

const TYPE_META = {
  signal: { label: "SIGNAL", cls: "signal" },
  armed:  { label: "ARMED",  cls: "armed"  },
  disarm: { label: "DISARM", cls: "disarm" },
  buy:    { label: "BUY",    cls: "buy"    },
  sell:   { label: "SELL",   cls: "sell"   },
  sl:     { label: "SL HIT", cls: "sl"     },
  tp:     { label: "TP HIT", cls: "tp"     },
  block:  { label: "BLOCK",  cls: "block"  },
  info:   { label: "INFO",   cls: "info"   },
};

function formatTime(date) {
  return date instanceof Date
    ? date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : "--:--:--";
}

function getHourKey(date) {
  if (!(date instanceof Date)) return "00:00";
  return `${String(date.getHours()).padStart(2,"0")}:00`;
}

// Group events by hour key, preserving order
function groupByHour(events) {
  const map = {};
  const order = [];
  events.forEach(ev => {
    const key = getHourKey(ev.time instanceof Date ? ev.time : new Date(ev.time));
    if (!map[key]) { map[key] = []; order.push(key); }
    map[key].push(ev);
  });
  return order.map(key => ({ hour: key, events: map[key] }));
}

function HourGroup({ hour, events, defaultExpanded }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const buys   = events.filter(e => e.type === "buy").length;
  const sells  = events.filter(e => e.type === "sell").length;
  const blocks = events.filter(e => e.type === "block").length;
  const totalPnl = events.reduce((s, e) => s + (e.pnl || 0), 0);
  const hasPnl = events.some(e => e.pnl != null);
  const pnlUp  = totalPnl >= 0;

  return (
    <div className="activity-hour-group">
      <div className="activity-hour-header" onClick={() => setExpanded(v => !v)}>
        <span className="activity-hour-label">{hour}</span>
        <span className="activity-hour-summary">
          {events.length} event{events.length !== 1 ? "s" : ""}
          {buys  > 0 && <span className="ah-buy">  {buys} buy</span>}
          {sells > 0 && <span className="ah-sell"> {sells} sell</span>}
          {blocks > 0 && <span className="ah-block"> {blocks} blocked</span>}
          {hasPnl && (
            <span className={`ah-pnl ${pnlUp ? "up" : "down"}`}>
              {pnlUp ? "+" : ""}฿{Math.round(Math.abs(totalPnl)).toLocaleString()}
            </span>
          )}
        </span>
        <span className="activity-hour-toggle">{expanded ? "▼" : "▶"}</span>
      </div>

      {expanded && (
        <div className="activity-hour-events">
          {events.map(ev => {
            const m = TYPE_META[ev.type] || TYPE_META.info;
            const evPnlUp = (ev.pnl || 0) >= 0;
            return (
              <div key={ev.id} className="activity-row">
                <span className="activity-time">{formatTime(ev.time instanceof Date ? ev.time : new Date(ev.time))}</span>
                <span className={`activity-badge ${m.cls}`}>{m.label}</span>
                <span className="activity-symbol">{ev.symbol?.replace(".BK","") || ev.market?.toUpperCase()}</span>
                <span className="activity-detail">{ev.detail}</span>
                {ev.pnl != null ? (
                  <span className={`activity-pnl ${evPnlUp ? "up" : "down"}`}>
                    {evPnlUp ? "+" : ""}฿{Math.abs(ev.pnl).toLocaleString("en-US",{maximumFractionDigits:0})}
                  </span>
                ) : ev.price != null ? (
                  <span className="activity-pnl neutral">฿{ev.price.toLocaleString("en-US",{maximumFractionDigits:0})}</span>
                ) : <span />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function ActivityLog({ events = [], onClear }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div className="activity-log">
        <div className="activity-empty">No events yet — start or arm a strategy to see the feed.</div>
      </div>
    );
  }

  const groups = groupByHour(events);

  return (
    <div className="activity-log">
      <div className="activity-feed">
        {groups.map((g, i) => (
          <HourGroup
            key={g.hour}
            hour={g.hour}
            events={g.events}
            defaultExpanded={i === groups.length - 1} // latest hour open by default
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

/**
 * Helper — build a well-shaped event object.
 */
export function makeActivityEvent({ type, market, symbol, price = null, detail = "", pnl = null }) {
  return {
    id:     `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    time:   new Date(),
    type,
    market,
    symbol,
    price,
    detail,
    pnl,
  };
}

