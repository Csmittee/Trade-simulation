/**
 * D1Tab.jsx
 * Phase 8b — D1 Live Results
 * READ queries fetch real data from Worker and display as a table.
 * Every result also shows the Worker API URL + equivalent SQL so you
 * can learn what ran and copy it to Cloudflare D1 console if needed.
 * SQL-only mode (⚠️ Confirm Reset SQL) never executes — generates text only.
 */

import { useState, useCallback } from "react";
import config from "../../config.js";

const WORKER = config.workers.base;

// ── Query registry ────────────────────────────────────────────────────────────
const QUERIES = [
  { id: "recent",    label: "Recent Trades",    icon: "🕐", mode: "read" },
  { id: "symbol",    label: "By Symbol",         icon: "🔍", mode: "read" },
  { id: "ghost",     label: "Ghost Buys",        icon: "👻", mode: "read" },
  { id: "executor",  label: "By Executor",       icon: "🤖", mode: "read" },
  { id: "trash",     label: "Find Trash Data",   icon: "🗑",  mode: "read" },
  { id: "summary",   label: "P&L Summary",       icon: "📊", mode: "read" },
  { id: "actlog",    label: "Activity Log",      icon: "📋", mode: "read" },
  { id: "dbcount",   label: "DB Count",          icon: "🔢", mode: "read" },
  { id: "reset_sql", label: "Confirm Reset SQL", icon: "⚠️", mode: "sql"  },
];

const QUERY_DESCS = {
  ghost:     "Open buy positions with no exit_price — trades that vanished from radar.",
  trash:     "Records missing critical fields — useful for spotting corrupted data.",
  dbcount:   "Quick count of all trades. Run after Reset to confirm the database is empty.",
  reset_sql: "Generates DELETE SQL for manual use in Cloudflare D1 console only — never executes here.",
};

const DEFAULT_FIELDS = {
  recent:    { period: "today", side: "all" },
  symbol:    { symbol: "", side: "all" },
  ghost:     {},
  executor:  { executor: "all" },
  trash:     {},
  summary:   { group: "day" },
  actlog:    { period: "today", type: "all" },
  dbcount:   {},
  reset_sql: {},
};

// ── Date helpers ──────────────────────────────────────────────────────────────
function getFromDate(period) {
  if (!period || period === "all") return null;
  const now = new Date();
  if (period === "today") return now.toISOString().slice(0, 10);
  if (period === "7d")  { now.setDate(now.getDate() - 7);  return now.toISOString().slice(0, 10); }
  if (period === "30d") { now.setDate(now.getDate() - 30); return now.toISOString().slice(0, 10); }
  return null;
}

// ── Fetch logic ───────────────────────────────────────────────────────────────
async function fetchQuery(queryId, fields) {
  let fetchUrl;

  switch (queryId) {
    case "recent": {
      const from = getFromDate(fields.period);
      const p = new URLSearchParams({ limit: "200" });
      if (from) p.set("from", from);
      if (fields.side && fields.side !== "all") p.set("side", fields.side);
      fetchUrl = `${WORKER}/api/trades?${p}`;
      break;
    }
    case "symbol": {
      const raw = (fields.symbol || "").trim().toUpperCase();
      const sym = raw && !raw.includes(".BK") ? raw + ".BK" : raw;
      const p = new URLSearchParams({ limit: "200" });
      if (sym) p.set("symbol", sym);
      if (fields.side && fields.side !== "all") p.set("side", fields.side);
      fetchUrl = `${WORKER}/api/trades?${p}`;
      break;
    }
    case "ghost":
      fetchUrl = `${WORKER}/api/trades?open=true&limit=200`;
      break;
    case "executor": {
      const p = new URLSearchParams({ limit: "200" });
      if (fields.executor && fields.executor !== "all") p.set("executor", fields.executor);
      fetchUrl = `${WORKER}/api/trades?${p}`;
      break;
    }
    case "trash":
      fetchUrl = `${WORKER}/api/trades?trash=true&limit=200`;
      break;
    case "summary":
      fetchUrl = `${WORKER}/api/trades/summary?group=${fields.group || "day"}`;
      break;
    case "actlog": {
      const from = getFromDate(fields.period);
      const p = new URLSearchParams({ limit: "200" });
      if (from) p.set("from", from);
      if (fields.type && fields.type !== "all") p.set("type", fields.type);
      fetchUrl = `${WORKER}/api/logs?${p}`;
      break;
    }
    case "dbcount":
      fetchUrl = `${WORKER}/api/trades/count`;
      break;
    default:
      return { rows: [], fetchUrl: "", error: "Unknown query type" };
  }

  try {
    const res  = await fetch(fetchUrl);
    const json = await res.json();
    const rows = json.data
      ? (Array.isArray(json.data) ? json.data : [json.data])
      : [];
    return { rows, fetchUrl, error: json.error || null };
  } catch (err) {
    return { rows: [], fetchUrl, error: err.message };
  }
}

