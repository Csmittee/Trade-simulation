/**
 * D1Tab.jsx — Phase 8c
 * Two-panel layout: left (query selector + fields) | right (results + SQL)
 * Ghost Buys: 24h-old orphan filter + per-record Delete SQL generator
 * Confirm Reset SQL removed (too dangerous)
 */

import { useState, useCallback } from "react";
import config from "../../config.js";

const WORKER = config.workers.base;

// ── Query registry ────────────────────────────────────────────────────────────
const QUERIES = [
  { id: "recent",   label: "Recent Trades", icon: "🕐", mode: "read" },
  { id: "symbol",   label: "By Symbol",     icon: "🔍", mode: "read" },
  { id: "ghost",    label: "Ghost Buys",    icon: "👻", mode: "read" },
  { id: "executor", label: "By Executor",   icon: "🤖", mode: "read" },
  { id: "trash",    label: "Find Trash",    icon: "🗑",  mode: "read" },
  { id: "summary",  label: "P&L Summary",  icon: "📊", mode: "read" },
  { id: "actlog",   label: "Activity Log", icon: "📋", mode: "read" },
  { id: "dbcount",  label: "DB Count",     icon: "🔢", mode: "read" },
];

const QUERY_DESCS = {
  ghost:   "Open buys older than 24h with no exit price — orphaned records from previous sessions",
  trash:   "Records with missing critical fields",
  dbcount: "Total counts across the trades table",
};

const DEFAULT_FIELDS = {
  recent:   { period: "7d",  side: "all" },
  symbol:   { symbol: "",    side: "all" },
  ghost:    {},
  executor: { executor: "all" },
  trash:    {},
  summary:  { group: "day" },
  actlog:   { period: "7d", type: "all" },
  dbcount:  {},
};

// ── Date helpers ──────────────────────────────────────────────────────────────
function getFromDate(period) {
  if (period === "today") return new Date().toISOString().slice(0, 10);
  if (period === "7d")  { const d = new Date(); d.setDate(d.getDate() - 7);  return d.toISOString().slice(0, 10); }
  if (period === "30d") { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); }
  return null;
}

// ── Fetch logic ───────────────────────────────────────────────────────────────
async function fetchResults(queryId, fields) {
  const params = new URLSearchParams({ limit: 200 });

  if (queryId === "recent") {
    const from = getFromDate(fields.period || "7d");
    if (from) params.set("from", from);
    if (fields.side && fields.side !== "all") params.set("side", fields.side);
    const res = await fetch(`${WORKER}/api/trades?${params}`);
    return (await res.json()).data || [];
  }
  if (queryId === "symbol") {
    let sym = (fields.symbol || "").trim().toUpperCase();
    if (sym && !sym.includes(".")) sym += ".BK";
    if (sym) params.set("symbol", sym);
    if (fields.side && fields.side !== "all") params.set("side", fields.side);
    const res = await fetch(`${WORKER}/api/trades?${params}`);
    return (await res.json()).data || [];
  }
  if (queryId === "ghost") {
    // Only orphans older than 24h — excludes today's active positions
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const res = await fetch(`${WORKER}/api/trades?open=true&before=${cutoff}&limit=200`);
    return (await res.json()).data || [];
  }
  if (queryId === "executor") {
    if (fields.executor && fields.executor !== "all") params.set("executor", fields.executor);
    const res = await fetch(`${WORKER}/api/trades?${params}`);
    return (await res.json()).data || [];
  }
  if (queryId === "trash") {
    const res = await fetch(`${WORKER}/api/trades?trash=true&limit=200`);
    return (await res.json()).data || [];
  }
  if (queryId === "summary") {
    const res = await fetch(`${WORKER}/api/trades/summary?group=${fields.group || "day"}`);
    return (await res.json()).data || [];
  }
  if (queryId === "actlog") {
    const from = getFromDate(fields.period || "7d");
    if (from) params.set("from", from);
    if (fields.type && fields.type !== "all") params.set("type", fields.type);
    const res = await fetch(`${WORKER}/api/logs?${params}`);
    return (await res.json()).data || [];
  }
  if (queryId === "dbcount") {
    const res = await fetch(`${WORKER}/api/trades/count`);
    const d = await res.json();
    return d.data ? [d.data] : [];
  }
  return [];
}

