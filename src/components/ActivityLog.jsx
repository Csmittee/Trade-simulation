 /**
 * ActivityLog.jsx
 * Phase 4 — Real-time feed of all strategy and trade events.
 * Lives in Panel 3 (right half). Events pushed from market pages via onActivityEvent.
 *
 * Event shape:
 *   { id, time, type, market, symbol, price, detail, pnl }
 *
 * Types: signal | armed | disarm | buy | sell | sl | tp | block | info
 */

import { useRef, useEffect } from "react";
import { TooltipIcon } from "./Tooltip.jsx";

// Badge label and CSS class per event type
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
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export default function ActivityLog({ events = [], onClear }) {
  const bottomRef = useRef(null);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  const meta = (type) => TYPE_META[type] || TYPE_META.info;

  return (
    <div className="activity-log">
      {events.length === 0 ? (
        <div className="activity-empty">
          No events yet — start or arm a strategy to see the feed.
        </div>
      ) : (
        <div className="activity-feed">
          {events.map(ev => {
            const m = meta(ev.type);
            const hasPnl = ev.pnl != null;
            const pnlUp  = hasPnl && ev.pnl >= 0;
            return (
              <div key={ev.id} className="activity-row">
                <span className="activity-time">{formatTime(ev.time)}</span>
                <span className={`activity-badge ${m.cls}`}>{m.label}</span>
                <span className="activity-symbol">{ev.symbol?.replace(".BK", "") || ev.market?.toUpperCase()}</span>
                <span className="activity-detail">{ev.detail}</span>
                {hasPnl ? (
                  <span className={`activity-pnl ${pnlUp ? "up" : "down"}`}>
                    {pnlUp ? "+" : ""}฿{Math.abs(ev.pnl).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  </span>
                ) : (
                  ev.price != null ? (
                    <span className="activity-pnl neutral">฿{ev.price.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                  ) : <span />
                )}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}

/**
 * Helper — call this anywhere to build a well-shaped event object.
 * Usage: pushEvent({ type:"buy", market:"gold", symbol:"THAI_GOLD_BAHT", price:45200, detail:"MA Crossover auto-buy x2" })
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