// ── Equivalent SQL builder (mirrors Worker query logic) ───────────────────────
function buildEquivalentSQL(queryId, fields) {
  const from = getFromDate(fields.period) || "—";

  switch (queryId) {
    case "recent": {
      const lines = [`SELECT * FROM trades\nWHERE opened_at >= '${from}'`];
      if (fields.side && fields.side !== "all") lines.push(`  AND side = '${fields.side}'`);
      lines.push("ORDER BY opened_at DESC\nLIMIT 200;");
      return lines.join("\n");
    }
    case "symbol": {
      const raw = (fields.symbol || "").trim().toUpperCase();
      const sym = raw && !raw.includes(".BK") ? raw + ".BK" : (raw || "SYMBOL");
      const lines = [`SELECT * FROM trades\nWHERE symbol = '${sym}'`];
      if (fields.side && fields.side !== "all") lines.push(`  AND side = '${fields.side}'`);
      lines.push("ORDER BY opened_at DESC\nLIMIT 200;");
      return lines.join("\n");
    }
    case "ghost":
      return "SELECT * FROM trades\nWHERE side = 'buy'\n  AND (exit_price IS NULL OR closed_at IS NULL)\nORDER BY opened_at DESC\nLIMIT 200;";
    case "executor": {
      const where =
        fields.executor === "preset"  ? "WHERE strategy != 'manual'\n  AND strategy NOT LIKE 'ai_%'"
        : fields.executor === "ai"    ? "WHERE strategy LIKE 'ai_%'\n   OR strategy = 'ai_workflow'"
        : fields.executor === "manual" ? "WHERE strategy = 'manual'"
        :                               "WHERE 1=1 -- all executors";
      return `SELECT * FROM trades\n${where}\nORDER BY opened_at DESC\nLIMIT 200;`;
    }
    case "trash":
      return "SELECT * FROM trades\nWHERE symbol IS NULL\n   OR market IS NULL\n   OR qty IS NULL\n   OR entry_price IS NULL\n   OR opened_at IS NULL\nORDER BY opened_at DESC\nLIMIT 200;";
    case "summary": {
      const grp =
        fields.group === "week"  ? "strftime('%Y-W%W', closed_at)"
        : fields.group === "month" ? "strftime('%Y-%m', closed_at)"
        :                            "DATE(closed_at)";
      return [
        `SELECT ${grp} as period,`,
        "       COUNT(*) as trades,",
        "       ROUND(SUM(pnl), 2) as total_pnl,",
        "       SUM(CASE WHEN pnl > 0  THEN 1 ELSE 0 END) as wins,",
        "       SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses",
        "FROM trades",
        "WHERE side = 'sell' AND pnl IS NOT NULL",
        `GROUP BY ${grp}`,
        "ORDER BY period DESC LIMIT 90;",
      ].join("\n");
    }
    case "actlog": {
      const lines = [`SELECT * FROM activity_log\nWHERE created_at >= '${from}'`];
      if (fields.type && fields.type !== "all") lines.push(`  AND type = '${fields.type}'`);
      lines.push("ORDER BY created_at DESC\nLIMIT 200;");
      return lines.join("\n");
    }
    case "dbcount":
      return [
        "SELECT COUNT(*) as total_trades,",
        "       COUNT(CASE WHEN side = 'buy'  THEN 1 END) as buys,",
        "       COUNT(CASE WHEN side = 'sell' THEN 1 END) as sells,",
        "       COUNT(CASE WHEN side = 'buy' AND exit_price IS NULL THEN 1 END) as open_buys",
        "FROM trades;",
      ].join("\n");
    case "reset_sql":
      return [
        "-- ⚠️  WARNING: This permanently deletes ALL trade records",
        "-- Run ONLY in Cloudflare D1 console after full confirmation",
        "DELETE FROM trades;",
        "DELETE FROM activity_log;",
        "-- Verify: SELECT COUNT(*) FROM trades;",
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
  if (queryId === "summary")  return SUMMARY_COLS;
  if (queryId === "actlog")   return ACTLOG_COLS;
  if (queryId === "dbcount")  return DBCOUNT_COLS;
  return [];
}

function getRowClass(queryId, row) {
  if (queryId === "ghost") return "d1-row--ghost";
  if (row.pnl != null && row.pnl > 0) return "d1-row--win";
  if (row.pnl != null && row.pnl < 0) return "d1-row--loss";
  if (!row.exit_price && row.side === "buy") return "d1-row--ghost";
  return "";
}

// ── Field renderers ───────────────────────────────────────────────────────────
function QueryFields({ queryId, fields, onChange }) {
  const set = (k, v) => onChange({ ...fields, [k]: v });

  switch (queryId) {
    case "recent":
      return (
        <div className="d1-fields">
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
        </div>
      );
    case "symbol":
      return (
        <div className="d1-fields">
          <div className="d1-field">
            <label>Symbol</label>
            <input
              type="text"
              value={fields.symbol}
              onChange={e => set("symbol", e.target.value)}
              placeholder="e.g. GULF or GULF.BK"
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
        </div>
      );
    case "executor":
      return (
        <div className="d1-fields">
          <div className="d1-field">
            <label>Executor</label>
            <select value={fields.executor} onChange={e => set("executor", e.target.value)}>
              <option value="all">All</option>
              <option value="manual">Manual</option>
              <option value="preset">Preset Strategy</option>
              <option value="ai">AI Workflow</option>
            </select>
          </div>
        </div>
      );
    case "summary":
      return (
        <div className="d1-fields">
          <div className="d1-field">
            <label>Group by</label>
            <select value={fields.group} onChange={e => set("group", e.target.value)}>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </div>
        </div>
      );
    case "actlog":
      return (
        <div className="d1-fields">
          <div className="d1-field">
            <label>Period</label>
            <select value={fields.period} onChange={e => set("period", e.target.value)}>
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
            </select>
          </div>
          <div className="d1-field">
            <label>Type</label>
            <select value={fields.type} onChange={e => set("type", e.target.value)}>
              <option value="all">All</option>
              <option value="buy">buy</option>
              <option value="sell">sell</option>
              <option value="block">block</option>
              <option value="strategy">strategy</option>
            </select>
          </div>
        </div>
      );
    default:
      return null;
  }
}

// ── Copy helper ───────────────────────────────────────────────────────────────
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

// ── Main component ────────────────────────────────────────────────────────────
export default function D1Tab() {
  const [selectedQuery, setSelectedQuery] = useState(null);
  const [fields,        setFields]        = useState({});
  const [rows,          setRows]          = useState(null);
  const [loading,       setLoading]       = useState(false);
  const [fetchError,    setFetchError]    = useState(null);
  const [lastFetchUrl,  setLastFetchUrl]  = useState("");
  const [generatedSQL,  setGeneratedSQL]  = useState("");

  const [copiedSQL, copySQL] = useCopy();
  const [copiedURL, copyURL] = useCopy();

  const selectQuery = useCallback((id) => {
    setSelectedQuery(id);
    setFields(DEFAULT_FIELDS[id] || {});
    setRows(null);
    setFetchError(null);
    setLastFetchUrl("");
    setGeneratedSQL("");
  }, []);

  const handleRun = useCallback(async () => {
    if (!selectedQuery) return;
    const query = QUERIES.find(q => q.id === selectedQuery);

    if (query.mode === "sql") {
      setGeneratedSQL(buildEquivalentSQL(selectedQuery, fields));
      return;
    }

    setLoading(true);
    setFetchError(null);
    setRows(null);
    setLastFetchUrl("");
    try {
      const result = await fetchQuery(selectedQuery, fields);
      setRows(result.rows);
      setLastFetchUrl(result.fetchUrl || "");
      if (result.error) setFetchError(result.error);
    } catch (err) {
      setFetchError(err.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [selectedQuery, fields]);

  const query     = QUERIES.find(q => q.id === selectedQuery);
  const isSQLMode = query?.mode === "sql";
  const cols      = selectedQuery ? getColumns(selectedQuery) : [];
  const equivSQL  = rows !== null ? buildEquivalentSQL(selectedQuery, fields) : "";
  const relUrl    = lastFetchUrl ? lastFetchUrl.replace(WORKER, "") : "";

  return (
    <div className="d1-tab">

      <div className="d1-header">
        <h2>🗄 D1 Query Builder</h2>
        <p>READ queries fetch live data from D1. Each result shows the API call + equivalent SQL so you can learn and copy for manual use. The ⚠️ query generates DELETE SQL only — never executes.</p>
      </div>

      {/* ── 9-button picker grid ── */}
      <div className="d1-query-grid">
        {QUERIES.map(q => (
          <button
            key={q.id}
            className={`d1-query-btn ${selectedQuery === q.id ? "active" : ""} ${q.mode === "sql" ? "d1-query-btn--sql" : ""}`}
            onClick={() => selectQuery(q.id)}
          >
            <div>{q.icon}</div>
            <div>{q.label}</div>
          </button>
        ))}
      </div>

      {/* ── Selected query: desc + fields + run/generate button ── */}
      {selectedQuery && (
        <div className="d1-query-panel">
          <div className="d1-query-title">{query?.icon} {query?.label}</div>
          {QUERY_DESCS[selectedQuery] && (
            <div className="d1-query-desc">{QUERY_DESCS[selectedQuery]}</div>
          )}
          <QueryFields queryId={selectedQuery} fields={fields} onChange={setFields} />
          <button className="d1-generate-btn" onClick={handleRun}>
            {isSQLMode ? "Generate SQL" : "Fetch Results"}
          </button>
        </div>
      )}

      {/* ── SQL mode: warning banner + SQL output ── */}
      {isSQLMode && generatedSQL && (
        <>
          <div className="d1-warning-banner">
            ⚠️ This SQL permanently deletes all data. Copy and paste in Cloudflare D1 console only — never paste here.
          </div>
          <div className="d1-output">
            <div className="d1-output-label">Generated SQL</div>
            <pre className="d1-sql-block">{generatedSQL}</pre>
            <button className={`d1-copy-btn ${copiedSQL ? "success" : ""}`} onClick={() => copySQL(generatedSQL)}>
              {copiedSQL ? "Copied ✓" : "Copy to clipboard"}
            </button>
          </div>
        </>
      )}

      {/* ── READ mode: loading spinner ── */}
      {!isSQLMode && loading && (
        <div className="d1-loading">⏳ Fetching from D1...</div>
      )}

      {/* ── READ mode: error ── */}
      {!isSQLMode && fetchError && (
        <div className="d1-error">⚠ {fetchError}</div>
      )}

      {/* ── READ mode: results table + under the hood ── */}
      {!isSQLMode && rows !== null && !loading && (
        <>
          <div className="d1-results-section">
            <div className="d1-results-header">
              <span className="d1-results-count">
                {rows.length} record{rows.length !== 1 ? "s" : ""} found
              </span>
              <span>{query?.label}</span>
            </div>

            {rows.length === 0 ? (
              <div className="d1-empty">No records found for this query.</div>
            ) : (
              <div className="d1-table-wrap">
                <table className="d1-table">
                  <thead>
                    <tr>{cols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
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
          </div>

          {/* ── Under the hood — always shown after every fetch ── */}
          <div className="d1-under-hood">
            <div className="d1-under-hood-title">🔍 How this was fetched</div>

            <div className="d1-under-hood-block">
              <div className="d1-under-hood-label">Worker API call (GET)</div>
              <div className="d1-url-row">
                <code className="d1-url-code">{relUrl}</code>
                <button
                  className={`d1-copy-btn d1-copy-btn--sm ${copiedURL ? "success" : ""}`}
                  onClick={() => copyURL(lastFetchUrl)}
                >
                  {copiedURL ? "Copied ✓" : "Copy URL"}
                </button>
              </div>
            </div>

            <div className="d1-under-hood-block">
              <div className="d1-under-hood-label">Equivalent D1 SQL</div>
              <pre className="d1-sql-block d1-sql-block--sm">{equivSQL}</pre>
              <button
                className={`d1-copy-btn d1-copy-btn--sm ${copiedSQL ? "success" : ""}`}
                onClick={() => copySQL(equivSQL)}
              >
                {copiedSQL ? "Copied ✓" : "Copy SQL"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Instructions (always visible) ── */}
      <div className="d1-instructions">
        <div className="d1-instructions-title">How to run SQL manually in Cloudflare</div>
        <ol>
          <li>Go to <code>dash.cloudflare.com</code> → <code>Workers &amp; Pages</code> → <code>D1</code></li>
          <li>Open database <code>tts-db</code> → click the <code>Console</code> tab</li>
          <li>Paste the SQL from "Equivalent D1 SQL" above → click <code>Run</code></li>
        </ol>
      </div>

    </div>
  );
}