// ── SQL generator ─────────────────────────────────────────────────────────────
function generateSQL(queryId, fields) {
  const from = getFromDate(fields.period) || "—";

  switch (queryId) {
    case "recent": {
      const lines = [`SELECT * FROM trades\nWHERE opened_at >= '${from}'`];
      if (fields.side && fields.side !== "all") lines.push(`  AND side = '${fields.side}'`);
      lines.push("ORDER BY opened_at DESC LIMIT 200;");
      return lines.join("\n");
    }
    case "symbol": {
      let sym = (fields.symbol || "").trim().toUpperCase();
      if (sym && !sym.includes(".")) sym += ".BK";
      const lines = [`SELECT * FROM trades\nWHERE symbol = '${sym || "SYMBOL"}'`];
      if (fields.side && fields.side !== "all") lines.push(`  AND side = '${fields.side}'`);
      lines.push("ORDER BY opened_at DESC LIMIT 200;");
      return lines.join("\n");
    }
    case "ghost": {
      const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
      return `SELECT * FROM trades\nWHERE side = 'buy'\n  AND (exit_price IS NULL OR closed_at IS NULL)\n  AND opened_at < '${cutoff}'\nORDER BY opened_at DESC;`;
    }
    case "executor": {
      const where =
        fields.executor === "preset"   ? "WHERE strategy != 'manual'\n  AND strategy NOT LIKE 'ai_%'"
        : fields.executor === "ai"     ? "WHERE (strategy LIKE 'ai_%'\n   OR strategy = 'ai_workflow')"
        : fields.executor === "manual" ? "WHERE strategy = 'manual'"
        :                                "WHERE 1=1 -- all executors";
      return `SELECT * FROM trades\n${where}\nORDER BY opened_at DESC LIMIT 200;`;
    }
    case "trash":
      return "SELECT * FROM trades\nWHERE symbol IS NULL OR market IS NULL\n   OR qty IS NULL OR entry_price IS NULL OR opened_at IS NULL;";
    case "summary": {
      const grp =
        fields.group === "week"  ? "strftime('%Y-W%W', closed_at)"
        : fields.group === "month" ? "strftime('%Y-%m', closed_at)"
        :                            "DATE(closed_at)";
      return [
        `SELECT ${grp} as period,`,
        "       COUNT(*) as trades,",
        "       ROUND(SUM(pnl),2) as total_pnl,",
        "       SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) as wins,",
        "       SUM(CASE WHEN pnl<=0 THEN 1 ELSE 0 END) as losses",
        "FROM trades WHERE side='sell' AND pnl IS NOT NULL",
        `GROUP BY ${grp} ORDER BY period DESC;`,
      ].join("\n");
    }
    case "actlog": {
      const lines = [`SELECT * FROM activity_log\nWHERE created_at >= '${from}'`];
      if (fields.type && fields.type !== "all") lines.push(`  AND type = '${fields.type}'`);
      lines.push("ORDER BY created_at DESC LIMIT 200;");
      return lines.join("\n");
    }
    case "dbcount":
      return [
        "SELECT COUNT(*) as total_trades,",
        "       COUNT(CASE WHEN side='buy' THEN 1 END) as buys,",
        "       COUNT(CASE WHEN side='sell' THEN 1 END) as sells,",
        "       COUNT(CASE WHEN side='buy' AND exit_price IS NULL THEN 1 END) as open_buys",
        "FROM trades;",
      ].join("\n");
    default:
      return "";
  }
}

