/**
 * ActivityLog.jsx
 * Phase 5 patch:
 * - Load More button (12hr back per click) — uses onLoadMore / logLoading / logHasMore props
 * - Hour group key now includes date (YYYY-MM-DD HH:00) so multi-day D1 logs
 *   don't collide (e.g. yesterday's 10:00 and today's 10:00 are separate groups)
 * - Gap banner shown when D1 logs have a time gap > 30 min between last D1 event
 *   and first live session event (shows "Away X hrs Y min" between groups)
 * - All Phase 4 behavior unchanged
 *
 * Event shape: { id, time, type, market, symbol, price, detail, pnl, fromD1? }
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

function formatDateLabel(date) {
  if (!(date instanceof Date)) return "";
  const today     = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const isToday     = date.toDateString() === today.toDateString();
  const isYesterday = date.toDateString() === yesterday.toDateString();
  if (isToday)     return "Today";
  if (isYesterday) return "Yesterday";
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// Group key includes date so multi-day logs don't collide
function getHourKey(date) {
  if (!(date instanceof Date)) return "1970-01-01 00:00";
  const yyyy = date.getFullYear();
  const mm   = String(date.getMonth() + 1).padStart(2, "0");
  const dd   = String(date.getDate()).padStart(2, "0");
  const hh   = String(date.getHours()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:00`;
}

// Human-readable label for a group key
function hourKeyLabel(key) {
  // key format: "2026-05-19 14:00"
  const parts = key.split(" ");
  if (parts.length < 2) return key;
  const date  = new Date(parts[0]);
  const dateLabel = formatDateLabel(date);
  return `${dateLabel} ${parts[1]}`;
}

// Group events by date+hour key, preserving order
function groupByHour(events) {
  const map   = {};
  const order = [];
  events.forEach(ev => {
    const t   = ev.time instanceof Date ? ev.time : new Date(ev.time);
    const key = getHourKey(t);
    if (!map[key]) { map[key] = []; order.push(key); }
    map[key].push(ev);
  });
  return order.map(key => ({ key, label: hourKeyLabel(key), events: map[key] }));
}

// Detect away gap: find the boundary between fromD1=true and fromD1=false events
function findAwayGap(events) {
  // Events are in order oldest→newest
  // Find last D1 event index and first live event index
  let lastD1Idx   = -1;
  let firstLiveIdx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].fromD1)  lastD1Idx = i;
  }
  for (let i = 0; i < events.length; i++) {
    if (!events[i].fromD1) { firstLiveIdx = i; break; }
  }
  if (lastD1Idx === -1 || firstLiveIdx === -1) return null;
  if (firstLiveIdx <= lastD1Idx) return null; // no clear boundary

  const lastD1Time   = events[lastD1Idx].time instanceof Date ? events[lastD1Idx].time : new Date(events[lastD1Idx].time);
  const firstLiveTime = events[firstLiveIdx].time instanceof Date ? events[firstLiveIdx].time : new Date(events[firstLiveIdx].time);
  const gapMs = firstLiveTime - lastD1Time;
  if (gapMs < 30 * 60 * 1000) return null; // less than 30 min — no banner

  const gapMins = Math.round(gapMs / 60000);
  const hrs  = Math.floor(gapMins / 60);
  const mins = gapMins % 60;
  const label = hrs > 0
    ? `Away ${hrs}hr${hrs > 1 ? "s" : ""}${mins > 0 ? ` ${mins}min` : ""}`
    : `Away ${mins}min`;

  // Return the group key after which the gap appears
  const t   = events[lastD1Idx].time instanceof Date ? events[lastD1Idx].time : new Date(events[lastD1Idx].time);
  return { afterKey: getHourKey(t), label };
}

// ── HourGroup ─────────────────────────────────────────────────────────────────
function HourGroup({ label, events, defaultExpanded }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const buys    = events.filter(e => e.type === "buy").length;
  const sells   = events.filter(e => e.type === "sell").length;
  const blocks  = events.filter(e => e.type === "block").length;
  const totalPnl = events.reduce((s, e) => s + (e.pnl || 0), 0);
  const hasPnl  = events.some(e => e.pnl != null);
  const pnlUp   = totalPnl >= 0;

  return (
    <div className="activity-hour-group">
      <div className="activity-hour-header" onClick={() => setExpanded(v => !v)}>
        <span className="activity-hour-label">{label}</span>
        <span className="activity-hour-summary">
          {events.length} event{events.length !== 1 ? "s" : ""}
          {buys   > 0 && <span className="ah-buy">   {buys} buy</span>}
          {sells  > 0 && <span className="ah-sell">  {sells} sell</span>}
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
            const m      = TYPE_META[ev.type] || TYPE_META.info;
            const evPnlUp = (ev.pnl || 0) >= 0;
            return (
              <div key={ev.id} className={`activity-row${ev.fromD1 ? " from-d1" : ""}`}>
                <span className="activity-time">{formatTime(ev.time instanceof Date ? ev.time : new Date(ev.time))}</span>
                <span className={`activity-badge ${m.cls}`}>{m.label}</span>
                <span className="activity-symbol">{ev.symbol?.replace(".BK","") || ev.market?.toUpperCase()}</span>
                <span className="activity-detail">{ev.detail || ev.message}</span>
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

// ── Away gap banner ───────────────────────────────────────────────────────────
function AwayBanner({ label }) {
  return (
    <div className="activity-away-banner">
      <span className="away-line" />
      <span className="away-label">⏸ {label}</span>
      <span className="away-line" />
    </div>
  );
}

// ── Main ActivityLog ──────────────────────────────────────────────────────────
export default function ActivityLog({
  events     = [],
  onClear,
  onLoadMore,        // () => void — load 12hrs further back
  logLoading = false,
  logHasMore = false,
}) {
  const bottomRef = useRef(null);

  // Auto-scroll to bottom only when new live events arrive (not when loading older)
  const prevLengthRef = useRef(events.length);
  useEffect(() => {
    const prev = prevLengthRef.current;
    prevLengthRef.current = events.length;
    // If events were prepended (load more) don't scroll — count grew from front
    // Simple heuristic: if last event time > prev last event time, it's a new live event
    if (events.length > prev) {
      const lastEv = events[events.length - 1];
      if (lastEv && !lastEv.fromD1) {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    }
  }, [events.length]);

  const groups  = groupByHour(events);
  const awayGap = findAwayGap(events);

  if (events.length === 0 && !logLoading) {
    return (
      <div className="activity-log">
        {onLoadMore && logHasMore && (
          <button className="activity-load-more-btn" onClick={onLoadMore} disabled={logLoading}>
            {logLoading ? "Loading..." : "⬆ Load 12hr back"}
          </button>
        )}
        <div className="activity-empty">No events yet — start or arm a strategy to see the feed.</div>
      </div>
    );
  }

  return (
    <div className="activity-log">

      {/* Load More — top of log */}
      {onLoadMore && (logHasMore || logLoading) && (
        <button
          className="activity-load-more-btn"
          onClick={onLoadMore}
          disabled={logLoading}
        >
          {logLoading ? "⏳ Loading..." : "⬆ Load 12hr back"}
        </button>
      )}

      <div className="activity-feed">
        {groups.map((g, i) => (
          <div key={g.key}>
            <HourGroup
              label={g.label}
              events={g.events}
              defaultExpanded={i === groups.length - 1}
            />
            {/* Away gap banner — shown after the last D1 group before live events */}
            {awayGap && g.key === awayGap.afterKey && (
              <AwayBanner label={awayGap.label} />
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

/**
 * Helper — build a well-shaped event object.
 * Always call this when creating events manually.
 */
export function makeActivityEvent({ type, market, symbol, price = null, detail = "", pnl = null, strategy = null, message = "" }) {
  return {
    id:       `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    time:     new Date(),
    type,
    market,
    symbol,
    price,
    detail:   detail || message,
    message:  detail || message,
    pnl,
    strategy,
  };
}