// ── Column definitions ────────────────────────────────────────────────────────
const fmtTs  = v => v ? new Date(v).toLocaleString("en-US", {
  month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
  hour12: false, timeZone: "Asia/Bangkok",
}) : "—";
const fmtTHB = v => v != null ? `฿${parseFloat(v).toFixed(2)}` : "—";
const fmtPnl = v => v != null ? `${v >= 0 ? "+" : ""}฿${Math.round(v).toLocaleString()}` : "—";

const TRADE_COLS = [
  { key: "opened_at",   label: "Opened",   fmt: fmtTs },
  { key: "symbol",      label: "Symbol",   fmt: v => v?.replace(".BK", "") || "—" },
  { key: "market",      label: "Mkt" },
  { key: "side",        label: "Side",     fmt: v => v === "buy" ? "▲ BUY" : "▼ SELL" },
  { key: "qty",         label: "Qty",      fmt: v => v?.toLocaleString() ?? "—" },
  { key: "entry_price", label: "Entry",    fmt: fmtTHB },
  { key: "exit_price",  label: "Exit",     fmt: fmtTHB },
  { key: "pnl",         label: "P&L",      fmt: fmtPnl },
  { key: "strategy",    label: "Strategy" },
  { key: "closed_at",   label: "Closed",   fmt: fmtTs },
];

const SUMMARY_COLS = [
  { key: "period",    label: "Period" },
  { key: "trades",    label: "Trades" },
  { key: "total_pnl", label: "Total P&L", fmt: fmtPnl },
  { key: "wins",      label: "Wins" },
  { key: "losses",    label: "Losses" },
];

const ACTLOG_COLS = [
  { key: "logged_at", label: "Time",    fmt: fmtTs },
  { key: "type",      label: "Type" },
  { key: "market",    label: "Market" },
  { key: "message",   label: "Message" },
  { key: "detail",    label: "Detail" },
];

const DBCOUNT_COLS = [
  { key: "total_trades", label: "Total Trades" },
  { key: "buys",         label: "Buys" },
  { key: "sells",        label: "Sells" },
  { key: "open_buys",    label: "Ghost Buys (no exit)" },
];

function getColumns(queryId) {
  if (["recent", "symbol", "ghost", "executor", "trash"].includes(queryId)) return TRADE_COLS;
  if (queryId === "summary") return SUMMARY_COLS;
  if (queryId === "actlog")  return ACTLOG_COLS;
  if (queryId === "dbcount") return DBCOUNT_COLS;
  return [];
}

function getRowClass(queryId, row) {
  if (queryId === "ghost") return "d1-row--ghost";
  if (!row.exit_price && row.side === "buy") return "d1-row--ghost";
  if (row.pnl != null && row.pnl > 0) return "d1-row--win";
  if (row.pnl != null && row.pnl < 0) return "d1-row--loss";
  return "";
}

// ── Copy hook ─────────────────────────────────────────────────────────────────
function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((text) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);
  return [copied, copy];
}

// ── Field inputs per query ────────────────────────────────────────────────────
function QueryFields({ queryId, fields, onChange }) {
  const set = (k, v) => onChange({ ...fields, [k]: v });
  switch (queryId) {
    case "recent":
      return (
        <>
          <div className="d1-field">
            <label>Period</label>
            <select value={fields.period} onChange={e => set("period", e.target.value)}>
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="all">All time</option>
            </select>
          </div>
          <div className="d1-field">
            <label>Side</label>
            <select value={fields.side} onChange={e => set("side", e.target.value)}>
              <option value="all">All</option>
              <option value="buy">Buy only</option>
              <option value="sell">Sell only</option>
            </select>
          </div>
        </>
      );
    case "symbol":
      return (
        <>
          <div className="d1-field">
            <label>Symbol</label>
            <input
              type="text"
              value={fields.symbol}
              onChange={e => set("symbol", e.target.value)}
              placeholder="e.g. GULF"
            />
          </div>
          <div className="d1-field">
            <label>Side</label>
            <select value={fields.side} onChange={e => set("side", e.target.value)}>
              <option value="all">All</option>
              <option value="buy">Buy only</option>
              <option value="sell">Sell only</option>
            </select>
          </div>
        </>
      );
    case "executor":
      return (
        <div className="d1-field">
          <label>Executor</label>
          <select value={fields.executor} onChange={e => set("executor", e.target.value)}>
            <option value="all">All</option>
            <option value="manual">Manual</option>
            <option value="preset">Preset Strategy</option>
            <option value="ai">AI Workflow</option>
          </select>
        </div>
      );
    case "summary":
      return (
        <div className="d1-field">
          <label>Group by</label>
          <select value={fields.group} onChange={e => set("group", e.target.value)}>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </div>
      );
    case "actlog":
      return (
        <>
          <div className="d1-field">
            <label>Period</label>
            <select value={fields.period} onChange={e => set("period", e.target.value)}>
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </div>
          <div className="d1-field">
            <label>Type</label>
            <select value={fields.type} onChange={e => set("type", e.target.value)}>
              <option value="all">All</option>
              <option value="buy">buy</option>
              <option value="sell">sell</option>
              <option value="strategy">strategy</option>
              <option value="block">block</option>
            </select>
          </div>
        </>
      );
    default:
      return null;
  }
}

// ── Main component ────────────────────────────────────────────────────────────
export default function D1Tab() {
  const [selectedQuery, setSelectedQuery] = useState(null);
  const [fields,        setFields]        = useState({});
  const [results,       setResults]       = useState([]);
  const [generatedSQL,  setGeneratedSQL]  = useState("");
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState("");
  const [showSQL,       setShowSQL]       = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [deleteSQL,     setDeleteSQL]     = useState("");

  const [copiedSQL, copySQL] = useCopy();
  const [copiedDel, copyDel] = useCopy();

  const selectQuery = useCallback((id) => {
    setSelectedQuery(id);
    setFields(DEFAULT_FIELDS[id] || {});
    setResults([]);
    setError("");
    setGeneratedSQL("");
    setDeleteSQL("");
    setShowSQL(false);
  }, []);

  const handleFetch = useCallback(async () => {
    if (!selectedQuery) return;
    setLoading(true);
    setError("");
    setResults([]);
    setDeleteSQL("");
    try {
      const rows = await fetchResults(selectedQuery, fields);
      setResults(rows);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [selectedQuery, fields]);

  const handleGetSQL = useCallback(() => {
    if (!selectedQuery) return;
    setGeneratedSQL(generateSQL(selectedQuery, fields));
    setShowSQL(true);
  }, [selectedQuery, fields]);

  const handleGenerateDeleteSQL = useCallback(() => {
    if (!results.length) return;
    const ids = results.map(r => `'${r.id}'`).join(", ");
    setDeleteSQL(`DELETE FROM trades WHERE id IN (${ids});`);
  }, [results]);

  const query         = QUERIES.find(q => q.id === selectedQuery);
  const cols          = selectedQuery ? getColumns(selectedQuery) : [];
  const showDeleteBtn = selectedQuery === "ghost" && results.length > 0 && !deleteSQL;

  return (
    <div className="d1-wrap">

      {/* ── LEFT PANEL ── */}
      {!leftCollapsed && (
        <div className="d1-left">
          <div className="d1-left-header">🗄 D1 Query Builder</div>
          <div className="d1-left-sub">Pick a query, set filters, fetch live results or copy SQL</div>

          <div className="d1-query-grid">
            {QUERIES.map(q => (
              <button
                key={q.id}
                className={`d1-query-btn ${selectedQuery === q.id ? "active" : ""}`}
                onClick={() => selectQuery(q.id)}
              >
                <div>{q.icon}</div>
                <div>{q.label}</div>
              </button>
            ))}
          </div>

          {selectedQuery && (
            <>
              <hr className="d1-divider" />
              <div className="d1-query-title">{query?.icon} {query?.label}</div>
              {QUERY_DESCS[selectedQuery] && (
                <div className="d1-query-desc">{QUERY_DESCS[selectedQuery]}</div>
              )}
              <QueryFields queryId={selectedQuery} fields={fields} onChange={setFields} />
              <div className="d1-action-row">
                <button className="d1-fetch-btn" onClick={handleFetch} disabled={loading}>
                  {loading ? "Fetching…" : "Fetch Results"}
                </button>
                <button
                  className={`d1-sql-btn ${showSQL ? "active" : ""}`}
                  onClick={handleGetSQL}
                >
                  SQL
                </button>
              </div>
            </>
          )}

          <div className="d1-instructions">
            <div className="d1-instructions-title">Run SQL manually</div>
            <ol>
              <li>Cloudflare → D1 → <code>tts-db</code> → Console</li>
              <li>Paste SQL → click Run</li>
            </ol>
          </div>
        </div>
      )}

      {/* ── RIGHT PANEL ── */}
      <div className="d1-right">

        {/* Right header bar */}
        <div className="d1-right-header">
          <button className="d1-toggle-btn" onClick={() => setLeftCollapsed(v => !v)}>
            {leftCollapsed ? "show controls ▶" : "◀ hide controls"}
          </button>
          <span className="d1-right-title">
            {query ? `${query.icon} ${query.label}` : "Select a query ←"}
          </span>
          {results.length > 0 && (
            <span className="d1-record-count">{results.length} records</span>
          )}
        </div>

        {/* Loading */}
        {loading && <div className="d1-loading">⏳ Fetching from D1…</div>}

        {/* Error */}
        {!loading && error && <div className="d1-error">⚠ {error}</div>}

        {/* Results table */}
        {!loading && !error && results.length > 0 && (
          <div className="d1-table-wrap">
            <table className="d1-table">
              <thead>
                <tr>{cols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {results.map((row, i) => (
                  <tr key={i} className={getRowClass(selectedQuery, row)}>
                    {cols.map(c => (
                      <td
                        key={c.key}
                        className={
                          (c.key === "pnl" || c.key === "total_pnl")
                            ? (row[c.key] > 0 ? "d1-pnl-up" : row[c.key] < 0 ? "d1-pnl-down" : "")
                            : ""
                        }
                      >
                        {c.fmt ? c.fmt(row[c.key]) : (row[c.key] ?? "—")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && results.length === 0 && selectedQuery && (
          <div className="d1-empty">No records found. Try different filters or click Fetch Results.</div>
        )}

        {/* Ghost buys: Delete SQL generator button */}
        {showDeleteBtn && (
          <button className="d1-delete-btn" onClick={handleGenerateDeleteSQL}>
            ⚠️ Generate Delete SQL for these {results.length} records
          </button>
        )}

        {/* Delete SQL output */}
        {deleteSQL && (
          <div className="d1-sql-panel">
            <div className="d1-warning-banner">
              ⚠️ Permanently deletes {results.length} records. Paste ONLY in Cloudflare D1 console.
            </div>
            <pre className="d1-sql-block">{deleteSQL}</pre>
            <div className="d1-sql-actions">
              <button className={`d1-copy-btn ${copiedDel ? "success" : ""}`} onClick={() => copyDel(deleteSQL)}>
                {copiedDel ? "Copied ✓" : "Copy Delete SQL"}
              </button>
            </div>
          </div>
        )}

        {/* SQL panel (Get SQL button) */}
        {showSQL && generatedSQL && (
          <div className="d1-sql-panel">
            <pre className="d1-sql-block">{generatedSQL}</pre>
            <div className="d1-sql-actions">
              <button className={`d1-copy-btn ${copiedSQL ? "success" : ""}`} onClick={() => copySQL(generatedSQL)}>
                {copiedSQL ? "Copied ✓" : "Copy SQL"}
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
